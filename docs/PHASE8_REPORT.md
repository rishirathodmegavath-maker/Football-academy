# Phase 8 report: academy approval, 12-month delivery retention, provider-independent e-mail

Written for: the application owner, who decides the open questions in section 9.

Status: **implemented and verified locally on the final tree. Not deployed, not production ready, and nothing here has been validated on a real device, with a real mailbox, a real provider or real data.** Phase 7 (`phase7-final-snapshot`) and every earlier patch are unchanged.

## 1. Result in one table

| #   | Workstream                                                                                                                         | Classification                                                                                                                                                      | Where                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Academy approval workflow (mandatory platform-admin approval, restricted onboarding access, queue, decisions, history, suspension) | **Completed** and **Verified** (unit, API, browser, axe)                                                                                                            | `docs/ACADEMY_APPROVAL.md`              |
| 2   | 12-month delivery-history retention (dry run, bounded, idempotent, concurrent-safe, recorded)                                      | **Completed** and **Verified** on isolated databases. **The setting that actually deletes (`SPORTOZEN_RETENTION=on`) is off by default; switching it on is yours.** | `docs/DELIVERY_RETENTION.md`            |
| 3   | Provider-independent e-mail architecture (interface, registry, generic webhook, local transports, mocked provider tests)           | **Completed** and **Verified** against mocked providers. **No real provider is selected or tested.**                                                                | `docs/EMAIL.md` section 0               |
| 4   | WP8 scope                                                                                                                          | **Preserved**: no operational script was touched (checksums in section 6)                                                                                           | `docs/WP8_OPEN_FINDINGS.md`             |
| 5   | Full regression on the final tree                                                                                                  | **Verified** (section 5)                                                                                                                                            | `evidence/phase8-final-regression*.log` |
| 6   | Real devices, a real mailbox, a real provider, a penetration test, Firefox/WebKit end-to-end suites                                | **Requires real-device / manual validation** or **Deferred until deployment** (section 8)                                                                           |                                         |

Where each requested deliverable is:

| Deliverable                                                                                                                                                                                                            | File                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Academy approval implementation report; approval state-transition documentation; role and permission matrix; database migration details                                                                                | `docs/ACADEMY_APPROVAL.md` (sections 1, 3 and 6) and section 2 here |
| Delivery retention implementation report; the policy and its technical behaviour; foreign keys                                                                                                                         | `docs/DELIVERY_RETENTION.md` and section 3 here                     |
| Retention dry-run evidence                                                                                                                                                                                             | `evidence/p8-retention-rehearsal.txt` (section 3)                   |
| Provider-independent e-mail architecture; adapter interface; local development; provider selection procedure; environment variables; webhook requirements; delivery tracking; retry behaviour; future production steps | `docs/EMAIL.md` section 0 (and sections 4, 10 to 13 and 16)         |
| Complete test results                                                                                                                                                                                                  | section 5 and `evidence/`                                           |
| Remaining risks and limitations                                                                                                                                                                                        | section 8                                                           |
| Changed-file inventory; reproducible patch; SHA-256                                                                                                                                                                    | sections 7 and 10                                                   |

## 2. Academy approval

Built exactly as `docs/ACADEMY_APPROVAL.md` describes; the points that matter for a decision:

- **States**: CONFIGURING, SUBMITTED, PENDING_REVIEW, ACTIVE, REJECTED, SUSPENDED. REGISTRATION is a history event, RESUBMITTED is SUBMITTED with a resubmission count, and APPROVED/ACTIVE are one state (approval is the decision, ACTIVE the result): no state was added where an equivalent already existed. `CONFIGURING` and `ACTIVE` are the two values the product already used.
- **Enforced on the server**, in the single access check every academy request already passes. Default-deny: a route added tomorrow is closed to unapproved academies until it is deliberately opened. A test calls **every route and every method** under an academy against a new academy and requires `ACADEMY_NOT_APPROVED` on all but the four onboarding routes.
- **A reviewer's decision is safe to race**: version-guarded, one transaction with its history row, entitlement change and audit entry. Two simultaneous decisions: one wins, one gets 409 (tested). An administrator cannot decide an academy they belong to.
- **Existing academies**: migration 013 records an academy whose entitlement is ACTIVE as ACTIVE and every other one as SUSPENDED, each with a `MIGRATED` history row by `system:migration-013`. This is the explicit rule; it is a decision of mine that you should confirm (section 9, item 1).
- **Platform Admin vs Owner**: separate tables and separate checks; an owner is refused every platform route; a platform administrator has no academy role and sees no child data.

## 3. Delivery-history retention

- Removes `delivery_jobs` in a final state whose **lifecycle end** (latest of due time, expiry, last attempt) is **strictly older than 12 months in UTC**, their `delivery_attempts` (children first, foreign key), and processed `communication_events` older than 12 months except the three outcomes staff still act on.
- Never removes non-final jobs, claimed jobs, jobs with an unresolved or recent attempt, malformed timestamps, unprocessed events, or **anything outside those three tables**: a test compares every row of announcements, conversations, finance, history, audit, e-mail and the approval lifecycle before and after.
- 500 jobs per transaction, 20 transactions per run, oldest first, a lease against two runs at once, a crashed run's lease expires, a failed batch rolls back whole, each run recorded in `delivery_retention_runs` and in one audit row per academy.
- **Default `SPORTOZEN_RETENTION=report`**: counts only. The dry-run evidence below was produced on an isolated copy.

Rehearsal on an isolated copy of a local database (`evidence/p8-retention-rehearsal.txt`; the copy was made from a copy, no original database was opened for writing): 112 synthetic jobs and 5 webhook events were added around the 12-month line (80 jobs 13 months old, 20 jobs 11 months old, and the protected cases: old but QUEUED, SENT, UNKNOWN, claimed, with a recent attempt, an old announcement job; events old and processed, old and routed, old but unresolved, new, and unprocessed).

| Step                           | Result                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dry run (`pnpm retention:run`) | would remove **82 jobs, 80 attempts, 2 events**; held back: non-final old jobs `{QUEUED 2, SENT 2, UNKNOWN 2}`, 4 in flight, 2 open events; **nothing deleted** (112 jobs before and after) |
| Real run, 1 batch of 50        | removed 50 jobs, 48 attempts, 2 events, status `CAPPED` (per-run limit)                                                                                                                     |
| Real run to completion         | removed 32 jobs, 32 attempts: **82 / 80 / 2 in total, exactly what the dry run predicted**                                                                                                  |
| Real run again                 | removed 0 (idempotent)                                                                                                                                                                      |
| Left                           | 30 jobs: 20 newer than the line, and the 10 protected ones (2 QUEUED, 2 SENT, 2 UNKNOWN, 2 claimed, 2 with a recent attempt)                                                                |
| Unrelated stores               | announcements 0 to 0, conversations 2 to 2, finance records 6 to 6; audit rows 231 to 235 (appended, never removed)                                                                         |

The exact-at-the-boundary case cannot be hit with the real clock; it is tested with an injected clock: a job one millisecond older than the cut-off is removed, one exactly at it and one one millisecond newer are kept (`tests/unit/delivery-retention.test.ts`).

## 4. Provider-independent e-mail

- One interface (`EmailProvider`: transport + optional webhook adapter + required variables + kind), one registry, one generic webhook route (`/api/email/webhooks/<provider>`), and the existing outbox, templates, tracking and suppression untouched in behaviour. Postmark remains as the only built-in real adapter and is now one registry entry in its own file; **no business code names a provider** (a test enforces it).
- A provider that does not exist anywhere in the product is registered in the tests and driven through configuration, the outbox, retries, delivery tracking and the webhook route: this is the evidence that adding a provider is one file and one registry line.
- **Not implemented, deliberately**: Zoho ZeptoMail and Zoho Mail. Their API contract has not been verified from an account and the two ZeptoMail hosts in Zoho's own pages disagree. `docs/EMAIL.md` section 16 lists what to verify first, and says Zoho Mail's suitability for transactional mail has not been assessed.
- New messages through the same outbox: academy submitted (to platform administrators), approved, rejected with the reviewer's reason, suspended, reactivated (to the owner). Best effort; they never delay a decision.

## 5. Verification on the final tree

Two complete runs of the whole chain on the final tree (`evidence/phase8-final-regression-run1.log`, `-run2.log`), plus targeted re-runs. The first run found real problems, listed here because they are part of the result.

| Check                                                                   | Result                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck, ESLint                                                       | exit 0 and 0 errors, 0 warnings in both runs                                                                                                                                                                                                                                                                                   |
| Unit and integration                                                    | **run 2: 86 files passed, 1 skipped; 1,413 tests passed, 4 skipped** (Phase 7: 1,307; +106 tests). Run 1: 1,411 passed, 2 failed (see below)                                                                                                                                                                                   |
| Production builds: plain, QA, reports                                   | exit 0 in both runs; the same 3 warnings as Phase 7                                                                                                                                                                                                                                                                            |
| Approval workflow in a real browser (no auto-approval)                  | 1 of 1 passed in both runs                                                                                                                                                                                                                                                                                                     |
| Main browser suite                                                      | run 1: 73 of 76, 3 failed (see below); run 2: 74 of 75, 1 failed with `ECONNRESET` on a read, passed alone in 49.9 s; **run 3: 75 of 75 passed (28.7 min), `evidence/phase8-main-e2e-run3.log`**                                                                                                                               |
| Account security / e-mail and authentication / monthly report review    | 2 / 6 / 12 passed in both runs                                                                                                                                                                                                                                                                                                 |
| Build preflight, secret scan                                            | pass; no secrets found                                                                                                                                                                                                                                                                                                         |
| Migration of the seven older databases (copies)                         | all open on migrations 013 and 014; integrity ok, 0 foreign-key violations, no table lost, no existing table's data changed, second open stable, **original files untouched**; every academy recorded ACTIVE (all had an ACTIVE entitlement), 0 without a lifecycle row, 0 disagreements (`evidence/p8-migration-report.json`) |
| WSL Ubuntu: release and rollback / ops delivery / host hardening (root) | 48 / 14 / 6 checks, all passed. Docker nginx proxy: 18 checks, passed                                                                                                                                                                                                                                                          |
| axe-core on the new pages (12 page-views, 1366 and 390 wide)            | 0 violations on 12 page-views (the owner's approval page set up, rejected with feedback and submitted; the platform queue; an open application; an open application showing the empty-reason error; each at 1366 and 390 px wide) and no horizontal overflow                                                                   |
| Deliberate breakages (mutation checks)                                  | **38 applied, 37 caught**; the survivor is a redundant guard no caller can reach (`move()` rejecting a wrong actor kind), so the tests cannot fail it from outside (`evidence/p8-mutation-checks.log`)                                                                                                                         |

**Failures found and what they were:**

1. Run 1, unit: `home-summary` "bootstrap reads nothing extra" expected 0 queries and saw 1, because the test builds its context by hand without the approval state that `access()` already reads. The service is correct (a real request adds no query); the test helper now supplies the state as `access()` does.
2. Run 1, unit: `ops-review-fixes` "many processes trying at the same instant" failed on a timing assertion in the unchanged WP8 lock code. I was running the WSL harnesses at the same moment; on the quiet second run it passed, as it did in both Phase 7 runs. I did not investigate further and did not change that code.
3. Run 1, browser: `phase6-isolation` and `workspaces` still paused an academy through the entitlement route or the old "Pause entitlement" button, both removed on purpose (a suspension now needs a reason). Both specs now use the decision API and the new review console; they pass.
4. Run 1, browser: the new approval spec was picked up by the main suite, which has no server for it. It is now excluded there and runs under its own configuration.
5. Run 2, browser: `trial-enrolment` hit `ECONNRESET` on a read from the test server, with no server error logged and no assertion failed. It passed alone, and the whole suite passed in run 3. A connection reset on a keep-alive socket is the likely cause; I did not prove it.

Not run: Firefox and WebKit browser suites, a real device, a real screen reader, a real mailbox or provider, any live service. The three-engine overflow sweep of Phase 7 was not repeated for the new pages (Chromium only, at two widths).

## 6. Preserved, unchanged

- **WP8 / operational files**: 33 files (`scripts/ops-check.mjs`, `ops-alert.mjs`, `lib/ops.mjs`, the backup, restore and preflight scripts, and everything under `deploy/`) are byte-identical to the Phase 7 snapshot. The five WP8 findings stay open in `docs/WP8_OPEN_FINDINGS.md`; only a decision line was added to that document.
- **Frozen snapshot**: `D:\Sportozen\phase7-final-snapshot` (811 files) re-verified against its manifest: 0 mismatches.
- **Earlier patches**: Phase 5, 6 and 7 patches (incremental and cumulative) re-verified against their recorded SHA-256 values; none overwritten.
- **Original databases and protected workspaces**: not opened for writing. The migration check and the retention rehearsal ran on copies, and the source files' sizes and modification times were compared before and after.
- Nothing was committed, pushed, merged, deployed, reset, stashed or cleaned. The user's development server (port 3005) was never stopped.

## 7. Changed-file inventory

55 modified, 29 added, 1 deleted:

```
A docs/ACADEMY_APPROVAL.md
M docs/ACADEMY_APPROVAL_PROPOSAL.md
M docs/DELIVERY_DATA_RETENTION.md
A docs/DELIVERY_RETENTION.md
M docs/EMAIL.md
M docs/ONBOARDING.md
M docs/OPERATIONS.md
A docs/PHASE8_REPORT.md
M docs/WP8_OPEN_FINDINGS.md
M package.json
M playwright.account-security.config.ts
A playwright.approval.config.ts
M playwright.config.ts
M playwright.email-auth.config.ts
M scripts/communication-worker.ts
A scripts/delivery-retention.ts
A scripts/lib/qa-approve.ts
M scripts/qa-bharat-simulation.ts
M scripts/qa-monthly-report-review.ts
A src/app/api/email/webhooks/[provider]/route.ts
D src/app/api/email/webhooks/postmark/route.ts
A src/app/api/platform/applications/[academyId]/decision/route.ts
A src/app/api/platform/applications/[academyId]/route.ts
A src/app/api/platform/applications/route.ts
M src/app/api/workspaces/[academyId]/bootstrap/route.ts
A src/app/api/workspaces/[academyId]/lifecycle/route.ts
M src/app/api/workspaces/[academyId]/route.ts
M src/app/platform/page.tsx
M src/app/workspace/[academyId]/page.tsx
A src/domain/academy-lifecycle.ts
M src/domain/home-summary.ts
A src/features/workspaces/academy-approval.css
A src/features/workspaces/academy-approval.tsx
M src/features/workspaces/academy-form.tsx
M src/features/workspaces/academy-portal.tsx
M src/features/workspaces/platform-accounts.tsx
A src/server/academy-lifecycle-state.ts
A src/server/academy-lifecycle.ts
M src/server/batch-announcement-service.ts
M src/server/communication-service.ts
M src/server/communication-worker.ts
M src/server/data-integrity.ts
M src/server/database.ts
A src/server/delivery-retention.ts
M src/server/email/config.ts
M src/server/email/events.ts
M src/server/email/index.ts
A src/server/email/postmark.ts
M src/server/email/templates.ts
M src/server/email/transport.ts
A src/server/email/types.ts
A src/server/email/webhook.ts
M src/server/finance-service.ts
M src/server/membership-service.ts
A src/server/migrations/013-academy-lifecycle.ts
A src/server/migrations/014-delivery-retention.ts
M src/server/platform-service.ts
M src/server/trial-service.ts
M src/server/workspace-access.ts
M src/server/workspace-service.ts
A tests/e2e/global-setup-approved.ts
A tests/e2e/helpers/auto-approve.ts
M tests/e2e/phase6-isolation.spec.ts
A tests/e2e/phase8-approval.spec.ts
M tests/e2e/workspaces.spec.ts
A tests/unit/academy-approval.test.ts
M tests/unit/academy-player-configuration.test.ts
M tests/unit/batch-announcements.test.ts
M tests/unit/code-inventory.test.ts
M tests/unit/data-integrity.test.ts
A tests/unit/delivery-retention.test.ts
M tests/unit/email-global.test.ts
A tests/unit/email-providers.test.ts
M tests/unit/finance.test.ts
M tests/unit/helpers/api-harness.ts
A tests/unit/helpers/lifecycle.ts
M tests/unit/helpers/reset-tables.ts
M tests/unit/invitations.test.ts
M tests/unit/period-communication.test.ts
M tests/unit/platform-support.test.ts
M tests/unit/portal-scheduling.test.ts
M tests/unit/rate-limit-routes.test.ts
M tests/unit/route-authentication.test.ts
M tests/unit/security-matrix.test.ts
M tests/unit/trials.test.ts
```

## 8. Risks, limits and what was not done

- **Not production ready.** The remaining production blockers from earlier phases are unchanged: a server, a domain, an alert destination, an external uptime probe, off-server backups, a tested e-mail provider, and a test on real devices.
- **No real device, screen reader, mailbox or provider** was used. Accessibility is axe-core clean on the new pages (0 violations on 12 page-views (the owner's approval page set up, rejected with feedback and submitted; the platform queue; an open application; an open application showing the empty-reason error; each at 1366 and 390 px wide) and no horizontal overflow), which is not a substitute for a person using a screen reader.
- **The browser suites for the operational features run in a test database that approves new academies by a trigger** (`tests/e2e/helpers/auto-approve.ts`), because they create academies through the API and then use them. The product has no such switch. The real workflow is tested by its own suite, `phase8-approval.spec.ts`, which runs without the trigger.
- **Removed delivery rows are gone from the live database.** No archive step was built (it was not part of the decision); backups keep deleted rows for as long as they are retained (up to a year with the default policy), which belongs in the privacy notice.
- **E-mail history is still purged at 90 days** (the existing rule); only delivery jobs and WhatsApp events follow the 12-month rule. Your decision if you want the two aligned.
- A unit that defends an invariant that no caller can reach, `move()`'s actor check, is the one mutation the tests do not catch (it is redundant with the callers); the other 37 are caught.
- Stale generated type files from earlier QA builds (`.next-*-qa/types`) referenced the removed `/api/email/webhooks/postmark` route and made `tsc` and `next build` fail until they were regenerated; they are build output, not source, and the QA builds recreate them.
- `SPORTOZEN_RETENTION` is validated when the worker runs it, not at start-up or by the preflight; a typo is logged daily and nothing is removed.
- Concurrency is exercised in one process (two overlapping runs) and by a transaction-level guard; SQLite's single-writer lock is what makes two real processes safe, which was reasoned and not separately load-tested.

## 9. Decisions and approvals that remain with you

1. **Existing academies.** I applied: ACTIVE entitlement becomes ACTIVE, anything else SUSPENDED, recorded as `MIGRATED`. The alternative is to put them in SUBMITTED, which closes every existing academy until a reviewer acts. Please confirm before any real data is migrated.
2. **Invitations are closed until approval** (the brief's "may" list did not include them). Say if staff invitations should be allowed in the onboarding phase.
3. **What must be complete before submitting.** Today only what the form already requires plus one module; location, phone, description, logo and website are shown as progress. Tell me which become mandatory.
4. **Documents.** No document requirement exists, so none was built.
5. **Suspended academies stay fully closed** (as a paused one always was). Say if a suspended owner should be able to read or export.
6. **Retention**: switch `SPORTOZEN_RETENTION` to `on` after reading at least one dry run in the real environment; decide whether e-mail history should also be 12 months; decide whether an archive step is wanted before deletion.
7. **Provider**: still unselected. When you choose, the procedure is `docs/EMAIL.md` section 0.
8. **A second approver** (two-person approval) and **a reminder for applications that wait too long** are not built.

## 10. Patches and checksums

The patches and their SHA-256 checksums are in the delivery copy of this report (`phase5-delivery/PHASE8_REPORT.md`): a file cannot contain its own checksum.
