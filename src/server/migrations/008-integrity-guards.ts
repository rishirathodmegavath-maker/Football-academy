import type { DatabaseSync } from "node:sqlite";
import { log } from "../log";

/**
 * Additive integrity guards. Nothing here rewrites, rebuilds or deletes
 * existing data, and every guard is a trigger that only judges rows written
 * from now on, so databases that already hold unusual rows keep opening (the
 * record-ownership guards are not installed at all while such rows exist; see
 * createOwnershipGuard). Each can be removed with DROP TRIGGER / DROP TABLE.
 *
 * - Records must belong to the academy and carry the id their row says: a
 *   writer that bypasses the repository cannot file one academy's record under
 *   another.
 * - History and audit tables are append-only: a stored approval, edit or audit
 *   entry can be neither changed nor deleted. No application code deletes from
 *   them. Retention or a deliberate purge is a conscious operator step: DROP the
 *   table's `_no_delete` trigger, delete, and restart (the migration restores it).
 * - Roles are limited to the five the product defines. Entitlement status is
 *   deliberately not constrained: access only requires ACTIVE, and other
 *   values (PAUSED, SUSPENDED) are all "no access".
 * - request_rate_limits backs the write limiter in rate-limit.ts.
 */
export const APPEND_ONLY_TABLES = [
  "training_history",
  "academy_finance_history",
  "report_approval_history",
  "update_approval_history",
  "batch_announcement_history",
  "workspace_audit",
];
const ROLES = "'OWNER','ADMIN','COACH','PARENT','SUPPORT'";
interface OwnershipGuard {
  name: string;
  table: string;
  /** SQL over a row (NEW. in a trigger, bare columns when scanning) that is true when it is NOT acceptable. */
  violation: (row: "NEW." | "") => string;
  message: string;
}
const OWNERSHIP_GUARDS: OwnershipGuard[] = [
  {
    name: "workspace_records_owner",
    table: "workspace_records",
    violation: (r) =>
      `NOT json_valid(${r}body) OR json_extract(${r}body,'$.academyId') IS NOT ${r}academyId OR json_extract(${r}body,'$.id') IS NOT ${r}id`,
    message: "workspace record does not match its academy and id",
  },
  {
    name: "academy_finance_records_owner",
    table: "academy_finance_records",
    violation: (r) =>
      `NOT json_valid(${r}body) OR json_extract(${r}body,'$.academyId') IS NOT ${r}academyId`,
    message: "finance record does not match its academy",
  },
];
/**
 * Creates the insert/update triggers for one table, but only when every row
 * already stored satisfies them. A database holding a legacy malformed row
 * must keep working (the trigger would otherwise refuse every later save that
 * touches that row), so the guard is skipped with a warning and created on a
 * later start once scripts/check-data-integrity.ts shows the data is clean.
 */
function createOwnershipGuard(db: DatabaseSync, guard: OwnershipGuard) {
  const exists = (event: string) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(`${guard.name}_${event}`),
    );
  if (exists("insert") && exists("update")) return;
  const bad = Number(
    db
      .prepare(
        `SELECT COUNT(*) n FROM ${guard.table} WHERE ${guard.violation("")}`,
      )
      .get()?.n,
  );
  if (bad > 0) {
    log("warn", "migration.guard_not_installed", {
      guard: guard.name,
      rows: bad,
      note: `Integrity guard ${guard.name} NOT installed: ${bad} stored row(s) in ${guard.table} do not satisfy it. Run scripts/check-data-integrity.ts, correct them, and restart.`,
    });
    return;
  }
  for (const event of ["insert", "update"])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${guard.name}_${event}
      BEFORE ${event.toUpperCase()} ON ${guard.table}
      WHEN ${guard.violation("NEW.")}
      BEGIN SELECT RAISE(ABORT, '${guard.message}'); END`);
}
export function migrateIntegrityGuards(db: DatabaseSync) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS request_rate_limits(
      scope TEXT NOT NULL, bucket TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(scope,bucket)
    )`,
    "CREATE INDEX IF NOT EXISTS request_rate_limits_expiry ON request_rate_limits(expiresAt)",
    ...APPEND_ONLY_TABLES.flatMap((table) => [
      `CREATE TRIGGER IF NOT EXISTS ${table}_append_only
        BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
      `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
        BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
    ]),
    ...["INSERT", "UPDATE"].map(
      (
        event,
      ) => `CREATE TRIGGER IF NOT EXISTS academy_memberships_role_${event.toLowerCase()}
        BEFORE ${event} ON academy_memberships
        WHEN NEW.role NOT IN (${ROLES})
        BEGIN SELECT RAISE(ABORT, 'unknown academy role'); END`,
    ),
    ...["INSERT", "UPDATE"].map(
      (
        event,
      ) => `CREATE TRIGGER IF NOT EXISTS workspace_invitations_role_${event.toLowerCase()}
        BEFORE ${event} ON workspace_invitations
        WHEN NEW.role NOT IN (${ROLES})
        BEGIN SELECT RAISE(ABORT, 'unknown invitation role'); END`,
    ),
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.exec(statement);
    for (const guard of OWNERSHIP_GUARDS) createOwnershipGuard(db, guard);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
