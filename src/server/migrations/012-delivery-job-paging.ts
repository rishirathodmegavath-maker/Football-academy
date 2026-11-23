import type { DatabaseSync } from "node:sqlite";

/**
 * Indexes for the paged delivery-job list (communication-repository `jobsPage`).
 * The list is newest-first by (dueAt, id) inside one academy, optionally for one
 * player, one guardian or one state. Without these every page would sort the
 * academy's whole job history. Partial on playerId<>'' because announcement
 * jobs (playerId '') have their own index from migration 011 and would only
 * make these larger.
 *
 * Indexes only: no row and no column changes, idempotent, safe to run from
 * several processes starting together. Reversible: DROP INDEX
 * delivery_jobs_page, delivery_jobs_page_player, delivery_jobs_page_guardian,
 * delivery_jobs_page_state.
 */
export function migrateDeliveryJobPaging(db: DatabaseSync) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS delivery_jobs_page ON delivery_jobs(academyId, dueAt DESC, id DESC) WHERE playerId<>'';
    CREATE INDEX IF NOT EXISTS delivery_jobs_page_player ON delivery_jobs(academyId, playerId, dueAt DESC, id DESC) WHERE playerId<>'';
    CREATE INDEX IF NOT EXISTS delivery_jobs_page_guardian ON delivery_jobs(academyId, guardianId, dueAt DESC, id DESC) WHERE playerId<>'';
    CREATE INDEX IF NOT EXISTS delivery_jobs_page_state ON delivery_jobs(academyId, state, dueAt DESC, id DESC) WHERE playerId<>'';
  `);
}
