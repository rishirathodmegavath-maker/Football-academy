// Usage: node scripts/backup-database.mjs [--label <name>] [--no-upload] [--env-file <path>]
//
// Takes one consistent, encrypted, verified backup of the live database and
// copies it off the server. Safe to run while the application is serving.
// Exit codes: 0 stored and uploaded (or no target configured, with a warning)
//             1 failed, nothing usable was stored
//             2 stored on this server but NOT copied off it
import { createBackup, loadBackupConfig } from "./lib/backup.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  if (!args[at + 1]) throw new Error(`${flag} needs a value`);
  return args[at + 1];
};
const envFile = value("--env-file");
if (envFile) process.loadEnvFile(envFile);
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
try {
  const config = loadBackupConfig(process.env);
  const result = await createBackup({
    config,
    label: value("--label") ?? "scheduled",
    upload: !args.includes("--no-upload"),
    log,
  });
  if (
    !config.targetDir &&
    !config.targetCommand &&
    !args.includes("--no-upload")
  )
    log(
      "WARNING: no off-server target is configured; this backup does not protect against losing the server",
    );
  log(
    `backup complete: ${result.name} in ${(result.durationMs / 1000).toFixed(1)}s`,
  );
} catch (error) {
  log(`ERROR: ${error.message}`);
  process.exit(error.stage === "upload" ? 2 : 1);
}
