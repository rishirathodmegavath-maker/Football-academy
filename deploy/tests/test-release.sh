#!/usr/bin/env bash
# Exercises deploy/release.sh and deploy/rollback.sh against a throwaway
# directory tree with stubbed systemctl, curl and node. Needs Linux (symlink
# semantics). Prints one line per case and exits 1 on the first failure.
#   bash deploy/tests/test-release.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RELEASE="$HERE/../release.sh"
ROLLBACK="$HERE/../rollback.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export SPORTOZEN_ROOT="$WORK/srv"
export SPORTOZEN_ENV_FILE="$WORK/sportozen.env"
export SPORTOZEN_NODE="$WORK/stub-node"
export SPORTOZEN_SYSTEMCTL="$WORK/stub-systemctl"
export SPORTOZEN_CURL="$WORK/stub-curl"
export SPORTOZEN_READY_TIMEOUT=2
export SPORTOZEN_KEEP_RELEASES=2
CALLS="$WORK/calls.log"; : > "$CALLS"
echo "DATABASE=1" > "$SPORTOZEN_ENV_FILE"
DB="$WORK/data/workspaces.sqlite"; mkdir -p "$WORK/data"; : > "$DB"
export FAKE_DATABASE="$DB"

# Stubs: record every call; behaviour is steered by files in $WORK.
cat > "$SPORTOZEN_NODE" <<'EOF'
#!/usr/bin/env bash
echo "node $*" >> "$FAKE_CALLS"
case "$*" in
  *preflight*) [ -f "$FAKE_STATE/preflight-fails" ] && exit 1; exit 0 ;;
  *backup-database*) [ -f "$FAKE_STATE/backup-fails" ] && exit 1; exit 0 ;;
  *"-e"*) printf '%s' "$FAKE_DATABASE" ;;
esac
EOF
cat > "$SPORTOZEN_SYSTEMCTL" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_CALLS"
case "$1" in
  # The worker counts as enabled only when a case switches it on.
  is-enabled|is-active) [ "$2" = "--quiet" ] && [ "$3" = sportozen-worker ] && [ -f "$FAKE_STATE/worker-enabled" ] && exit 0; exit 1 ;;
  restart)
    # Scripted failures: every restart, only the worker's, or only while the
    # CURRENT release carries a file named restart-broken (a release whose unit
    # will not start), so the previous release can still restart cleanly.
    [ -f "$FAKE_STATE/restart-fails-always" ] && exit 1
    # The worker will not start on a release that carries worker-broken.
    [ "$2" = sportozen-worker ] && [ -f "$FAKE_ROOT/current/worker-broken" ] && exit 1
    [ -f "$FAKE_ROOT/current/restart-broken" ] && exit 1
    ;;
esac
exit 0
EOF
cat > "$SPORTOZEN_CURL" <<'EOF'
#!/usr/bin/env bash
# Ready only if the CURRENT release carries a file named "healthy".
if [ -f "$FAKE_ROOT/current/healthy" ]; then exit 0; fi
exit 22
EOF
chmod +x "$SPORTOZEN_NODE" "$SPORTOZEN_SYSTEMCTL" "$SPORTOZEN_CURL"
export FAKE_CALLS="$CALLS" FAKE_STATE="$WORK/state" FAKE_ROOT="$SPORTOZEN_ROOT"
mkdir -p "$FAKE_STATE" "$SPORTOZEN_ROOT/releases"

mkrelease() { # name healthy|broken [restart-broken|worker-broken]
  local dir="$SPORTOZEN_ROOT/releases/$1"
  mkdir -p "$dir/.next" "$dir/scripts"; echo "$1" > "$dir/.next/BUILD_ID"
  [ "$2" = healthy ] && : > "$dir/healthy"
  [ "${3:-}" = restart-broken ] && : > "$dir/restart-broken"
  [ "${3:-}" = worker-broken ] && : > "$dir/worker-broken"
  sleep 1 # distinct modification times for the pruning order
}
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
current() { basename "$(readlink -f "$SPORTOZEN_ROOT/current")"; }

mkrelease r1 healthy; mkrelease r2 healthy; mkrelease r3 broken; mkrelease r4 healthy; mkrelease r5 healthy

# 1. First release: no previous, no running service to compare against.
"$RELEASE" "$SPORTOZEN_ROOT/releases/r1" > "$WORK/out1" 2>&1
expect "first release goes live" '[ "$(current)" = r1 ]'
expect "pre-deploy backup ran when a database existed" 'grep -q "backup-database.mjs --label pre-deploy" "$CALLS"'
expect "web service restarted" 'grep -q "systemctl restart sportozen-web" "$CALLS"'
expect "a start-limit-hit unit is cleared before it is restarted" 'a=$(grep -n "systemctl reset-failed sportozen-web" "$CALLS" | head -1 | cut -d: -f1); b=$(grep -n "systemctl restart sportozen-web" "$CALLS" | head -1 | cut -d: -f1); [ -n "$a" ] && [ "$a" -lt "$b" ]'
expect "worker not restarted while disabled" '! grep -q "restart sportozen-worker" "$CALLS"'

# 2. Second healthy release.
"$RELEASE" "$SPORTOZEN_ROOT/releases/r2" > "$WORK/out2" 2>&1
expect "second release goes live" '[ "$(current)" = r2 ]'
expect "previous release is recorded" '[ "$(basename "$(readlink -f "$SPORTOZEN_ROOT/previous")")" = r1 ]'

# 3. A release that never becomes ready is rolled back automatically.
"$RELEASE" "$SPORTOZEN_ROOT/releases/r3" > "$WORK/out3" 2>&1; code=$?
expect "failed release exits non-zero" '[ "$code" -ne 0 ]'
expect "failed release is rolled back to r2" '[ "$(current)" = r2 ]'
expect "after an automatic rollback, previous still points at the release before it (r1), not at the live one" '[ "$(basename "$(readlink -f "$SPORTOZEN_ROOT/previous")")" = r1 ] && [ "$(current)" = r2 ]'
expect "rollback message names what was not reverted" 'grep -q "pre-deploy backup was not restored" "$WORK/out3"'
LOGFILE="$SPORTOZEN_ROOT/deployments.log"
expect "deployment events are recorded as JSON lines" 'grep -q "\"event\":\"deploy.succeeded\",\"release\":\"r2\",\"previous\":\"r1\"" "$LOGFILE"'
expect "a release that was not ready and rolled back is recorded" 'grep -q "\"event\":\"deploy.not_ready\",\"release\":\"r3\"" "$LOGFILE" && grep -q "\"event\":\"deploy.rolled_back\",\"release\":\"r2\",\"previous\":\"r3\"" "$LOGFILE"'

# 4. A failing preflight changes nothing.
touch "$FAKE_STATE/preflight-fails"
: > "$CALLS"
"$RELEASE" "$SPORTOZEN_ROOT/releases/r4" > "$WORK/out4" 2>&1; code=$?
expect "failing preflight aborts" '[ "$code" -ne 0 ] && [ "$(current)" = r2 ]'
expect "failing preflight restarts nothing" '! grep -q "systemctl restart" "$CALLS"'
expect "a refused deployment (failing preflight) is recorded" 'tail -1 "$LOGFILE" | grep -q "\"event\":\"deploy.aborted\",\"release\":\"r4\""'
rm "$FAKE_STATE/preflight-fails"

# 5. A failing pre-deploy backup changes nothing.
touch "$FAKE_STATE/backup-fails"
"$RELEASE" "$SPORTOZEN_ROOT/releases/r4" > "$WORK/out5" 2>&1; code=$?
expect "failing backup aborts" '[ "$code" -ne 0 ] && [ "$(current)" = r2 ]'
expect "a refused deployment (failing backup) is recorded" 'tail -1 "$LOGFILE" | grep -q "\"event\":\"deploy.aborted\""'
rm "$FAKE_STATE/backup-fails"

# 6. Refuses directories outside releases/ and releases without a build.
mkdir -p "$WORK/elsewhere/.next"; echo x > "$WORK/elsewhere/.next/BUILD_ID"
"$RELEASE" "$WORK/elsewhere" > "$WORK/out6" 2>&1; code=$?
expect "release outside releases/ is refused" '[ "$code" -ne 0 ] && [ "$(current)" = r2 ]'
mkdir -p "$SPORTOZEN_ROOT/releases/empty"
"$RELEASE" "$SPORTOZEN_ROOT/releases/empty" > "$WORK/out7" 2>&1; code=$?
expect "release without a build is refused" '[ "$code" -ne 0 ] && [ "$(current)" = r2 ]'

# 7. Manual rollback, then refusing a no-op.
"$RELEASE" "$SPORTOZEN_ROOT/releases/r4" > "$WORK/out8" 2>&1
expect "r4 goes live" '[ "$(current)" = r4 ]'
"$ROLLBACK" > "$WORK/out9" 2>&1
expect "rollback returns to the previous release (r2)" '[ "$(current)" = r2 ]'
expect "rollback clears a start-limit-hit unit first" 'tail -20 "$CALLS" | grep -q "systemctl reset-failed sportozen-web"'
"$ROLLBACK" "$SPORTOZEN_ROOT/releases/r2" > "$WORK/out10" 2>&1; code=$?
expect "rollback to the current release is refused" '[ "$code" -ne 0 ]'
expect "a manual rollback is recorded" 'grep -q "\"event\":\"rollback.succeeded\",\"release\":\"r2\",\"previous\":\"r4\"" "$LOGFILE"'
expect "every logged line is valid JSON with no secret" 'while read -r line; do printf "%s" "$line" | python3 -c "import json,sys; json.loads(sys.stdin.read())" || exit 1; done < "$LOGFILE"'

# 8. Pruning keeps the newest, the current and the previous release.
"$RELEASE" "$SPORTOZEN_ROOT/releases/r5" > "$WORK/out11" 2>&1
expect "current release survives pruning" '[ -d "$SPORTOZEN_ROOT/releases/r5" ]'
expect "previous release survives pruning" '[ -d "$SPORTOZEN_ROOT/releases/r2" ]'
expect "old releases are pruned" '[ ! -d "$SPORTOZEN_ROOT/releases/r1" ]'

# 8b. A hostile release directory name cannot break the event log's JSON.
HOSTILE="$SPORTOZEN_ROOT/releases/r\"x\y"
mkrelease 'r"x\y' healthy
"$RELEASE" "$HOSTILE" > "$WORK/out13" 2>&1
expect "events stay valid JSON for an awkward release name" 'while read -r line; do printf "%s" "$line" | python3 -c "import json,sys; json.loads(sys.stdin.read())" || exit 1; done < "$LOGFILE"'

# 9. Secrets never reach the output.
echo "BETTER_AUTH_SECRET=do-not-print-this-value" >> "$SPORTOZEN_ENV_FILE"
"$RELEASE" "$SPORTOZEN_ROOT/releases/r4" > "$WORK/out12" 2>&1
expect "no secret in release output" '! grep -rq "do-not-print-this-value" "$WORK"/out*'

# 10. A service that fails to RESTART must never be reported as a successful
# deployment, even when something old still answers the readiness probe (here:
# the release is marked healthy, so readiness alone would pass). Review finding
# WP8 (a): the failed restart used to be ignored once the probe passed.
mkrelease r6 healthy restart-broken
: > "$CALLS"
"$RELEASE" "$SPORTOZEN_ROOT/releases/r6" > "$WORK/out14" 2>&1; code=$?
live=$(current)
logged=$(printf "%s" "$live" | tr -cd 'A-Za-z0-9._-') # the event log keeps only these characters
expect "a failed web restart fails the deployment" '[ "$code" -ne 0 ]'
expect "a failed web restart is rolled back to the release that was live" '[ "$live" != r6 ] && [ -f "$SPORTOZEN_ROOT/current/healthy" ]'
expect "the failed restart is named in the output" 'grep -q "restart of sportozen-web failed" "$WORK/out14"'
expect "the rollback is recorded" 'grep -q "\"event\":\"deploy.rolled_back\",\"release\":\"$logged\",\"previous\":\"r6\"" "$LOGFILE"'
expect "no success is recorded for the release whose restart failed" '! grep -q "\"event\":\"deploy.succeeded\",\"release\":\"r6\"" "$LOGFILE"'
expect "a restart failure goes straight to the rollback instead of waiting for readiness" '! grep -q "NOT READY after" "$WORK/out14"'
expect "after that rollback, previous is not the live release" '[ "$(basename "$(readlink -f "$SPORTOZEN_ROOT/previous")")" != "$live" ]'

# 10b. The optional worker: if it is enabled and will not restart on the NEW
# release, the release is not live even though the web service is ready, and the
# rollback (where the worker restarts fine) completes.
mkrelease r7 healthy worker-broken
touch "$FAKE_STATE/worker-enabled"
before=$(current)
"$RELEASE" "$SPORTOZEN_ROOT/releases/r7" > "$WORK/out15" 2>&1; code=$?
expect "a failed worker restart fails the deployment" '[ "$code" -ne 0 ]'
expect "and it is rolled back (the worker restarts on the old release)" '[ "$(current)" = "$before" ] && grep -q "rolled back to" "$WORK/out15"'
expect "the failed worker restart is named" 'grep -q "restart of sportozen-worker failed" "$WORK/out15"'
mkrelease r7b healthy
"$RELEASE" "$SPORTOZEN_ROOT/releases/r7b" > "$WORK/out16" 2>&1
expect "with a release whose worker restarts the deployment goes live" '[ "$(current)" = r7b ]'
rm -f "$FAKE_STATE/worker-enabled"

# 10c. Both the new release AND the rollback fail to restart: reported as failed,
# the live link is the previous release, and previous is not left pointing at it.
mkrelease r8 healthy
touch "$FAKE_STATE/restart-fails-always"
before=$(current)
"$RELEASE" "$SPORTOZEN_ROOT/releases/r8" > "$WORK/out17" 2>&1; code=$?
expect "double restart failure exits non-zero" '[ "$code" -ne 0 ]'
expect "double restart failure is recorded as failed, not rolled back" 'tail -2 "$LOGFILE" | grep -q "\"event\":\"deploy.failed\",\"release\":\"$before\"" && ! tail -1 "$LOGFILE" | grep -q rolled_back'
expect "double restart failure still points the live link at the previous release" '[ "$(current)" = "$before" ]'
expect "double restart failure does not leave previous pointing at the live release" '[ "$(basename "$(readlink -f "$SPORTOZEN_ROOT/previous" 2> /dev/null)")" != "$before" ]'
expect "double restart failure says a service did not restart, not that readiness failed" 'grep -q "did not restart cleanly on the previous release" "$WORK/out17" && ! grep -q "not ready either" "$WORK/out17"'
rm -f "$FAKE_STATE/restart-fails-always"

# 10d. previous must not be left pointing at the release that just failed, even when
# it already pointed there (a release that was deployed, then rolled back by hand).
mkrelease r9 broken
livenow=$(current)
ln -sfn "$SPORTOZEN_ROOT/releases/r9" "$SPORTOZEN_ROOT/previous"
"$RELEASE" "$SPORTOZEN_ROOT/releases/r9" > "$WORK/out18" 2>&1
expect "a failed release is not left as the previous release" '[ "$(basename "$(readlink -f "$SPORTOZEN_ROOT/previous" 2> /dev/null)")" != r9 ] && [ "$(current)" = "$livenow" ]'

[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
