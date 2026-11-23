# Production database: SQLite on one server

Decision for the first production release: **keep SQLite** (Node's built-in `node:sqlite`). PostgreSQL is not part of this work and nothing here is a migration to it. Reasons and the conditions for revisiting are in `docs/ARCHITECTURE.md` and in Section 7.

## 1. Connection settings (verified)

Every connection the application opens through `database()` (`src/server/database.ts`) is configured, in this order, before anything else touches the file:

| Setting              | Value                          | Why                                                                                              |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `busy_timeout`       | 5000 ms                        | The web process, the worker and the backup job share the file; a writer waits instead of failing |
| `journal_mode`       | WAL                            | Readers do not block the writer; safe against power loss; needs a local disk                     |
| `recursive_triggers` | ON                             | `INSERT OR REPLACE` must fire the delete guards on history/audit tables                          |
| `foreign_keys`       | ON                             | Declared references are enforced                                                                 |
| File mode            | 0600 (directory 0700) on Linux | Children's records are private to the service user; SQLite gives `-wal`/`-shm` the same mode     |

`tests/unit/database-persistence.test.ts` opens the database in a fresh process and asserts these values (`journal_mode=wal`, `busy_timeout=5000`, `foreign_keys=1`, `recursive_triggers=1`, `integrity_check=ok`). On Linux it also asserts the 0600/0700 modes. Because switching an existing file into WAL can be refused with "database is locked" when several processes open it at once, `enableWal()` waits and retries for up to 10 seconds.

Operator scripts that open their own connection (`scripts/platform-admin.mjs`) now set `busy_timeout` and `recursive_triggers` too. Do not write ad-hoc scripts against the live file; if you must, use the application's `database()` or copy these two pragmas.

## 2. Persistence across restarts and deployments

- The file lives at the absolute `SPORTOZEN_DATABASE_PATH` outside every release directory (preflight refuses a relative path or one inside the application directory), so a new release, a rollback or a re-created release directory leaves the data in place.
- A clean stop (SIGTERM) folds the write-ahead log into the database file and closes it (`src/server/shutdown.ts`); verified by a child-process test that fails when the handler is removed.
- A hard kill is also safe: committed transactions survive (SQLite replays the log on the next open). Verified by killing a process with `SIGKILL` right after a commit and reading the row back from a process started in a different working directory.
- Starting the new release twice, or from another directory, changes nothing: migrations are repeatable.
- Never copy only the `.sqlite` file while the service runs: committed data may still be in the `-wal` file. Use the backup tool (consistent online snapshot), or stop the service and copy all three files.

## 3. Migrations

Migrations are hand-written, additive and run automatically when the first process opens the database (`src/server/migrations`, `002`–`009`). They create tables, indexes and triggers with `IF NOT EXISTS`, add a column only if it is missing, and never drop, rewrite or delete existing rows. Real foreign keys and table rebuilds are deferred by decision.

| Migration | What it adds                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 002–007   | Training history and submissions, communications, finance, trials, announcements, session places                                                                                                                         |
| 008       | Append-only triggers on six history/audit tables (no UPDATE or DELETE, including `INSERT OR REPLACE`), role limits, rate-limit table, record-ownership guards (installed only if the stored data already satisfies them) |
| 009       | `email_outbox` queue table and three indexes (Phase 2)                                                                                                                                                                   |

Concurrency (reviewed in Phase 2):

- 002 and 008 run inside `BEGIN IMMEDIATE`. 003 was a check-then-act (look for a missing column, then `ALTER TABLE`) outside any lock, so two processes starting together on an old database could both decide to add the column and the second would crash on "duplicate column name". 003 now runs under `BEGIN IMMEDIATE` and also tolerates a column that has appeared anyway. The crash is reproduced deterministically by feeding the old code a stale schema read (the test fails on the old code with exactly that error). Six real processes started together on an old database also all succeed, but that test passed on the old code too (the window is tiny), so it is a smoke test, not proof.
- 004–007 only `CREATE ... IF NOT EXISTS`, which is safe under concurrency.
- Better Auth runs its own table migration on the same file at first use.

Safe-migration procedure for every release that changes the schema:

1. Take a verified backup of the live database (the release script does this) and keep it until the release has run for a while.
2. Run `node --conditions=react-server --import tsx scripts/check-data-integrity.ts <copy of the database>` on a **copy**; fix every ERROR first. Migration 008's ownership guards install only when the data satisfies them; otherwise a warning is logged and they install on a later start once the data is clean.
3. Start the new release. Migrations apply once, in the first process to open the file.
4. Check `/api/ready` and the service log.
5. If the release must be undone, switch code back (`deploy/rollback.sh`). The schema stays as migrated; older code ignores additions. Restore data from the backup only if data was damaged.

Not done, by decision or limits: reverting migrations, real foreign keys, rebuilding tables.

## 4. Deleting and editing history

History and audit tables reject UPDATE and DELETE. A deliberate purge is an operator step: drop that table's `<table>_no_delete` trigger, delete, then restart so the application recreates the trigger. Do it only on advice and only after a backup.

## 5. Recovery decision tree

| Symptom                               | Action                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service will not start after a deploy | `journalctl -u sportozen-web`; preflight message names the setting. Roll back code with `deploy/rollback.sh`                                              |
| `/api/ready` is 503 "schema"          | Wrong or empty database file at the configured path. Do not create a new one: check `SPORTOZEN_DATABASE_PATH` and the mounts                              |
| Database file missing or corrupt      | Stop the service. Keep the damaged file. Restore from a verified backup to a **new path** and cut over ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)) |
| Data wrong but the file is healthy    | Restore a backup to a new path, compare, repair deliberately. Never overwrite the original in place                                                       |
| Frequent `503` + `Retry-After`        | Write contention. Check for a long-running job (backup runs read-only and does not block writers) and for scripts holding locks                           |

## 6. Known limits

- Better Auth shares the application's connection and runs some sign-up work in a transaction on it. A write that arrives during that moment is answered `503` with `Retry-After: 1` rather than failing opaquely. This has not been load-tested.
- One server only. Do not run two application instances against the same file, and do not put the file on a network share.
- `node:sqlite` prints an ExperimentalWarning on Node 24; the API can change in a Node release, which is why the Node version is pinned and upgrades are tested first.
- Migration 008 scans tables while holding the write lock; on a very large database run it in a maintenance window.

## 7. When to revisit PostgreSQL

More than one application instance needed; sustained write contention (a rising rate of `503` busy responses); a recovery point objective tighter than continuous file replication can give; or a compliance requirement for provider-managed high availability. The data layer is synchronous and SQLite-specific (about 196 `prepare`/`exec` sites in 29 files, `json_extract`, `ON CONFLICT`, triggers), so this is a rewrite of the layer plus data migration, not a configuration change.
