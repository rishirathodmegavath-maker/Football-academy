# Delivery-history retention: 12 months

Status: **implemented and tested on throw-away databases. Nothing has run against a real database.** Approved decision: communication delivery history is kept for 12 months. This replaces the proposal in `DELIVERY_DATA_RETENTION.md`, which stays as the record of the options and of the other retention questions (webhook bodies, audit, erasure) that this change does not decide.

Written for: the application owner, and whoever operates the worker.

## 1. What is removed, and when

| Table                  | Removed when                                                                                                                                      | Why                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `delivery_jobs`        | in a **final state** (`DELIVERED`, `READ`, `FAILED`, `CANCELLED`), not claimed, and the **end of its lifecycle is strictly older than 12 months** | the delivery history                                                                                   |
| `delivery_attempts`    | their job is removed (children go first; the foreign key requires it)                                                                             | provider attempts of that job                                                                          |
| `communication_events` | **processed**, outcome known and not one of the three staff action lists, received **strictly older than 12 months**                              | the webhook that reported on a job, or a guardian's reply (the reply text is kept in the conversation) |

**The end of a job's lifecycle** is the latest of its due time (`dueAt`), its expiry (`expiresAt`) and its last provider attempt (`delivery_attempts.at`). The tables have no "finished at" column, and a job that was retried, or whose receipt came late, must not be removed on the strength of its first date. All values are UTC ISO-8601 text (`...Z`); a record whose timestamp is not in that form is **held back and reported, never guessed at**.

**The boundary.** The cut-off is _now_ minus 12 calendar months in UTC (`2026-11-03T12:00:00Z` → `2025-11-03T12:00:00Z`; a day that does not exist a year earlier, 29 February, is clamped to the 28th, the earlier cut-off, so the record is kept longer). A record exactly at the cut-off is kept; one millisecond older is removed; one newer is kept. Tested with all three, and with the machine's time zone set to three different zones.

## 2. What is never removed

- A job **not in a final state** (`QUEUED`, `PROVIDER_ACCEPTED`, `SENT`, `UNKNOWN`, `NOT_SENT`): still retrying, waiting for a receipt, or waiting for a person to reconcile it. The dry run reports how many old ones there are, by state.
- A job **claimed by a sender** right now; a job with **any attempt that is unresolved (`UNKNOWN`) or newer than the cut-off**; a job whose expiry or due time is newer than the cut-off.
- Events that are **unprocessed**, and the outcomes staff still see as an action list: `AMBIGUOUS_CHILD`, `UNKNOWN_CONTACT`, `UNSUPPORTED_MESSAGE`.
- **Everything else.** The cleanup writes only to `delivery_jobs`, `delivery_attempts`, `communication_events`, its own run table and one audit row per academy. A test records every row of announcements, conversations and other workspace records, finance records and history, e-mail outbox and suppressions, reminders, academies and the approval lifecycle before and after a run and requires them to be identical. Parent-visible announcements (`batch_announcements`) and conversations (`workspace_records`) are separate stores from the delivery jobs: removing a job never removes what a parent can read.
- The e-mail outbox keeps its own, separate rule (finished rows are purged after 90 days; message text is erased once sent). **It is unchanged; if you want e-mail delivery history kept for 12 months as well, that is a one-constant change and your decision.**

## 3. Foreign keys and dependencies (inspected before writing the deletion)

| Relationship                                                        | Consequence                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery_attempts.jobId → delivery_jobs.id` (no cascade)           | attempts are deleted first, in the same transaction; a test lists every foreign key in the schema and fails if a second table ever references `delivery_jobs`, so a new dependency has to be reviewed against this cleanup                                       |
| `delivery_jobs.academyId → academy_workspaces.id`                   | a child, never a parent; academies are not touched                                                                                                                                                                                                               |
| `communication_events`                                              | no foreign keys in either direction                                                                                                                                                                                                                              |
| `delivery_jobs.providerId` unique index                             | protects against a replayed receipt; after 12 months a replay is only ever "unmatched" and harmless                                                                                                                                                              |
| `UNIQUE(academyId, playerId, guardianId, type, period, correction)` | stops a second job for a period. The scheduler only asks for the current week and the previous month, announcements are queued once while they are current, and a reply job lives 24 hours, so no removed job can be recreated for a period older than 12 months |
| Append-only guards (migration 008)                                  | none of these three tables is guarded; the history and audit tables are not touched                                                                                                                                                                              |

## 4. How it runs

`SPORTOZEN_RETENTION=off | report | on` (default **`report`**). The worker (`scripts/communication-worker.ts`) runs it once a day:

- `off`: nothing.
- `report`: counts only, nothing is deleted, one `REPORT` row is recorded. **This is the default so that no data is removed until the owner has read the dry run and chosen `on`.**
- `on`: removes, as below.

Another value stops the run with an error (never a guess).

**Bounded.** One transaction removes at most 500 jobs (and up to 500 events); one run does at most 20 transactions (10,000 jobs); between transactions the process yields. Anything left is removed by the next run; a run that stopped at its limit is recorded `CAPPED`. The oldest records go first, so a partial run never leaves a gap behind a newer record. Cost per batch is an index range scan (`delivery_jobs_retention`, `communication_events_retention`), independent of table size.

**Idempotent.** Running it again removes nothing once the eligible rows are gone.

**Concurrent runs.** A real run takes a lease in `delivery_retention_runs` (120 seconds, renewed with every batch). A second run that finds a valid lease records `SKIPPED` and does nothing. A run that crashed leaves a lease that expires; the next run records it `FAILED ("lease expired")` and carries on. Dry runs never need the lease. Each batch re-selects its rows inside the write transaction, so even without the lease two runs could not remove a row twice or a row that changed.

**Failure.** A batch is all or nothing: if anything fails (a job changed under it, an error), the transaction rolls back, nothing of that batch is lost, the run is recorded `FAILED` with a sanitised message (links and long tokens replaced), and the next run starts again. Tested by making a delete fail.

**Recorded.** `delivery_retention_runs` (kept indefinitely): mode, status, start/finish, cut-off, 12, batches, counts, a JSON summary per academy (counts, oldest and newest due date) and what was held back. One `workspace_audit` row per affected academy ("removed N job(s), M attempt(s) and K webhook event(s) older than <cut-off>", by `system:delivery-retention`). No phone number, name or message text is written anywhere by the cleanup.

## 5. Dry run and command line

```
pnpm retention:run                     # dry run: counts per academy, held-back records, nothing deleted
pnpm retention:run --execute           # remove (re-run until it reports COMPLETED)
pnpm retention:run --json              # machine-readable
pnpm retention:run --batch-size 200 --max-batches 5
```

It acts on the database `SPORTOZEN_DATABASE_PATH` names. **To rehearse, point it at a copy**; it never copies, moves or alters anything but the rows it reports. The dry-run evidence for this change was produced on copies (see the Phase 8 report).

## 6. Migration (014)

Additive: one table (`delivery_retention_runs`) and two partial indexes. No row or column changes. Idempotent. Rollback: drop the indexes and the table. Checked on copies of the seven earlier databases.

## 7. What this does not decide

Archive-before-delete (the earlier proposal suggested an exported, checksummed file; it was not part of the approved decision and is not built, so **removed rows are gone from the live database and survive only in backups**: the hourly/daily/monthly backups keep deleted rows for up to a year, which belongs in the privacy notice); the raw webhook body period; audit and finance retention (never touched); a guardian-erasure feature; e-mail history (above). Switching to `on` in a real deployment is a deliberate step after reading at least one dry run.
