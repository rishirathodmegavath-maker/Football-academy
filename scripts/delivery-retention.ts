import { existsSync } from "node:fs";
for (const file of [".env.local", ".env"])
  if (existsSync(file)) process.loadEnvFile(file);

// Delivery-history retention from the command line (docs/DELIVERY_RETENTION.md).
//
//   pnpm retention:run                 dry run: counts only, nothing is deleted
//   pnpm retention:run --execute       removes what is older than 12 months, in
//                                      bounded batches (re-run until it reports
//                                      COMPLETED)
//   --json                             print the result as JSON
//   --batch-size N / --max-batches N   change the bounds of one run
//
// The database is the one SPORTOZEN_DATABASE_PATH names. To rehearse, point it
// at a COPY of the database; this script never copies, moves or alters
// anything but the rows it reports.
async function main() {
  const args = process.argv.slice(2),
    flag = (name: string) => args.includes(name),
    value = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? Number(args[i + 1]) : undefined;
    };
  const { runDeliveryRetention } =
    await import("../src/server/delivery-retention");
  const result = await runDeliveryRetention({
    execute: flag("--execute"),
    batchSize: value("--batch-size"),
    maxBatches: value("--max-batches"),
  });
  if (flag("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    const verb = result.mode === "EXECUTE" ? "removed" : "would remove";
    console.log(
      `Delivery-history retention (${result.mode}, ${result.status}): ${verb} ${result.jobs} job(s), ${result.attempts} attempt(s), ${result.events} webhook event(s) older than ${result.cutoff} (${result.retentionMonths} months).`,
    );
    for (const [academy, t] of Object.entries(result.perAcademy))
      console.log(
        `  ${academy}: ${t.jobs} job(s), ${t.attempts} attempt(s), ${t.events} event(s) (due ${t.oldestDueAt ?? "-"} to ${t.newestDueAt ?? "-"})`,
      );
    const h = result.heldBack;
    console.log(
      `Held back: non-final old jobs ${JSON.stringify(h.nonFinalJobs)}, in-flight ${h.inFlightJobs}, malformed timestamps ${h.malformedTimestamps}, open events ${h.openEvents}.`,
    );
    if (result.error) console.log(`Note: ${result.error}`);
    if (result.status === "CAPPED")
      console.log("The per-run limit was reached; run it again to continue.");
  }
  process.exitCode = result.status === "FAILED" ? 1 : 0;
}
void main();
