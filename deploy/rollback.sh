#!/usr/bin/env bash
# Return to the previous release (or a named one) without touching data.
#
#   deploy/rollback.sh [/srv/sportozen/releases/<release-id>]
#
# This switches code only. If a bad release changed or damaged data, do NOT use
# this; restore from a verified backup (docs/BACKUP_AND_RECOVERY.md).
set -euo pipefail

ROOT=${SPORTOZEN_ROOT:-/srv/sportozen}
SYSTEMCTL=${SPORTOZEN_SYSTEMCTL:-systemctl}
CURL=${SPORTOZEN_CURL:-curl}
READY_URL=${SPORTOZEN_READY_URL:-http://127.0.0.1:3000/api/ready}
READY_TIMEOUT=${SPORTOZEN_READY_TIMEOUT:-60}
read -r -a SERVICES <<< "${SPORTOZEN_SERVICES:-sportozen-web sportozen-worker}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
# One JSON line per deployment event, appended to $ROOT/deployments.log, so
# "what was deployed, when, and did it roll back" is answerable from the server
# (scripts/ops-check.mjs reads it; docs/OPERATIONS.md). Values are release
# directory names and fixed words, never secrets.
DEPLOY_LOG=${SPORTOZEN_DEPLOY_LOG:-$ROOT/deployments.log}
# For deploy.rolled_back and deploy.failed, "release" is the release that is
# live (or meant to be) after the event and "previous" is the one it replaced.
event() { # event <name> <release> [previous]
  local r p
  # Directory names only, reduced to characters that are safe inside JSON.
  r=$(basename -- "${2:-}" | tr -cd 'A-Za-z0-9._-'); p=$(basename -- "${3:-}" | tr -cd 'A-Za-z0-9._-')
  printf '{"ts":"%s","event":"%s","release":"%s","previous":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$r" "$p" >> "$DEPLOY_LOG" 2> /dev/null || true
}
die() { log "ERROR: $*"; exit 1; }

if [ $# -ge 1 ]; then TARGET=$(cd "$1" && pwd -P); else TARGET=$(readlink -f "$ROOT/previous" 2> /dev/null || true); fi
[ -n "$TARGET" ] && [ -d "$TARGET" ] || die "no previous release recorded; name the release directory"
case "$TARGET" in "$ROOT"/releases/*) ;; *) die "$TARGET is not inside $ROOT/releases" ;; esac
[ -f "$TARGET/.next/BUILD_ID" ] || die "$TARGET has no production build"
CURRENT=$(readlink -f "$ROOT/current" 2> /dev/null || true)
[ "$TARGET" != "$CURRENT" ] || die "$TARGET is already the current release"

log "rolling back $CURRENT -> $TARGET"
event rollback.started "$TARGET" "$CURRENT"
ln -sfn "$TARGET" "$ROOT/current.new"
mv -T "$ROOT/current.new" "$ROOT/current"
[ -n "$CURRENT" ] && ln -sfn "$CURRENT" "$ROOT/previous"
for service in "${SERVICES[@]}"; do
  if [ "$service" = sportozen-web ] \
    || "$SYSTEMCTL" is-enabled --quiet "$service" 2> /dev/null \
    || "$SYSTEMCTL" is-active --quiet "$service" 2> /dev/null; then
    "$SYSTEMCTL" reset-failed "$service" 2> /dev/null || true # a start-limit-hit unit refuses restart
    "$SYSTEMCTL" restart "$service" || log "WARNING: $service did not restart cleanly; checking readiness"
  fi
done
deadline=$((SECONDS + READY_TIMEOUT))
until "$CURL" --fail --silent --show-error --max-time 5 "$READY_URL" > /dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || { event rollback.not_ready "$TARGET" "$CURRENT"; die "rolled back but the service is not ready; see docs/DEPLOYMENT.md, section Recovery"; }
  sleep 2
done
event rollback.succeeded "$TARGET" "$CURRENT"
log "ready: $TARGET is live"
