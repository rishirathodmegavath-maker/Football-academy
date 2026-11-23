// Usage:
//   node scripts/restore-database.mjs --backup <file> --verify-only
//   node scripts/restore-database.mjs --backup <file> --rehearse
//   node scripts/restore-database.mjs --backup <file> --target </new/path.sqlite>
//
// Restores a backup to a NEW file after verifying it (hash, decryption,
// integrity_check, schema version, row counts). It refuses to write over the
// live database or any existing file. Switching the application to the restored
// file is a separate, manual step (docs/BACKUP_AND_RECOVERY.md).
// The key is read from SPORTOZEN_BACKUP_ENCRYPTION_KEY or --key-file; never
// from the command line. Exit codes: 0 verified, 1 failed or refused.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rehearseRestore,
  restoreBackup,
  keyFingerprint,
} from "./lib/backup.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  if (!args[at + 1]) throw new Error(`${flag} needs a value`);
  return args[at + 1];
};
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
try {
  const envFile = value("--env-file");
  if (envFile) process.loadEnvFile(envFile);
  const artifact = value("--backup");
  if (!artifact) fail("--backup <file> is required");
  const keyFile = value("--key-file");
  const raw = keyFile
    ? readFileSync(keyFile, "utf8").trim()
    : process.env.SPORTOZEN_BACKUP_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (key && key.length !== 32)
    fail("the encryption key must be 32 bytes, base64 encoded");
  if (key) console.log(`using key ${keyFingerprint(key)}`);
  const rto = Number(process.env.SPORTOZEN_BACKUP_RTO_MINUTES) || null;
  const report = (result) => {
    if (!result.ok) {
      console.error("VERIFICATION FAILED:");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(
      `verified: backup of ${result.manifest.createdAt}, schema ${result.manifest.userVersion}, ${Object.keys(result.manifest.counts).length} tables, integrity ok`,
    );
    console.log(
      `restore took ${seconds}s${rto ? ` (RTO budget ${rto} min)` : " (no RTO configured)"}`,
    );
    if (result.facts?.foreignKeyViolations)
      console.log(
        `note: ${result.facts.foreignKeyViolations} foreign key violation(s) were already present in the source`,
      );
  };
  if (args.includes("--verify-only") || args.includes("--rehearse")) {
    const scratch = mkdtempSync(
      join(
        process.env.SPORTOZEN_RESTORE_SCRATCH || tmpdir(),
        "sportozen-rehearsal-",
      ),
    );
    report(await rehearseRestore({ artifact, key, scratch }));
    console.log(
      "nothing was written outside a temporary directory, which has been deleted",
    );
  } else {
    const target = value("--target");
    if (!target)
      fail("give --target <new file>, or use --verify-only / --rehearse");
    const result = await restoreBackup({
      artifact,
      key,
      target,
      liveDatabase: process.env.SPORTOZEN_DATABASE_PATH,
    });
    report(result);
    console.log(`restored to ${result.target}`);
    console.log(
      "the application was NOT switched over; follow the cut-over steps in docs/BACKUP_AND_RECOVERY.md",
    );
  }
} catch (error) {
  fail(error.message);
}
