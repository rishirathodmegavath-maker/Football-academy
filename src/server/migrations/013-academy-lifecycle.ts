import type { DatabaseSync } from "node:sqlite";

/**
 * Academy approval lifecycle (docs/ACADEMY_APPROVAL.md).
 *
 * Additive: two new tables, one index and two triggers. No existing table,
 * column or row is changed. Idempotent, and safe to run from several processes
 * starting together (the backfill runs under one IMMEDIATE transaction and only
 * for academies that have no lifecycle row yet).
 *
 * academy_lifecycle   one row per academy: its current state and the latest
 *                     decision. `version` makes two reviewers deciding the same
 *                     application at once impossible: the second sees a stale
 *                     version and is refused.
 * academy_lifecycle_history
 *                     append-only: who moved which academy from which state to
 *                     which, when and why. It can be neither changed nor
 *                     deleted (the same guard as the other history tables).
 *
 * THE EXPLICIT RULE FOR ACADEMIES THAT ALREADY EXIST (nothing is approved by
 * accident):
 *   - an academy whose platform entitlement is ACTIVE is recorded as ACTIVE,
 *     with a history row "MIGRATED" by `system:migration-013`, so the record
 *     shows that no reviewer decided it and a platform administrator can see
 *     and suspend any of them;
 *   - an academy whose entitlement is anything else (PAUSED, or missing) is
 *     recorded as SUSPENDED, so it stays exactly as closed as it is today.
 * Academies created after this migration start in CONFIGURING. An academy with
 * no lifecycle row is treated as not operational (fail closed).
 *
 * Reversible: DROP TABLE academy_lifecycle_history; DROP TABLE academy_lifecycle
 * (drop the two triggers first). Nothing else depends on them being absent.
 */
export const MIGRATION_ACTOR = "system:migration-013";
const STATES = [
  "CONFIGURING",
  "SUBMITTED",
  "PENDING_REVIEW",
  "REJECTED",
  "ACTIVE",
  "SUSPENDED",
];
export function migrateAcademyLifecycle(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS academy_lifecycle(
        academyId TEXT PRIMARY KEY REFERENCES academy_workspaces(id),
        state TEXT NOT NULL CHECK(state IN (${STATES.map((s) => `'${s}'`).join(",")})),
        version INTEGER NOT NULL DEFAULT 1,
        submissions INTEGER NOT NULL DEFAULT 0,
        submittedAt TEXT,
        reviewerId TEXT,
        reviewStartedAt TEXT,
        decidedAt TEXT,
        decidedBy TEXT,
        reason TEXT,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS academy_lifecycle_queue ON academy_lifecycle(state, submittedAt);
      CREATE TABLE IF NOT EXISTS academy_lifecycle_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        academyId TEXT NOT NULL REFERENCES academy_workspaces(id),
        fromState TEXT,
        toState TEXT NOT NULL,
        action TEXT NOT NULL,
        actorId TEXT NOT NULL,
        actorKind TEXT NOT NULL CHECK(actorKind IN ('OWNER','PLATFORM','SYSTEM')),
        reason TEXT,
        configVersion INTEGER,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS academy_lifecycle_history_academy ON academy_lifecycle_history(academyId, id);
      CREATE TRIGGER IF NOT EXISTS academy_lifecycle_history_append_only
        BEFORE UPDATE ON academy_lifecycle_history
        BEGIN SELECT RAISE(ABORT, 'academy_lifecycle_history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS academy_lifecycle_history_no_delete
        BEFORE DELETE ON academy_lifecycle_history
        BEGIN SELECT RAISE(ABORT, 'academy_lifecycle_history is append-only'); END;
    `);
    const at = new Date().toISOString();
    // Backfill: only academies with no row yet; one statement each for the
    // state and its history so both exist or neither does (one transaction).
    db.prepare(
      `INSERT INTO academy_lifecycle(academyId,state,version,submissions,decidedAt,decidedBy,reason,updatedAt)
       SELECT a.id,
              CASE WHEN e.status='ACTIVE' THEN 'ACTIVE' ELSE 'SUSPENDED' END,
              1, 0, ?, ?, ?, ?
       FROM academy_workspaces a
       LEFT JOIN platform_entitlements e ON e.academyId=a.id
       WHERE NOT EXISTS (SELECT 1 FROM academy_lifecycle l WHERE l.academyId=a.id)`,
    ).run(
      at,
      MIGRATION_ACTOR,
      "Existing academy carried over by the lifecycle migration; no reviewer decided it.",
      at,
    );
    db.prepare(
      `INSERT INTO academy_lifecycle_history(academyId,fromState,toState,action,actorId,actorKind,reason,configVersion,at)
       SELECT l.academyId, NULL, l.state, 'MIGRATED', ?, 'SYSTEM', l.reason,
              json_extract(a.config,'$.configVersion'), ?
       FROM academy_lifecycle l JOIN academy_workspaces a ON a.id=l.academyId
       WHERE l.decidedBy=? AND l.updatedAt=?
         AND NOT EXISTS (SELECT 1 FROM academy_lifecycle_history h WHERE h.academyId=l.academyId)`,
    ).run(MIGRATION_ACTOR, at, MIGRATION_ACTOR, at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
