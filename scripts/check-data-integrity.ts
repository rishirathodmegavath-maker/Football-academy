// Read-only data integrity report for a Sportozen SQLite database.
//   node --conditions=react-server --import tsx scripts/check-data-integrity.ts <database-file>
// The file is opened read-only; nothing is written, repaired or deleted. Run it
// against a copy before any migration or data change. Exit code 1 means at
// least one ERROR finding.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { checkDataIntegrity } from "../src/server/data-integrity";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("Usage: check-data-integrity.ts <database-file>");
  process.exit(2);
}
const db = new DatabaseSync(file, { readOnly: true });
const findings = checkDataIntegrity(db);
db.close();
if (!findings.length) console.log("No integrity findings.");
for (const f of findings)
  console.log(
    `${f.severity.padEnd(7)} ${String(f.count).padStart(6)}  ${f.check}\n          e.g. ${f.examples.join(" | ")}`,
  );
const errors = findings.filter((f) => f.severity === "ERROR").length;
console.log(
  `\n${findings.length} check(s) with findings, ${errors} of them errors.`,
);
process.exit(errors ? 1 : 0);
