import type { DatabaseSync } from "node:sqlite";

/**
 * Indexes for the communication paths that read tables which only ever grow
 * (delivery_jobs, delivery_attempts, communication_events: finished rows are
 * kept). Without them the worker's every poll (every 10 seconds) scanned the
 * whole of delivery_jobs, and each webhook status update scanned
 * delivery_attempts; measured at 150,000 jobs that was about 31 ms per poll and
 * 19 ms per attempt lookup (docs/PHASE5_REPORT.md). Indexes only: no row and no
 * column changes, so nothing can be lost, and the migration is idempotent and
 * safe to run from several processes starting together.
 *
 * Reversible: DROP INDEX delivery_jobs_due, delivery_jobs_announcements,
 * delivery_attempts_job, communication_events_pending, communication_events_academy.
 */
export function migrateCommunicationIndexes(db: DatabaseSync) {
  db.exec(`
    -- The worker's due-job poll and the weekly-queue read: only queued, unclaimed jobs.
    CREATE INDEX IF NOT EXISTS delivery_jobs_due ON delivery_jobs(dueAt) WHERE state='QUEUED' AND claim IS NULL;
    -- Announcement jobs of one academy (the announcement dialog and cancellation).
    CREATE INDEX IF NOT EXISTS delivery_jobs_announcements ON delivery_jobs(academyId, dueAt) WHERE type='ANNOUNCEMENT';
    -- Provider status updates find a job's latest attempt.
    CREATE INDEX IF NOT EXISTS delivery_attempts_job ON delivery_attempts(jobId, at);
    -- Webhook processing: events not yet processed, oldest first.
    CREATE INDEX IF NOT EXISTS communication_events_pending ON communication_events(receivedAt) WHERE processedAt IS NULL;
    -- Inbound messages awaiting staff attention, per academy.
    CREATE INDEX IF NOT EXISTS communication_events_academy ON communication_events(academyId, outcome);
  `);
}
