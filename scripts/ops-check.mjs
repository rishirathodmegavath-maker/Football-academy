// Usage: node scripts/ops-check.mjs [--deep] [--alert] [--json] [--strict]
//                                    [--test-alert] [--env-file <path>]
//
// One pass over everything an operator needs to know is working: the
// application's readiness, the database (readable, write lock, log size, and
// with --deep a full integrity check), disk space, backup freshness, the
// background worker's heartbeat, e-mail delivery, repeated sign-in failures,
// the latest deployment event and (if configured) certificate expiry.
//
//   --alert       send alerts for what is wrong (after two consecutive passes,
//                 then hourly for critical and daily for warnings) and one
//                 "resolved"; needs SPORTOZEN_ALERT_COMMAND and/or
//                 SPORTOZEN_ALERT_WEBHOOK_URL (see docs/OPERATIONS.md)
//   --test-alert  send one TEST message to every destination and report whether
//                 each accepted it. Run this once after configuring alerts.
//   --json        print one JSON object instead of text
//   --deep        add quick_check/foreign_key_check (run weekly, not every minute)
//   --strict      exit 1 on any critical result, 2 on warnings only (for
//                 monitors that poll); without it the exit status is 0 so a
//                 systemd timer does not report its own failure on top of the alert
// Exit status: 3 bad configuration, 4 an alert could not be delivered.
//
// Reads only; the one write is a lock probe that is rolled back at once.
import {
  formatAlert,
  loadOpsConfig,
  runAlertPass,
  runOpsChecks,
  sendAlert,
  worst,
} from "./lib/ops.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--env-file");
if (at >= 0) process.loadEnvFile(args[at + 1]);
let config;
try {
  config = loadOpsConfig(process.env);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 3;
}
if (config && args.includes("--test-alert")) {
  if (!config.alertCommand && !config.alertWebhook) {
    console.error("No alert destination is configured.");
    process.exitCode = 3;
  } else {
    const outcomes = await sendAlert(
      config,
      formatAlert(
        {
          kind: "TEST",
          name: "alert-test",
          level: "info",
          detail: "this is a test; no action is needed",
          hint: "docs/OPERATIONS.md#7-verifying-the-monitoring-do-once-record-the-result",
        },
        config,
      ),
    );
    for (const o of outcomes)
      console.log(`${o.sink}: ${o.ok ? "accepted" : "FAILED"}`);
    process.exitCode = outcomes.every((o) => o.ok) ? 0 : 4;
  }
} else if (config) {
  const results = await runOpsChecks(config, { deep: args.includes("--deep") });
  const overall = worst(results);
  let undelivered = 0;
  if (args.includes("--alert")) {
    const pass = await runAlertPass(config, results);
    if (pass.locked)
      console.error("Another run is handling alerts; skipping this pass.");
    undelivered = pass.undelivered;
  }
  if (args.includes("--json"))
    console.log(JSON.stringify({ overall, results }));
  else {
    console.log(`ops check: ${overall.toUpperCase()}`);
    for (const r of results)
      console.log(`  ${r.level.padEnd(8)} ${r.name}: ${r.detail}`);
  }
  // Set the status and let the event loop drain: calling process.exit() while
  // fetch connections are still closing aborts the process on Windows.
  process.exitCode = undelivered
    ? 4
    : args.includes("--strict")
      ? overall === "critical"
        ? 1
        : overall === "warning"
          ? 2
          : 0
      : 0;
}
