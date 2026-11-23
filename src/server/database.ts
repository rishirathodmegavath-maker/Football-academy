import "server-only";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrateFootballTraining } from "./migrations/002-football-training";
import { migrateCommunications } from "./migrations/003-communications";
import { migrateAcademyFinance } from "./migrations/004-academy-finance";
import { migrateTrialEnrolments } from "./migrations/005-trial-enrolments";
import { migrateBatchAnnouncements } from "./migrations/006-batch-announcements";
import { migrateSessionPlaces } from "./migrations/007-session-places";
import { migrateIntegrityGuards } from "./migrations/008-integrity-guards";
import { migrateEmailOutbox } from "./migrations/009-email-outbox";
import { migrateEmailDelivery } from "./migrations/010-email-delivery";
import { migrateCommunicationIndexes } from "./migrations/011-communication-indexes";
import { migrateDeliveryJobPaging } from "./migrations/012-delivery-job-paging";
import { migrateAcademyLifecycle } from "./migrations/013-academy-lifecycle";
import { migrateDeliveryRetention } from "./migrations/014-delivery-retention";
import { migrateSelfAccess } from "./migrations/015-self-access";
import { migrateCalendarAndContacts } from "./migrations/016-calendar-and-contacts";
import { migrateMessaging } from "./migrations/017-communications";
import { migratePlayerLinks } from "./migrations/018-player-links";
const connections = globalThis as typeof globalThis & {
  sportozenDatabase?: DatabaseSync;
  sportozenTransactionDepth?: number;
};
/**
 * Switches the file to WAL. SQLite does not always call the busy handler for a
 * journal-mode change (waiting could deadlock against the other connection), so
 * when several processes open a brand-new database together the loser gets
 * "database is locked" immediately, whatever busy_timeout says. The winner
 * finishes in milliseconds, so wait and try again for a bounded time, then
 * report the real error.
 */
function enableWal(db: DatabaseSync) {
  const deadline = Date.now() + 10_000,
    pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      const code = Number((error as { errcode?: unknown }).errcode);
      if (![5, 6].includes(code & 0xff) || Date.now() > deadline) throw error;
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}
/** Owner-only access. Not supported on Windows file systems; ignored there. */
function restrictFile(path: string) {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // A read-only mount or a file owned by someone else: the preflight check
    // reports the resulting mode.
  }
}
export function database() {
  if (connections.sportozenDatabase) return connections.sportozenDatabase;
  const filename = resolve(
    process.env.SPORTOZEN_DATABASE_PATH ?? ".local/workspaces.sqlite",
  );
  // Children's records: keep the directory and the file private to this user.
  // SQLite gives the -wal and -shm files the main file's permissions.
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  restrictFile(filename);
  // The busy timeout must be in force before anything else touches the file:
  // switching to WAL and creating tables take locks, and a second process that
  // opens the database at the same moment (the web server and the
  // communication worker, or parallel build workers) must wait, not fail.
  db.exec("PRAGMA busy_timeout=5000");
  enableWal(db);
  // INSERT OR REPLACE deletes the row it replaces without firing DELETE triggers
  // unless this is on; the append-only guards (migration 008) rely on it.
  db.exec("PRAGMA recursive_triggers=ON");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS academy_workspaces(id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS academy_memberships(id TEXT PRIMARY KEY, academyId TEXT NOT NULL REFERENCES academy_workspaces(id), userId TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sportIds TEXT NOT NULL DEFAULT '[]', expiresAt TEXT, UNIQUE(academyId,userId));
    CREATE TABLE IF NOT EXISTS workspace_records(academyId TEXT NOT NULL REFERENCES academy_workspaces(id), kind TEXT NOT NULL,id TEXT NOT NULL,sportId TEXT,playerId TEXT,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(academyId,kind,id));
    CREATE TABLE IF NOT EXISTS guardian_relationships(academyId TEXT NOT NULL REFERENCES academy_workspaces(id),userId TEXT NOT NULL,playerId TEXT NOT NULL,PRIMARY KEY(academyId,userId,playerId));
    CREATE TABLE IF NOT EXISTS support_relationships(academyId TEXT NOT NULL REFERENCES academy_workspaces(id),userId TEXT NOT NULL,playerId TEXT NOT NULL,PRIMARY KEY(academyId,userId,playerId));
    CREATE TABLE IF NOT EXISTS workspace_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,academyId TEXT,userId TEXT NOT NULL,action TEXT NOT NULL,resourceId TEXT,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_administrators(userId TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS platform_entitlements(academyId TEXT PRIMARY KEY REFERENCES academy_workspaces(id),tier TEXT NOT NULL,modules TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_invitations(id TEXT PRIMARY KEY,academyId TEXT NOT NULL REFERENCES academy_workspaces(id),email TEXT NOT NULL,role TEXT NOT NULL,playerIds TEXT NOT NULL,tokenHash TEXT NOT NULL UNIQUE,expiresAt TEXT NOT NULL,acceptedAt TEXT);
    CREATE TABLE IF NOT EXISTS report_approval_history(id TEXT PRIMARY KEY,academyId TEXT NOT NULL,reportId TEXT NOT NULL,snapshot TEXT NOT NULL,approvedPlan TEXT NOT NULL,approvedBy TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS update_approval_history(id TEXT PRIMARY KEY,academyId TEXT NOT NULL,updateId TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,source TEXT NOT NULL,approvedBy TEXT NOT NULL,at TEXT NOT NULL);
    `);
  migrateFootballTraining(db);
  migrateCommunications(db);
  migrateAcademyFinance(db);
  migrateTrialEnrolments(db);
  migrateBatchAnnouncements(db);
  migrateSessionPlaces(db);
  migrateIntegrityGuards(db);
  migrateEmailOutbox(db);
  migrateEmailDelivery(db);
  migrateCommunicationIndexes(db);
  migrateDeliveryJobPaging(db);
  migrateAcademyLifecycle(db);
  migrateDeliveryRetention(db);
  migrateSelfAccess(db);
  migrateCalendarAndContacts(db);
  migrateMessaging(db);
  migratePlayerLinks(db);
  connections.sportozenDatabase = db;
  return db;
}
/**
 * Runs `fn` as one all-or-nothing unit. The outermost call opens the
 * transaction; a call made while one is open becomes a SAVEPOINT inside it, so
 * a low-level writer (for example the record repository) can protect its own
 * multi-statement writes and still be called from a larger transaction. If a
 * nested unit fails and the caller handles the error, only the nested unit is
 * undone. `fn` must be synchronous: the connection is shared and a transaction
 * must never stay open across an await.
 */
export function atomic<T>(fn: () => T): T {
  const db = database(),
    depth = connections.sportozenTransactionDepth ?? 0;
  // A transaction this function did not open (Better Auth runs some sign-up
  // work in one on this shared connection) cannot be joined. Say so as a
  // retryable "busy" instead of surfacing an opaque SQLite error.
  if (depth === 0 && db.isTransaction)
    throw Object.assign(
      new Error("database is busy with another transaction"),
      {
        errcode: 5,
      },
    );
  const savepoint = `sportozen_unit_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  connections.sportozenTransactionDepth = depth + 1;
  try {
    const result = fn();
    if (result instanceof Promise)
      throw new Error("atomic() cannot wrap an asynchronous function.");
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (e) {
    try {
      db.exec(
        depth === 0
          ? "ROLLBACK"
          : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
    } catch {
      // The failing statement may already have ended the transaction; the
      // original error is the one worth reporting.
    }
    throw e;
  } finally {
    connections.sportozenTransactionDepth = depth;
  }
}
export function audit(
  academyId: string | null,
  userId: string,
  action: string,
  resourceId?: string,
) {
  database()
    .prepare(
      "INSERT INTO workspace_audit(academyId,userId,action,resourceId,at) VALUES(?,?,?,?,?)",
    )
    .run(
      academyId,
      userId,
      action,
      resourceId ?? null,
      new Date().toISOString(),
    );
}
