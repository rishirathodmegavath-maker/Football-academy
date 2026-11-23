#!/usr/bin/env bash
# Switch the service to a new, already built release and roll back
# automatically if it does not become ready.
#
#   deploy/release.sh /srv/sportozen/releases/<release-id>
#
# The release directory must contain the production build (.next) and its
# node_modules. Nothing here builds, downloads or edits application data. The
# database lives outside the release directory (SPORTOZEN_DATABASE_PATH).
#
# Overridable for testing: SPORTOZEN_ROOT, SPORTOZEN_ENV_FILE, SPORTOZEN_NODE,
# SPORTOZEN_SYSTEMCTL, SPORTOZEN_CURL, SPORTOZEN_READY_URL,
# SPORTOZEN_READY_TIMEOUT, SPORTOZEN_KEEP_RELEASES, SPORTOZEN_SERVICES.
set -euo pipefail

ROOT=${SPORTOZEN_ROOT:-/srv/sportozen}
ENV_FILE=${SPORTOZEN_ENV_FILE:-/etc/sportozen/sportozen.env}
NODE=${SPORTOZEN_NODE:-node}
SYSTEMCTL=${SPORTOZEN_SYSTEMCTL:-systemctl}
CURL=${SPORTOZEN_CURL:-curl}
READY_URL=${SPORTOZEN_READY_URL:-http://127.0.0.1:3000/api/ready}
READY_TIMEOUT=${SPORTOZEN_READY_TIMEOUT:-60}
KEEP=${SPORTOZEN_KEEP_RELEASES:-5}
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

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT))
  until "$CURL" --fail --silent --show-error --max-time 5 "$READY_URL" > /dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}
switch_to() { # atomic symlink replacement
  ln -sfn "$1" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
}
# Restarts every unit, never stopping at the first failure, and returns non-zero
# if ANY restart failed. (Called inside `||`, so `set -e` is off in here: the
# status of the last command alone would hide an earlier failure.) A unit that
# did not restart is not running this release, even when something older still
# answers the readiness probe.
restart_services() {
  local failed=0
  for service in "${SERVICES[@]}"; do
    # The worker is optional: only restart units that are enabled or running.
    if [ "$service" = sportozen-web ] \
      || "$SYSTEMCTL" is-enabled --quiet "$service" 2> /dev/null \
      || "$SYSTEMCTL" is-active --quiet "$service" 2> /dev/null; then
      # A crash-looping unit that hit systemd's start limit refuses a restart
      # until the failed state is cleared; a release or rollback is exactly the
      # moment to clear it.
      "$SYSTEMCTL" reset-failed "$service" 2> /dev/null || true
      "$SYSTEMCTL" restart "$service" || { log "restart of $service failed"; failed=1; }
    fi
  done
  return "$failed"
}

[ $# -eq 1 ] || die "usage: release.sh <release-directory>"
NEW=$(cd "$1" && pwd -P)
case "$NEW" in "$ROOT"/releases/*) ;; *) die "$NEW is not inside $ROOT/releases" ;; esac
[ -f "$NEW/.next/BUILD_ID" ] || die "$NEW has no production build (.next/BUILD_ID)"
[ -f "$ENV_FILE" ] || die "environment file $ENV_FILE not found"

log "1/5 preflight (configuration and build artifact)"
(cd "$NEW" && "$NODE" --env-file="$ENV_FILE" scripts/preflight.mjs --artifact) || { event deploy.aborted "$NEW" ""; die "preflight failed; nothing was changed"; }

log "2/5 pre-deploy database backup"
DATABASE=$("$NODE" --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.SPORTOZEN_DATABASE_PATH||"")')
if [ -n "$DATABASE" ] && [ -f "$DATABASE" ]; then
  (cd "$NEW" && "$NODE" --env-file="$ENV_FILE" scripts/backup-database.mjs --label pre-deploy) \
    || { event deploy.aborted "$NEW" ""; die "pre-deploy backup failed; nothing was changed"; }
else
  log "no database yet at the configured path; first deployment, backup skipped"
fi

PREVIOUS=""
[ -L "$ROOT/current" ] && PREVIOUS=$(readlink -f "$ROOT/current")
# What "previous" pointed to before this attempt, to put back if we roll back.
OLD_PREVIOUS=""
[ -L "$ROOT/previous" ] && OLD_PREVIOUS=$(readlink -f "$ROOT/previous")
if [ "$PREVIOUS" = "$NEW" ]; then die "$NEW is already the current release"; fi

log "3/5 switching to $NEW"
event deploy.started "$NEW" "$PREVIOUS"
switch_to "$NEW"
[ -n "$PREVIOUS" ] && ln -sfn "$PREVIOUS" "$ROOT/previous"

log "4/5 restarting services"
# A unit that fails to start (preflight, start limit) must lead to the readiness
# wait and the automatic rollback below, not abort the script here.
RESTARTED=1
restart_services || RESTARTED=0
# A restart that failed means this release is not what is running: no readiness
# probe can say otherwise (an old process may still be answering), so it goes
# straight to the rollback, without the wait.
if [ "$RESTARTED" -eq 1 ] && wait_ready; then
  log "5/5 ready: $NEW is live"
  event deploy.succeeded "$NEW" "$PREVIOUS"
else
  if [ "$RESTARTED" -eq 0 ]; then log "a service did not restart cleanly; $NEW is not live"; else log "NOT READY after ${READY_TIMEOUT}s"; fi
  event deploy.not_ready "$NEW" "$PREVIOUS"
  if [ -n "$PREVIOUS" ]; then
    log "rolling back to $PREVIOUS"
    switch_to "$PREVIOUS"
    # The old release is current again: "previous" must not point at the release
    # that is now current (whether or not it comes up), or an argument-less
    # rollback.sh would refuse.
    # (Not at the release that just failed either, if that is what it pointed to.)
    if [ -n "$OLD_PREVIOUS" ] && [ "$OLD_PREVIOUS" != "$PREVIOUS" ] && [ "$OLD_PREVIOUS" != "$NEW" ]; then ln -sfn "$OLD_PREVIOUS" "$ROOT/previous"; else rm -f "$ROOT/previous"; fi
    RESTARTED=1
    restart_services || { RESTARTED=0; log "a service did not restart cleanly on the previous release"; }
    if [ "$RESTARTED" -eq 1 ] && wait_ready; then
      event deploy.rolled_back "$PREVIOUS" "$NEW"
      die "release failed and was rolled back to $PREVIOUS. Migrations are additive and were not reverted; the pre-deploy backup was not restored."
    fi
    event deploy.failed "$PREVIOUS" "$NEW"
    if [ "$RESTARTED" -eq 0 ]; then
      die "release failed AND a service did not restart cleanly on the previous release. Follow docs/DEPLOYMENT.md, section Recovery."
    fi
    die "release failed AND the previous release is not ready either. Follow docs/DEPLOYMENT.md, section Recovery."
  fi
  event deploy.failed "$NEW" ""
  die "first release did not become ready; inspect the service logs"
fi

# Prune only releases OLDER than the one now live (a staged, not yet deployed
# release is never touched). Keep the current and previous releases and the most
# recent older ones, up to SPORTOZEN_KEEP_RELEASES in total.
CURRENT=$(readlink -f "$ROOT/current")
PREV=$(readlink -f "$ROOT/previous" 2> /dev/null || true)
kept=1
# shellcheck disable=SC2012
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if [ "$(readlink -f "$old")" = "$PREV" ] || [ "$kept" -lt "$KEEP" ]; then
    kept=$((kept + 1))
    continue
  fi
  log "removing old release $old"
  rm -rf -- "$old"
done < <(ls -1dt "$ROOT"/releases/*/ 2> /dev/null | sed 's#/$##' | awk -v current="$CURRENT" 'f { print } $0 == current { f = 1 }')
