#!/usr/bin/env bash
# Validates deploy/nginx with a real nginx in Docker in front of an echo server
# that stands in for the application. Needs docker, openssl and curl.
#   bash deploy/tests/test-proxy.sh
# Uses a throwaway self-signed certificate for the placeholder name
# app.test.invalid and published ports 18080/18443 on localhost. Nothing leaves
# the machine except pulling the public nginx and node images the first time.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY="$HERE/.."
WORK=$(mktemp -d)
NAME="sportozen-proxy-test-$$"
ECHO="$NAME-echo"
DOMAIN=app.test.invalid
IMAGE_NGINX=${NGINX_IMAGE:-nginx:stable}
IMAGE_NODE=${NODE_IMAGE:-node:24-alpine}
cleanup() { docker rm -f "$NAME" "$ECHO" > /dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1 :: $3"; fi; }

# Docker on Windows needs Windows-style host paths for bind mounts.
hostpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1
# A native (non-MSYS) openssl cannot open /tmp/... paths.
native() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

mkdir -p "$WORK/conf.d" "$WORK/snippets" "$WORK/certs/live/$DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/g" "$DEPLOY/nginx/sportozen.conf.template" > "$WORK/conf.d/sportozen.conf"
cp "$DEPLOY/nginx/sportozen-proxy.conf" "$WORK/snippets/sportozen-proxy.conf"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN" \
  -keyout "$(native "$WORK/certs/live/$DOMAIN/privkey.pem")" -out "$(native "$WORK/certs/live/$DOMAIN/fullchain.pem")" 2> /dev/null
[ -s "$WORK/certs/live/$DOMAIN/fullchain.pem" ] || { echo "could not create the test certificate"; exit 2; }

cat > "$WORK/echo.js" <<'JS'
require("http").createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
}).listen(3000, "127.0.0.1");
JS

MOUNTS=(-v "$(hostpath "$WORK/conf.d/sportozen.conf"):/etc/nginx/conf.d/default.conf:ro"
  -v "$(hostpath "$WORK/snippets"):/etc/nginx/snippets:ro"
  -v "$(hostpath "$WORK/certs"):/etc/letsencrypt:ro")

# 1. Syntax: nginx -t in the real image.
out=$(docker run --rm "${MOUNTS[@]}" "$IMAGE_NGINX" nginx -t 2>&1)
expect "nginx -t accepts the rendered configuration" 'echo "$out" | grep -q "test is successful"' "$out"

# 2. Run nginx, then an echo "application" inside the same network namespace
#    (the template proxies to 127.0.0.1:3000).
docker run -d --name "$NAME" -p 18080:80 -p 18443:443 "${MOUNTS[@]}" "$IMAGE_NGINX" > /dev/null
docker run -d --name "$ECHO" --network "container:$NAME" -v "$(hostpath "$WORK/echo.js"):/echo.js:ro" "$IMAGE_NODE" node /echo.js > /dev/null
sleep 3
CURL=(curl -sk --resolve "$DOMAIN:18443:127.0.0.1" --max-time 10)
body=$("${CURL[@]}" "https://$DOMAIN:18443/some/path?x=1" \
  -H "X-Forwarded-For: 1.2.3.4, 5.6.7.8" -H "X-Real-IP: 8.8.8.8" -H "Forwarded: for=9.9.9.9" -H "X-Forwarded-Proto: http" -H "X-Request-ID: forged-by-the-client")
field() { printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s).headers;console.log(h[process.argv[1]]??"")}catch{console.log("PARSEERROR")}})' "$1" 2> /dev/null; }
FWD=$(field x-forwarded-for); REAL=$(field x-real-ip); PROTO=$(field x-forwarded-proto); FWD2=$(field forwarded); HOST=$(field host)
expect "request reaches the application through TLS" '[ -n "$FWD" ] && [ "$FWD" != PARSEERROR ]' "body=$body"
expect "client X-Forwarded-For is replaced by one address" '! echo "$FWD" | grep -q "[,]" && ! echo "$FWD" | grep -q "1.2.3.4"' "got $FWD"
expect "X-Real-IP equals the real peer, not the client value" '[ "$REAL" = "$FWD" ] && [ "$REAL" != 8.8.8.8 ]' "got $REAL"
expect "client Forwarded header is removed" '[ -z "$FWD2" ]' "got $FWD2"
expect "X-Forwarded-Proto is https" '[ "$PROTO" = https ]' "got $PROTO"
expect "Host is passed through" '[ "$HOST" = "$DOMAIN:18443" ] || [ "$HOST" = "$DOMAIN" ]' "got $HOST"
REQID=$(field x-request-id)
expect "client X-Request-ID is replaced by nginx's own 32-hex id" 'echo "$REQID" | grep -Eq "^[0-9a-f]{32}$" && [ "$REQID" != forged-by-the-client ]' "got $REQID"
expect "the access log line carries that request id and timings" 'docker logs "$NAME" 2>&1 | grep -q "rid=$REQID rt=[0-9.]* urt="' "id=$REQID"

# 3. Redirect, unknown hosts, probes.
code=$(curl -si --resolve "$DOMAIN:18080:127.0.0.1" --max-time 10 "http://$DOMAIN:18080/x?y=1" | tr -d "\r")
expect "HTTP redirects to HTTPS" 'echo "$code" | head -1 | grep -q " 301 " && echo "$code" | grep -qi "^location: https://$DOMAIN/x?y=1$"' "got $code"
unknown=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: other.invalid" http://127.0.0.1:18080/ 2> /dev/null)
expect "unknown host on HTTP gets no answer (444)" '[ "$unknown" = 000 ]' "got $unknown"
sni=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "other.invalid:18443:127.0.0.1" https://other.invalid:18443/ 2> /dev/null)
expect "unknown host on HTTPS is rejected at the handshake" '[ "$sni" = 000 ]' "got $sni"
ready=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN:18443/api/ready")
expect "/api/ready is not reachable from outside the server" '[ "$ready" = 403 ]' "got $ready"
health=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN:18443/api/health")
expect "/api/health is reachable" '[ "$health" = 200 ]' "got $health"
hdr=$("${CURL[@]}" -D - -o /dev/null "https://$DOMAIN:18443/")
expect "server version is not disclosed" '! echo "$hdr" | grep -qi "^server: nginx/"' "$hdr"

# 4. Edge limits and body cap.
codes=""; for i in $(seq 1 40); do codes="$codes $("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$DOMAIN:18443/api/auth/sign-in/email")"; done
expect "sign-in endpoint is rate limited at the edge (429 appears)" 'echo "$codes" | grep -q 429' "codes=$codes"
expect "the first requests still pass (burst)" 'echo "$codes" | cut -d" " -f2-6 | grep -q 200' "codes=$codes"
sleep 1
big=$(head -c 3000000 /dev/zero | tr '\0' 'a' | "${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST --data-binary @- "https://$DOMAIN:18443/api/health")
expect "a 3 MB body is refused (413)" '[ "$big" = 413 ]' "got $big"

[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
