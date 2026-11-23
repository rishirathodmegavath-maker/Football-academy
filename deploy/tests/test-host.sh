#!/usr/bin/env bash
# Checks the host-hardening templates in deploy/host/ as far as a workstation
# can: nftables syntax and the apply script's guards, sshd configuration syntax
# and the fail2ban filter against sample nginx log lines. Needs Linux with
# nftables, openssh-server and fail2ban installed (apt install nftables
# openssh-server fail2ban); each check is skipped, and reported as skipped, if
# its tool is missing. Run as root (nft needs it):
#   sudo bash deploy/tests/test-host.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOST="$HERE/../host"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }
skip() { printf 'skip - %s (tool not installed)\n' "$1"; }

if command -v nft > /dev/null; then
  nft -c -f "$HOST/nftables.conf" 2> "$WORK/nft.err" && ok "nftables.conf has valid syntax" || { bad "nftables.conf syntax"; cat "$WORK/nft.err"; }
  "$HOST/apply-firewall.sh" "$HOST/nftables.conf" > "$WORK/apply.out" 2>&1; code=$?
  [ "$code" -ne 0 ] && grep -q "still the placeholder" "$WORK/apply.out" && ok "apply script refuses the placeholder administrator range" || bad "apply script accepted the placeholder"
  sed 's#^define ADMIN_CIDR = .*#define ADMIN_CIDR = 203.0.113.0/24#' "$HOST/nftables.conf" > "$WORK/real.conf"
  nft -c -f "$WORK/real.conf" && ok "a real range is accepted by the syntax check" || bad "real range rejected"
  printf 'table inet x {\n  chain c { oops }\n}\n' > "$WORK/broken.conf"
  sed -i 's#^define ADMIN_CIDR = .*#define ADMIN_CIDR = 203.0.113.0/24#' "$WORK/real.conf"
  "$HOST/apply-firewall.sh" "$WORK/broken.conf" > "$WORK/broken.out" 2>&1; [ $? -ne 0 ] && ok "apply script refuses a file with a syntax error" || bad "apply script accepted a broken file"
else skip "nftables checks"; fi

if command -v sshd > /dev/null; then
  ssh-keygen -A > /dev/null 2>&1; mkdir -p /run/sshd
  sshd -t -f "$HOST/sshd_config.d-sportozen.conf" 2> "$WORK/sshd.err" && ok "sshd configuration is valid" || { bad "sshd configuration"; cat "$WORK/sshd.err"; }
else skip "sshd check"; fi

if command -v fail2ban-regex > /dev/null; then
  cat > "$WORK/access.log" <<'LOG'
203.0.113.7 - - [01/Nov/2026:21:00:00 +0000] "POST /api/auth/sign-in/email HTTP/1.1" 401 85 "-" "curl/8"
203.0.113.7 - - [01/Nov/2026:21:00:01 +0000] "POST /api/auth/sign-in/email HTTP/1.1" 429 70 "-" "curl/8"
203.0.113.8 - - [01/Nov/2026:21:00:02 +0000] "POST /api/auth/two-factor/verify-totp HTTP/2.0" 401 70 "-" "x"
203.0.113.9 - - [01/Nov/2026:21:00:03 +0000] "POST /api/auth/sign-in/email HTTP/1.1" 200 300 "-" "Mozilla"
203.0.113.9 - - [01/Nov/2026:21:00:04 +0000] "GET /api/auth/get-session HTTP/1.1" 401 10 "-" "Mozilla"
203.0.113.9 - - [01/Nov/2026:21:00:05 +0000] "POST /api/workspaces/a/actions HTTP/1.1" 403 10 "-" "Mozilla"
LOG
  fail2ban-regex "$WORK/access.log" "$HOST/fail2ban/sportozen-auth.conf" 2> /dev/null | grep -q "3 matched" \
    && ok "fail2ban filter matches the 3 refused authentication lines and no others" || bad "fail2ban filter"
else skip "fail2ban check"; fi

[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
