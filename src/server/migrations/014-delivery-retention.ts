import type { DatabaseSync } from "node:sqlite";

/**
 * Delivery-history retention (docs/DELIVERY_RETENTION.md).
 *
 * Additive: one new table and two partial indexes. No existing table, column or
 * row changes. Idempotent, and safe to run from several processes starting
 * together (CREATE ... IF NOT EXISTS).
 *
 * delivery_retention_runs   one row per cleanup run (dry run or real): when it
 *                           started and ended, the cut-off it used, how many
 *                           rows it removed or would remove, how it ended and
 *                           why. It is also the lease that stops two runs from
 *                           working at once. Kept indefinitely (a few rows a
 *                           day at most).
 * delivery_jobs_retention   finds final-state jobs by due date without scanning
 *                           the table, so one bounded batch costs about the same
 *                           at ten thousand jobs and at ten million.
 * communication_events_retention
 *                           the same for processed webhook events.
 *
 * Reversible: DROP INDEX delivery_jobs_retention, communication_events_retention;
 * DROP TABLE delivery_retention_runs.
 */
export function migrateDeliveryRetention(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_retention_runs(
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('REPORT','EXECUTE')),
      status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','CAPPED','FAILED','SKIPPED')),
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      leaseUntil TEXT,
      cutoff TEXT NOT NULL,
      retentionMonths INTEGER NOT NULL,
      batches INTEGER NOT NULL DEFAULT 0,
      jobs INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      events INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS delivery_retention_runs_started ON delivery_retention_runs(startedAt);
    CREATE INDEX IF NOT EXISTS delivery_jobs_retention ON delivery_jobs(dueAt, id) WHERE state IN ('DELIVERED','READ','FAILED','CANCELLED');
    CREATE INDEX IF NOT EXISTS communication_events_retention ON communication_events(receivedAt, id) WHERE processedAt IS NOT NULL;
  `);
}
