// Usage: node scripts/backup-status.mjs [--json] [--env-file <path>]
//
// Reports how old the newest backup is and whether it is off the server,
// against the recovery point objective (RPO) once the owner has approved one.
// Exit codes: 0 within the RPO   1 no backup, stale, or not off-server
//             3 no RPO configured (age is printed; nothing to compare against)
// Intended for a monitoring check; it reads files only and prints no secrets.
import { loadBackupConfig, readStatus } from "./lib/backup.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--env-file");
if (at >= 0) process.loadEnvFile(args[at + 1]);
let config;
try {
  config = loadBackupConfig({
    ...process.env,
    SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED: "1",
  });
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
const status = readStatus(config.directory);
const now = Date.now();
const minutes = (iso) =>
  iso ? Math.floor((now - Date.parse(iso)) / 60000) : null;
const report = {
  lastBackupAgeMinutes: minutes(status.lastSuccess?.at),
  lastOffServerAgeMinutes: minutes(status.lastOffServer?.at),
  lastFailure: status.lastFailure ?? null,
  rpoMinutes: config.rpoMinutes,
  offServerConfigured: Boolean(config.targetDir || config.targetCommand),
};
let verdict = "ok";
let code = 0;
const age = report.offServerConfigured
  ? report.lastOffServerAgeMinutes
  : report.lastBackupAgeMinutes;
if (report.lastBackupAgeMinutes === null) {
  verdict = "no backup has ever completed";
  code = 1;
} else if (
  report.offServerConfigured &&
  report.lastOffServerAgeMinutes === null
) {
  verdict = "no backup has reached the off-server target";
  code = 1;
} else if (config.rpoMinutes === null) {
  verdict = "RPO not configured (pending owner approval)";
  code = 3;
} else if (age > config.rpoMinutes) {
  verdict = `newest ${report.offServerConfigured ? "off-server " : ""}backup is ${age} min old, over the ${config.rpoMinutes} min RPO`;
  code = 1;
}
if (args.includes("--json"))
  console.log(JSON.stringify({ verdict, ...report }));
else {
  console.log(`backup status: ${verdict}`);
  console.log(
    `  newest backup: ${report.lastBackupAgeMinutes ?? "none"} min ago`,
  );
  console.log(
    `  newest off-server copy: ${report.lastOffServerAgeMinutes ?? "none"} min ago`,
  );
  console.log(`  RPO: ${config.rpoMinutes ?? "not set"} min`);
  if (report.lastFailure)
    console.log(
      `  last failure: ${report.lastFailure.at} during ${report.lastFailure.stage}`,
    );
}
process.exit(code);
