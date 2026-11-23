// Usage: node scripts/ops-alert.mjs --unit <systemd-unit> [--env-file <path>]
//
// Run by systemd (sportozen-alert@.service) when a Sportozen unit enters the
// failed state, for example a backup that exited with an error or a web
// service that crashed repeatedly. Sends one critical alert through the
// destinations configured for ops-check. Exits 0 on delivery, 3 on a bad
// configuration (the reason is in the journal), 4 when nothing accepted it.
import { formatAlert, loadOpsConfig, sendAlert } from "./lib/ops.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--env-file");
if (at >= 0) process.loadEnvFile(args[at + 1]);
const unitAt = args.indexOf("--unit");
const unit = unitAt >= 0 ? String(args[unitAt + 1] ?? "") : "";
if (!/^[A-Za-z0-9@._:-]{1,80}$/.test(unit)) {
  console.error("Usage: node scripts/ops-alert.mjs --unit <unit-name>");
  process.exitCode = 2;
} else {
  let config = null;
  try {
    config = loadOpsConfig(process.env);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 3;
  }
  if (config) {
    const hint = unit.includes("backup")
      ? "docs/OPERATIONS.md#backup-failure"
      : "docs/OPERATIONS.md#application-unavailable";
    const message = formatAlert(
      {
        kind: "NEW",
        name: `unit ${unit}`,
        level: "critical",
        detail: `the systemd unit ${unit} failed; run: journalctl -u ${unit} -n 100`,
        hint,
      },
      config,
    );
    const outcomes = await sendAlert(config, message);
    console.log(
      JSON.stringify({ event: "ops.unit_failed_alert", unit, outcomes }),
    );
    // exitCode, not process.exit(): see ops-check.mjs.
    process.exitCode = outcomes.length && outcomes.every((o) => o.ok) ? 0 : 4;
  }
}
