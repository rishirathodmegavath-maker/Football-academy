import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
for (const file of [".env.local", ".env"])
  if (existsSync(file)) process.loadEnvFile(file);
/** Touched every pass so scripts/ops-check.mjs can tell a stopped worker from a quiet one. */
function heartbeat() {
  try {
    const database = resolve(
      process.env.SPORTOZEN_DATABASE_PATH ?? ".local/workspaces.sqlite",
    );
    writeFileSync(
      join(dirname(database), "worker-heartbeat"),
      new Date().toISOString(),
    );
  } catch {
    // Monitoring must never stop the worker.
  }
}
async function main() {
  const { workerTick } = await import("../src/server/communication-worker");
  const { processOutbox, purgeFinished } =
    await import("../src/server/email/outbox");
  const { scheduledRetention } = await import(
    "../src/server/delivery-retention"
  );
  const { log, errorFields } = await import("../src/server/log");
  let ticks = 0;
  let stopping = false;
  log("info", "worker.started", { pid: process.pid });
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });
  do {
    heartbeat();
    try {
      await workerTick();
    } catch (error) {
      log("error", "worker.tick_failed", {
        job: "communication",
        note: "persisted jobs are retained for recovery",
        ...errorFields(error),
      });
    }
    try {
      // Verification, reset and invitation mail (retries, expiry, redaction).
      await processOutbox();
      if (ticks++ % 360 === 0) purgeFinished();
    } catch (error) {
      log("error", "worker.tick_failed", {
        job: "email-outbox",
        note: "queued messages are retained",
        ...errorFields(error),
      });
    }
    try {
      // Once a day (a tick is ten seconds): delivery history older than 12
      // months. SPORTOZEN_RETENTION=report (the default) only counts, off does
      // nothing, on removes. Idempotent and bounded; a failure waits for tomorrow.
      if (ticks % 8640 === 1) await scheduledRetention();
    } catch (error) {
      log("error", "worker.tick_failed", {
        job: "delivery-retention",
        note: "no history was removed by this run",
        ...errorFields(error),
      });
    }
    heartbeat();
    if (process.argv.includes("--once")) break;
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 10000));
  } while (!stopping);
  log("info", "worker.stopped", { pid: process.pid });
}
void main();
