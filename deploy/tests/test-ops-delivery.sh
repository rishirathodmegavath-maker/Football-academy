#!/usr/bin/env bash
# The POSIX-only parts of the monitoring fixes (WP8 review (c) and (d)), run on
# real Linux: a hung alert command that ignores SIGTERM is killed together with
# the process it started (process-group kill), and SIGTERM during an alert pass
# releases the lock and exits 143. The cross-platform cases live in
# tests/unit/ops-review-fixes.test.ts; Windows has no process groups or SIGTERM
# handlers, so these two can only be proven here. Needs Node 24:
#   bash deploy/tests/test-ops-delivery.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OPS="$HERE/../../scripts/lib/ops.mjs"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }
command -v node > /dev/null || { echo "node is required"; exit 1; }

cat > "$WORK/hang.cjs" <<'JS'
const fs = require("fs"), { spawn } = require("child_process");
process.on("SIGTERM", () => {}); // ignores the polite request
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2] + ".parent", String(process.pid));
fs.writeFileSync(process.argv[2] + ".child", String(grandchild.pid));
setInterval(() => {}, 1000);
JS

# 1. A command that ignores SIGTERM and starts a child is gone at the deadline.
cat > "$WORK/deliver.mjs" <<JS
import { sendAlert } from "file://$OPS";
const config = { alertCommand: [process.execPath, "$WORK/hang.cjs", "$WORK/h"], alertWebhook: null };
const t = Date.now();
const outcomes = await sendAlert(config, { severity: "CRITICAL", subject: "s", body: "b" }, { commandTimeoutMs: 1500 });
console.log(JSON.stringify({ outcomes, ms: Date.now() - t }));
JS
result=$(node "$WORK/deliver.mjs")
echo "$result" | grep -q '"timedOut":true' && ok "a hung command is reported as timed out" || bad "timed-out outcome ($result)"
ms=$(echo "$result" | sed 's/.*"ms":\([0-9]*\).*/\1/')
[ "${ms:-99999}" -lt 6000 ] && ok "and the run is not held beyond the deadline (${ms} ms)" || bad "run held ${ms} ms"
sleep 1
parent=$(cat "$WORK/h.parent"); child=$(cat "$WORK/h.child")
kill -0 "$parent" 2> /dev/null && bad "the hung command is still running" || ok "the hung command is gone"
kill -0 "$child" 2> /dev/null && { bad "the process it started is still running"; kill -9 "$child" 2> /dev/null; } || ok "the process it started is gone too (process-group kill)"

# 2. SIGTERM during a pass releases the lock and exits 143.
mkdir -p "$WORK/state"
cat > "$WORK/pass.mjs" <<JS
import { runAlertPass } from "file://$OPS";
process.on("exit", (c) => console.log("EXIT " + c)); // fires for process.exit(), never for death by a signal
const config = { stateDir: "$WORK/state", alertCommand: null, alertWebhook: "https://alerts.example.org/hook", serverName: "t" };
const results = [{ name: "x-check", level: "critical", detail: "d", hint: "h" }];
await runAlertPass(config, results, { log: () => {} });             // pass 1 counts
await runAlertPass(config, results, { send: () => { console.log("HOLDING"); setInterval(() => {}, 1000); return new Promise(() => {}); }, log: () => {} });
JS
node "$WORK/pass.mjs" > "$WORK/pass.out" 2>&1 &
pid=$!
for _ in $(seq 1 100); do grep -q HOLDING "$WORK/pass.out" 2> /dev/null && break; sleep 0.1; done
[ -f "$WORK/state/alerts.lock" ] && ok "the lock is held while an alert is being delivered" || bad "no lock while delivering"
kill -TERM "$pid"; wait "$pid"; code=$?
[ "$code" -eq 143 ] && grep -q "^EXIT 143" "$WORK/pass.out" && ok "SIGTERM ends the run with status 143 through our handler (not death by signal)" || bad "exit status $code"
[ ! -f "$WORK/state/alerts.lock" ] && ok "and the lock is released" || bad "the lock was left behind"

# 3. Two processes saving the alert state at the same instant never collide on a
# temporary file (each write uses a name of its own) and the file stays valid.
cat > "$WORK/writer.mjs" <<JS
import { writeState } from "file://$OPS";
import { appendFileSync } from "node:fs";
const [tag, goAt] = process.argv.slice(2);
while (Date.now() < Number(goAt)) {}
let errors = 0;
for (let i = 0; i < 400; i++) { try { writeState({ stateDir: "$WORK/writers" }, { tag, i }); } catch { errors++; } }
appendFileSync("$WORK/writers.out", tag + ":" + errors + "\\n");
JS
goAt=$(node -e 'console.log(Date.now() + 2500)')
node "$WORK/writer.mjs" a "$goAt" & p1=$!
node "$WORK/writer.mjs" b "$goAt" & p2=$!
wait "$p1" "$p2"
[ "$(sort "$WORK/writers.out" | tr '\n' ' ')" = "a:0 b:0 " ] && ok "concurrent state writers: no errors" || bad "writer errors: $(cat "$WORK/writers.out" | tr '\n' ' ')"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$WORK/writers/alerts.json" && ok "and the state file is valid JSON" || bad "state file damaged"

# 4. A lock file nobody can read (left by a crashed root-run pass) is removed, not
# mistaken for "another run is working" forever.
mkdir -p "$WORK/unreadable"
printf 'x' > "$WORK/unreadable/alerts.lock"; chmod 000 "$WORK/unreadable/alerts.lock"
cat > "$WORK/lock.mjs" <<JS
import { acquireAlertLock } from "file://$OPS";
const release = acquireAlertLock({ stateDir: "$WORK/unreadable" });
console.log(release ? "ACQUIRED" : "BUSY");
release?.();
JS
[ "$(node "$WORK/lock.mjs" 2> /dev/null)" = "ACQUIRED" ] && ok "an unreadable leftover lock is cleared and the run proceeds" || bad "an unreadable lock blocks every run"

# 5. SIGTERM during a pass also kills the alert command that is still running
# (here one that ignores SIGTERM and has started a child): nothing is left behind.
mkdir -p "$WORK/state5"
cat > "$WORK/pass5.mjs" <<JS
import { runAlertPass } from "file://$OPS";
process.on("exit", (c) => console.log("EXIT " + c));
const config = { stateDir: "$WORK/state5", alertCommand: [process.execPath, "$WORK/hang.cjs", "$WORK/h5"], alertWebhook: null, alertCommandTimeoutMs: 20000, serverName: "t" };
const results = [{ name: "x-check", level: "critical", detail: "d", hint: "h" }];
await runAlertPass(config, results, { log: () => {} });
console.log("DELIVERING");
await runAlertPass(config, results, { log: () => {} });
JS
node "$WORK/pass5.mjs" > "$WORK/pass5.out" 2>&1 &
pid=$!
for _ in $(seq 1 100); do [ -f "$WORK/h5.child" ] && break; sleep 0.1; done
kill -TERM "$pid"; wait "$pid"
sleep 1
parent=$(cat "$WORK/h5.parent"); child=$(cat "$WORK/h5.child")
grep -q "^EXIT 143" "$WORK/pass5.out" && ok "the run ended through the handler" || bad "no clean exit"
kill -0 "$parent" 2> /dev/null && { bad "the alert command was left running"; kill -9 "$parent" 2> /dev/null; } || ok "the alert command was ended with the run"
kill -0 "$child" 2> /dev/null && { bad "what the command started was left running"; kill -9 "$child" 2> /dev/null; } || ok "and so was what it had started"
[ ! -f "$WORK/state5/alerts.lock" ] && ok "and the lock is released" || bad "lock left behind"

[ "$fails" -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
