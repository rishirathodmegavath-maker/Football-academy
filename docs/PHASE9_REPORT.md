# Phase 9 report: recurring sessions, session wrap-up and attendance history

**Status: implemented and verified locally. Not deployed, not production ready.** Nothing was committed, pushed, merged or deployed. The Phase 8 snapshot and every earlier patch are unchanged. The application has only run on this machine, with e-mail written to a local folder: no real message was sent and no provider was contacted.

Design details, the permission matrix and the API are in `docs/TRAINING_RECURRENCE.md`; the notice rules are in `docs/EMAIL.md`.

## 1. What was delivered

| # | Feature | Status |
| --- | --- | --- |
| 1 | Session wrap-up (planned vs completed drills, observations, achievements, improvement notes), staff-only | completed, verified |
| 2 | Attendance history per player: percentage, consecutive-absence count, follow-up flag at three | completed, verified |
| 3 | Weekly recurring sessions: weekdays, date range, holidays, preview, single-occurrence and whole-series cancellation, idempotent processing | completed, verified |
| 4 | Cancellation e-mails through the existing outbox: de-duplicated, never dropped at the hourly limit, outcome reported | completed, verified |
| 5 | A cancelled session stays on the parent's schedule, marked cancelled | completed, verified |

All ten approved decisions were applied as written: excused absences neutral for the streak and counted in the percentage; e-mail only; skip rather than shift on clock changes; holidays per series; parents see their own child's history and percentage but never the flag or wrap-up notes; wrap-up optional; owners/admins any squad and coaches only squads they cover with themselves assigned; 26 weeks / 60 sessions; conflicting dates skipped and shown; no migration for idempotency.

### How it reuses the existing module

* A recurring session is an ordinary football session with `seriesId` and `occurrenceDate`. The status transitions, booking conflicts, rosters, attendance (with correction reasons), coach scope and the parent projection are the existing ones.
* The new commands go through the existing `trainingAction`: same origin check, per-user request key, version check, audit and `training_history`.
* `assertBooking` was split into `assertBookable` plus the overlap check, and agenda building and attendance seeding were extracted from the session and copy cases into shared helpers. Existing behaviour is unchanged.
* Notices use the existing e-mail outbox (`SESSION_NOTICE`, which existed but was not yet called).
* Authorization reuses `authorisedSession`, `visibleRecords`, `coachCoversPlayers`, `requirePlayer` and the single `access()` gate (an unapproved academy is closed to all of it).

### Database

**No migration.** The new record kinds `series` and `wrapup` are JSON rows in `workspace_records` (its `kind` column is unconstrained), written with the existing per-record history. Duplicate dates are impossible by that table's primary key and the deterministic occurrence id. Notice de-duplication is a check-and-insert inside the training transaction (the database write lock), proved with separate processes. `data-integrity` gained checks for orphaned or mis-identified occurrences, wrap-ups with no session and cancelled series that still have future sessions.

## 2. Findings made during the work

| Finding | Outcome |
| --- | --- |
| `resolveSessionTime` tried 1,681 offsets per call; a 60-date series took about 3.2 s to preview and 4.7 s to create | **fixed.** It now tries only the offsets in force near the date and verifies each candidate as before. A test keeps the old implementation as a reference and compares both on every clock-change day of 2026 in six zones (London, New York, Lord Howe 30-minute, Chatham 45-minute, Sydney, Casablanca) and on malformed input. Preview 34 ms, create 49 ms. |
| The e-mail outbox returned `null` for invalid, suppressed and rate-limited alike, and silently dropped past 5 per address per hour | **handled.** A checked variant reports the reason; cancellation notices are held back instead of dropped (daily ceiling 20, then refused and reported). `enqueueEmail` itself is unchanged. |
| A cancelled session vanished from a parent's schedule | **changed as approved:** shown, marked cancelled, without the reason, for 24 hours after it would have ended. One existing test asserted the old behaviour and was updated. |
| The calendar screen now loads the `series` kind | one existing browser spec pinned the exact list of kinds; its expectation was updated (it was the single failure of run 1, see section 3). |
| First accessibility audit: one "label in name" violation (history button) and horizontal overflow on a phone (history table) | **fixed** and re-audited clean on the final build. Cancel-scope radios and the wrap-up drill row were also restyled after review of the screenshots. |
| `training_history` is append-only by trigger (my first test cleanup tried to delete from it) | tests use fresh ids; no production change. |
| Mutation check: 5 of 40 survived the first run | 3 were test gaps (a coach who covers the squad but is not assigned was never exercised; one mutation was too weak): **tests added, now caught.** 2 are equivalent mutants (section 4). |

## 3. Verification on the final tree

Run 2 is the complete run on the final code (`evidence/phase9-final-regression-run2.log`). Run 1 (`...run1.log`) is kept as it was: its main browser suite had 74 of 75 passing, the failure being the pinned list of kinds above, and my runner script had a path typo that skipped the Phase 9 browser suite. Both were fixed and the whole regression was run again, not just the affected parts. After run 2 only this report and the evidence files were added.

| Check | Result |
| --- | --- |
| Typecheck | exit 0 |
| Lint | exit 0, 0 errors, 0 warnings |
| Unit and integration | 93 files (92 passed, 1 skipped), **1,555 tests passed**, 4 skipped (the Windows-only skips). Phase 8 had 1,413, so +142: 135 new tests in 6 new files (recurrence, attendance maths, time-resolution equivalence, series service, attendance service, concurrency) plus new cases in existing files |
| Concurrency | 3 tests, each with 4 separate processes acting on one database file at the same instant: exactly one winner, losers get 409, each guardian one notice |
| Production builds | plain, QA, reports: all exit 0 |
| Approval workflow (browser) | 1 of 1 |
| **Phase 9 (browser)** | **9 of 9**: owner creates a series with preview, holiday and a booking conflict; coach scope; parent scope; cancel one date (only that date, each parent e-mailed once, staff reason not in the mail); process again adds nothing; cancel the series (one summary per parent, honest outcome); attendance history and follow-up flag; wrap-up private to staff; phone layout |
| Main browser suite | **75 of 75** |
| Account security / e-mail auth / report review | 2 of 2 / 6 of 6 / 12 of 12 |
| Accessibility (axe-core) | 14 views of the new screens, desktop and phone, on the final build: **0 violations, no horizontal overflow** (`evidence/p9-axe.json`, `evidence/p9-screens/`) |
| Operational (WSL) | release 48, ops-delivery 14, host 6 (the host test needs root for `nft`; as a normal user it fails on kernel permission) |
| Operational (Docker proxy) | **not re-run**: Docker Desktop was not running. `deploy/**` is byte-identical to Phase 8, where it passed 18 of 18 |
| Preflight / secret scan | pass / no secrets found |
| Preservation | the 34 operational and WP8 files are byte-identical to the Phase 8 snapshot; both frozen snapshot manifests have 0 mismatches; all eight earlier patches match their recorded checksums |

## 4. Mutation checking

Forty deliberate breakages (recurrence rules, attendance maths, authorization, cancellation scope, notices, rate-limit handling, parent schedule, time handling, the integrity check) were applied one at a time. **38 were caught.** Two are equivalent mutants, with no observable difference:

* **T5**, scheduling a squad through a plain lookup instead of the coach-scoped one: the next check (`requirePlayer` on every squad player) enforces the same rule.
* **T10**, removing the early "stale series version" check on cancel: the final version-checked save fails the whole transaction, which rolls back every change and every queued notice, with the same 409.

Log: `evidence/p9-mutation-checks.log`.

## 5. Risks and limits

* **Not done, by decision:** editing a series in place; an academy-wide holiday calendar; parent-visible wrap-up; WhatsApp notices; an automatic message when a follow-up flag is raised.
* A held-back cancellation notice is sent by the communication worker. If the worker is not running it waits in the outbox; nothing is lost.
* Wrap-up text and series records are not covered by the 12-month delivery-retention rule (they follow the session).
* A rescheduled occurrence keeps its original `occurrenceDate`; it is the same session and is never regenerated.
* A cancellation e-mail goes to the parent's account address. There is no separate "notification address" preference; adding one is a product decision.
* Not verified: real devices, screen readers, Firefox and WebKit, a real e-mail provider, the Docker proxy test in this round. No production blocker from earlier phases was removed.
* The development server on port 3005 was found not running during this phase. I did not start or stop it; it needs a restart to serve the Phase 8 and Phase 9 code.

## 6. Changed files

**Added (22):** `docs/TRAINING_RECURRENCE.md`, `docs/PHASE9_REPORT.md`, `playwright.training.config.ts`, `src/app/api/workspaces/[academyId]/attendance-history/route.ts`, `src/features/workspaces/attendance-history.tsx`, `src/features/workspaces/recurring-sessions.tsx`, `src/features/workspaces/session-extras.css`, `src/features/workspaces/session-wrapup.tsx`, `src/hooks/use-training-extras.ts`, `src/server/attendance-history-service.ts`, `src/server/session-notices.ts`, `src/services/attendance-history.ts`, `src/services/recurrence.ts`, `src/services/series-rules.ts`, `tests/e2e/phase9-training.spec.ts`, `tests/unit/attendance-history-service.test.ts`, `tests/unit/attendance-history.test.ts`, `tests/unit/helpers/cancel-race.ts`, `tests/unit/notice-concurrency.test.ts`, `tests/unit/recurrence.test.ts`, `tests/unit/resolve-session-time.test.ts`, `tests/unit/training-series.test.ts`.

**Modified (23):** `docs/EMAIL.md`, `playwright.config.ts`, `src/app/api/workspaces/[academyId]/training/route.ts`, `src/domain/training.ts`, `src/features/workspaces/portal-calendar.css`, `portal-calendar.tsx`, `portal-parent-home.tsx`, `portal-training.tsx`, `src/server/data-integrity.ts`, `src/server/email/index.ts`, `src/server/email/outbox.ts`, `src/server/parent-schedule-service.ts`, `src/server/records-query.ts`, `src/server/training-service.ts`, `src/server/workspace-access.ts`, `src/server/workspace-service.ts`, `src/services/training-rules.ts`, `src/services/workspace-profiles.ts`, `tests/e2e/wp2-requests.spec.ts`, `tests/unit/academy-approval.test.ts`, `tests/unit/code-inventory.test.ts`, `tests/unit/portal-scheduling.test.ts`, `tests/unit/security-matrix.test.ts`.

No file was deleted, and no migration, operational script or deploy file was touched.
