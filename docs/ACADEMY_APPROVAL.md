# Academy approval workflow

Status: **implemented and tested locally. Not deployed.** Approved decision: every newly registered academy needs a Platform Admin's approval before it can run operations. This document replaces the earlier proposal (`ACADEMY_APPROVAL_PROPOSAL.md`), which stays as the record of the options that were considered.

Written for: the application owner, and whoever reviews or operates the platform.

## 1. Lifecycle and state transitions

The states use the words already in the product. `CONFIGURING` and `ACTIVE` are the two values `onboardingStatus` always had; nothing was added where an equivalent existed.

| Approved vocabulary    | Stored as                      | Notes                                                                                                                                     |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| REGISTRATION           | history action `REGISTERED`    | A moment, not a state: an academy cannot exist unregistered. Written by `createAcademy`.                                                  |
| CONFIGURING            | `CONFIGURING`                  | The owner completes the profile.                                                                                                          |
| SUBMITTED FOR APPROVAL | `SUBMITTED`                    | Waiting for a platform administrator.                                                                                                     |
| PENDING REVIEW         | `PENDING_REVIEW`               | An administrator opened the application ("Start review") and the decision is pending.                                                     |
| APPROVED → ACTIVE      | `ACTIVE`                       | Approval is the decision (history action `APPROVED`); nothing can happen between approving and operating, so there is one state, not two. |
| REJECTED               | `REJECTED`                     | Reason mandatory; the owner may edit and resubmit.                                                                                        |
| RESUBMITTED            | `SUBMITTED`, `submissions` > 1 | The same state, flagged "resubmitted" in the queue; history action `RESUBMITTED`.                                                         |
| SUSPENDED              | `SUSPENDED`                    | Reason mandatory; reversible.                                                                                                             |

```
 create ─► CONFIGURING ──submit (owner)──► SUBMITTED ──start review (admin)──► PENDING_REVIEW
               ▲                               ▲                                │      │
               │                               │ resubmit (owner)       approve │      │ reject (reason)
               │                               └──────────── REJECTED ◄─────────┼──────┘
               │                                                                ▼
               └── (an edit during review makes a decision on the old version stale)  ACTIVE ◄─reactivate─ SUSPENDED
                                                                                    └───suspend (reason)────►┘
```

| Action        | From                  | To             | Who                    | Reason                           | History label           | Also                                                                      |
| ------------- | --------------------- | -------------- | ---------------------- | -------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `submit`      | CONFIGURING, REJECTED | SUBMITTED      | the academy OWNER      | none                             | SUBMITTED / RESUBMITTED | needs the required checklist items; e-mails the platform administrators   |
| `startReview` | SUBMITTED             | PENDING_REVIEW | platform administrator | optional note                    | REVIEW_STARTED          | records the reviewer                                                      |
| `approve`     | PENDING_REVIEW        | ACTIVE         | platform administrator | optional note                    | APPROVED                | e-mails the owner                                                         |
| `reject`      | PENDING_REVIEW        | REJECTED       | platform administrator | **required, 10-1000 characters** | REJECTED                | e-mails the owner with the reason                                         |
| `suspend`     | ACTIVE                | SUSPENDED      | platform administrator | **required**                     | SUSPENDED               | sets the entitlement to PAUSED in the same transaction; e-mails the owner |
| `reactivate`  | SUSPENDED             | ACTIVE         | platform administrator | optional note                    | REACTIVATED             | entitlement back to ACTIVE; e-mails the owner                             |

Every other (state, action) pair is refused with 409 `INVALID_TRANSITION`. The table is one object (`TRANSITIONS`, `src/domain/academy-lifecycle.ts`); a test writes the whole 6 x 6 grid out and fails if any pair changes.

Rules that make a transition safe:

- **One transaction.** The state change, the entitlement change (suspend/reactivate), the history row and the academy's own audit entry are written together or not at all.
- **Version guard.** Every decision carries the `expectedVersion` the reviewer saw. The update is `... WHERE version=? AND state=?`; a second reviewer deciding the same application, a double click, or a decision on an application the owner has edited since, gets 409 `STALE_VERSION`. Two simultaneous decisions: exactly one succeeds (tested).
- **Edits during review.** Editing is never blocked, so the owner is never locked out; an edit while `SUBMITTED` or `PENDING_REVIEW` advances the version, so a decision made on the earlier profile is refused and the reviewer must look again.
- **Separation of duties.** An administrator who is a member of the academy (owner, admin, coach or parent; a temporary support grant does not count) cannot decide it (403 `CONFLICT_OF_INTEREST`).
- **Fail closed.** An academy with no lifecycle row is not operational.

## 2. What an unapproved academy can and cannot do

Enforced on the server in `access()` (`src/server/workspace-access.ts`). The default scope is **operational**, so **a route added tomorrow is closed to unapproved academies until someone deliberately opens it**. The screen only stops offering the buttons; the server is the control.

| Allowed (scope `onboarding`)                                             | Route                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| See the approval status, checklist, progress and the reviewer's feedback | `GET /api/workspaces/{id}/lifecycle`                             |
| Submit or resubmit (owner only)                                          | `POST /api/workspaces/{id}/lifecycle`                            |
| Update the academy profile (owner or admin)                              | `PATCH /api/workspaces/{id}`                                     |
| Open the shell                                                           | `GET /api/workspaces/{id}/bootstrap`, the `/workspace/{id}` page |

Everything else under `/api/workspaces/{id}` answers 403 with `code: ACADEMY_NOT_APPROVED`: records (players, batches/squads, sessions, attendance, evidence, plans, reports, updates, conversations), training, finance and its PDFs, trials, periods, places, communication and its announcements and delivery list, player messages, home, actions (including invitations and support grants), invitations. A test calls **every route and every method** under `/api/workspaces/{id}` against a new academy and fails if any answers anything but `ACADEMY_NOT_APPROVED` except the four above.

Also closed to a non-operational academy, outside a request: the communication worker (no scheduling, drafts or WhatsApp), batch-announcement and finance re-checks, trial enrolment and **accepting an invitation** (`academyOperational()`, the one helper that replaced six separate entitlement checks; a test keeps it that way).

Choices made where the brief was silent (each can be changed in one place):

1. **Invitations are closed before approval.** The brief lists what an unapproved academy _may_ do and inviting is not on it; it protects children's data and sender reputation. Sent invitations to an academy that is not open cannot be accepted.
2. **Documents are not built.** "Upload required academy documents, if applicable": no document requirement has been defined, so nothing was invented. When one is, it is a new onboarding route and a checklist item.
3. **What must be complete before submitting** (`onboardingChecklist`, `src/server/academy-lifecycle.ts`): required are the items the academy form already makes mandatory plus "at least one module"; optional and shown as progress are location, phone, description, logo, website. A normally created academy can therefore always submit. **Which optional items should be mandatory is a decision for the owner**: flip `required` on the item.
4. **Suspended = fully closed**, as a paused academy always was (members get 403 and the "currently suspended" message); the reason is in the history and e-mailed to the owner. Letting a suspended owner read or export is a separate decision.
5. **The entitlement route no longer pauses or resumes.** `PATCH /api/platform/accounts` still changes tier and modules; changing `status` answers 400 `USE_DECISION`, because a suspension needs a reason and a history entry. Repeating the current status is accepted.
6. **One operator setting, `SPORTOZEN_ACADEMY_APPROVAL`.** Since 23 Nov 2026 (owner decision) the default is a direct opening: unset, or any value other than `required`, approves a new academy in the same transaction that creates it: its state is `ACTIVE`, its history shows `REGISTERED` and then `APPROVED` by `SYSTEM` ("Approved automatically: this deployment does not require a platform review"), and it never enters the review queue. `SPORTOZEN_ACADEMY_APPROVAL=required` (exactly that word) switches the platform review described in this document back on. Only the person who runs the server can set it; nothing a user sends can change it. It affects academies created after it is set; existing ones keep their state. Suspension and reactivation by a platform administrator still work on a directly approved academy. The browser test suites pin the setting to `required` in their own configs; they run against a throw-away database in which a trigger approves new academies (`tests/e2e/helpers/auto-approve.ts`) so they can test the operational features, and the real workflow has its own suite (`phase8-approval.spec.ts`) with no such trigger.

## 3. Role and permission matrix

`-` = refused. Rows are what the caller may do; unauthenticated callers get 401 on all of them.

| Action                                | Owner (any state)           | Admin            | Coach / Parent   | Another academy's member | Platform administrator | Platform admin who belongs to that academy |
| ------------------------------------- | --------------------------- | ---------------- | ---------------- | ------------------------ | ---------------------- | ------------------------------------------ |
| Read approval status                  | yes (full, with feedback)   | yes (full)       | state only       | -                        | - (uses the queue)     | -                                          |
| Edit academy profile while unapproved | yes                         | yes              | -                | -                        | -                      | -                                          |
| Submit / resubmit                     | yes (CONFIGURING, REJECTED) | -                | -                | -                        | -                      | -                                          |
| Use operational features              | only when ACTIVE            | only when ACTIVE | only when ACTIVE | -                        | - (no academy role)    | -                                          |
| List / open applications              | -                           | -                | -                | -                        | yes                    | yes                                        |
| Start review, approve, reject         | -                           | -                | -                | -                        | yes                    | - (`CONFLICT_OF_INTEREST`)                 |
| Suspend, reactivate                   | -                           | -                | -                | -                        | yes                    | - (`CONFLICT_OF_INTEREST`)                 |
| Change tier / modules                 | -                           | -                | -                | -                        | yes                    | yes                                        |

The platform administrator is a row in `platform_administrators` (two-step verification is required when the policy asks for it). It is not an academy role and grants no access to academy data; a reviewer sees the submitted profile and the owner's name, **never player, guardian or finance data**.

## 4. API

| Route                                                 | Method                                      | Who            | Purpose                                                          |
| ----------------------------------------------------- | ------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `/api/workspaces/{id}/lifecycle`                      | GET                                         | member         | status; owner/admin also checklist, feedback, history            |
| `/api/workspaces/{id}/lifecycle`                      | POST `{action:"submit", expectedVersion}`   | owner          | submit / resubmit                                                |
| `/api/platform/applications?state=&q=&limit=&offset=` | GET                                         | platform admin | the queue: waiting first, oldest first                           |
| `/api/platform/applications/{id}`                     | GET                                         | platform admin | profile, checklist, owners, full history with reviewer and times |
| `/api/platform/applications/{id}/decision`            | POST `{decision, reason?, expectedVersion}` | platform admin | startReview, approve, reject, suspend, reactivate                |
| `/api/platform/accounts`                              | GET / PATCH                                 | platform admin | unchanged, plus `lifecycle` fields; no pause/resume              |

Writes need the same origin and are rate-limited per user like every other write. Errors carry a stable `code`: `ACADEMY_NOT_APPROVED`, `STALE_VERSION`, `INVALID_TRANSITION`, `INCOMPLETE`, `CONFLICT_OF_INTEREST`, `USE_DECISION`.

## 5. Screens

- **Owner** (`/workspace/{id}` while not ACTIVE): application status and what it means, the reviewer's feedback in a labelled block, onboarding progress (done/to do and required/optional as text, not colour), the academy profile form, "Submit for approval" / "Resubmit for approval", and the history. The status loads separately and every error is announced (`role="alert"`).
- **Platform administrator** (`/platform`): the queue with a filter, an "Open" button per application, then the submitted profile, checklist, the reason box with a live character count, the actions that are allowed in the current state, and the history (who, what, when, profile version). A suspension asks for confirmation.
- Parents and coaches of an academy that is not open see "This academy is not open yet."

## 6. Database migration (013)

Inspected first: `academy_workspaces(id, config)` holds a JSON `onboardingStatus` (`CONFIGURING`/`ACTIVE`) that nothing read or changed; `platform_entitlements.status` (`ACTIVE`/`PAUSED`) was the only gate; `platform_administrators(userId)`; audit in `workspace_audit`. The safest migration is **additive** and does not touch any of them.

`src/server/migrations/013-academy-lifecycle.ts`: two new tables, one index, two triggers. No existing table, column or row changes.

- `academy_lifecycle(academyId PK -> academy_workspaces, state CHECK in the six states, version, submissions, submittedAt, reviewerId, reviewStartedAt, decidedAt, decidedBy, reason, updatedAt)`; index `(state, submittedAt)` for the queue.
- `academy_lifecycle_history(id, academyId, fromState, toState, action, actorId, actorKind OWNER|PLATFORM|SYSTEM, reason, configVersion, at)`, **append-only** (a trigger refuses UPDATE and DELETE).
- **The explicit rule for academies that already exist** (nothing is approved by accident): an academy whose entitlement is `ACTIVE` is recorded `ACTIVE`, and every other academy (`PAUSED`, or no entitlement) is recorded `SUSPENDED`, so it stays exactly as open or closed as it was. Each gets a history row `MIGRATED` by `system:migration-013`, so the record shows no reviewer decided it. The queue marks them "existed before approval was required"; a platform administrator can suspend any of them. **This is the rule I applied; if you would rather have existing academies reviewed, the alternative is to start them in `SUBMITTED`, which closes them until a reviewer acts. That is a one-line change in the migration and needs your decision before any real data is migrated.**
- Idempotent (only academies with no row), safe if two processes start together (one IMMEDIATE transaction), never overwrites a later decision.
- `onboardingStatus` in the JSON is no longer read: the value shown is derived from the lifecycle (`ACTIVE` only when ACTIVE).
- **Rollback**: drop the two triggers and the two tables; nothing else refers to them except the code. Run on copies of the seven earlier databases: see the report.

## 7. Notifications

Queued through the e-mail outbox (provider independent, `docs/EMAIL.md`): to the platform administrators on a submission or resubmission, to the owner on approval, rejection (with the reason), suspension and reactivation. They are best effort: a decision never waits for or fails because of a message, nothing is sent while e-mail is disabled, and the in-app status is always the source of truth. The reviewer's text is HTML-escaped and kept out of the subject.

## 8. Tests

`tests/unit/academy-approval.test.ts` (34): the full state grid; the migration on a synthetic database (ACTIVE / PAUSED / odd status / no entitlement, idempotence, append-only history, closed vocabulary, fail closed); a new academy starts CONFIGURING with a REGISTERED record; **every route and method refuses an unapproved academy**; owner vs admin vs stranger; invitation acceptance refused; submit once, stale version, wrong body, wrong origin; the queue order and filters; the profile and history without child data; approve through review with reviewer and times; reject needs a real reason, the owner sees it, resubmit, approve; an edit during review makes a decision stale; two simultaneous decisions (one wins); separation of duties; suspend/reactivate with the entitlement; every non-administrator refused; isolation between academies; the legacy route; notices. `tests/e2e/phase8-approval.spec.ts`: the same journey in a browser. Mutation checks are listed in the Phase 8 report.

## 9. Not done / decisions that remain

- Document upload (no requirement defined). Which optional profile fields become mandatory. Whether an existing academy should be re-reviewed. Whether a suspended owner may read or export. A second approver (two-person approval) is not built. How long an application may wait before a reminder (no reminder exists). Who the platform administrators are (`node scripts/platform-admin.mjs <email>` assigns one).
- No real e-mail was sent and no provider was configured.
