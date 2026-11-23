# Academy approval workflow: proposal for decision

Status: **superseded.** The owner decided that approval by a platform administrator is mandatory, and it is implemented: see `ACADEMY_APPROVAL.md`. What follows is the original proposal, kept as the record of the options that were considered (option A, B or C in section 5 was decided in favour of a stricter variant than A: invitations are also closed until approval). The original status line read: **proposal only. No code, schema or behaviour was changed for it.** It needs the owner's decisions (section 8) before anything is built, because it changes who can do what in a new academy and what a platform administrator is responsible for.

Written for: the application owner, who decides the business rules.

## 1. What exists today (verified in the code)

- **Creating an academy** (`createAcademy`, `src/server/workspace-service.ts`) is open to any signed-in person. In one transaction it stores the configuration with `onboardingStatus: "CONFIGURING"`, makes the creator the OWNER, creates the platform entitlement `LOCAL_FOUNDATION` / `ACTIVE` with the chosen modules, and writes one audit row ("Academy created; empty workspace"). **The academy is usable immediately**: the owner can invite coaches and parents and use every enabled module.
- **`onboardingStatus`** (`"CONFIGURING" | "ACTIVE"`) lives inside the academy's configuration JSON. **Nothing ever changes it** and **nothing reads it for any decision**; the platform screen only prints it. (Test fixtures set it to `ACTIVE` by hand.)
- **The real gate** is the entitlement `status` (`ACTIVE` | `PAUSED`, `platform_entitlements`). Every academy request checks it (`src/server/workspace-access.ts`); a paused academy answers 403 to its owner, coaches and parents, and not to other academies (tested in `tests/e2e/phase6-isolation.spec.ts` and `tests/unit/security-matrix.test.ts`).
- **The platform administrator** (a row in `platform_administrators`, MFA required when MFA is on) can list all academies, **pause or resume** one, and change tier and modules (`GET/PATCH /api/platform/accounts`). The change is audited, in the academy's own audit trail. There is no queue, no reasons, no decision history and no notification.
- **Email** exists as one service that is disabled until the provider is configured (`docs/EMAIL.md`); until then any notification must also be visible in the application.

So the gap is exactly this: there is no step at which anyone but the creator decides that an academy may operate, and no record of why an academy was stopped.

## 2. Proposed states and transitions

Stored in a **new table, not in the configuration JSON**, so that it is separately audited, has its own version for concurrency, and cannot be changed by an academy owner through the settings screen.

```
                 owner submits                 platform admin approves
   DRAFT  ───────────────────────►  SUBMITTED ───────────────────────►  APPROVED ◄──────┐
     ▲                                  │  │                                │  │         │ reactivate
     │ owner edits                      │  └─ owner withdraws ─► DRAFT      │  └─ suspend ─► SUSPENDED
     │ and resubmits                    │ platform admin rejects            │
     └────────── REJECTED ◄─────────────┘ (reason is required)              └─ (stays APPROVED until suspended)
```

| State       | Meaning                                                                           | Maps to today's  |
| ----------- | --------------------------------------------------------------------------------- | ---------------- |
| `DRAFT`     | created, being configured                                                         | `CONFIGURING`    |
| `SUBMITTED` | the owner asked for approval; waiting for a platform administrator                | new              |
| `APPROVED`  | allowed to operate fully                                                          | `ACTIVE`         |
| `REJECTED`  | not approved; the reason is shown to the owner; the owner may edit and resubmit   | new              |
| `SUSPENDED` | stopped after approval (abuse, non-payment, request); reason recorded; reversible | today's `PAUSED` |

Rules that make it safe: transitions are only the arrows above (anything else is refused with a clear message); each one writes a history row (who, from, to, reason, time) in the same transaction as the state change; a stale `version` is refused (two administrators cannot decide the same request); a request id makes a retry harmless (as for the other write routes); a rejection and a suspension require a reason of at least a set length; only a platform administrator decides, only the OWNER submits or withdraws.

## 3. Data model and migration (non-breaking)

- New table `academy_lifecycle(academyId PRIMARY KEY, state, version, submittedAt, decidedAt, decidedBy, reason)` and `academy_lifecycle_history(id, academyId, fromState, toState, actorId, reason, at)`. Indexes only on `(state, submittedAt)` for the queue.
- **Backfill: every existing academy becomes `APPROVED`** (grandfathered), and an `ACTIVE`/`PAUSED` entitlement maps to `APPROVED`/`SUSPENDED`. Nothing changes for anyone already using the system. The migration is additive and idempotent like 011 and 012, and reversible by dropping the two tables.
- The entitlement `status` stays as the single access gate; the lifecycle state decides **what** the gate allows (section 5). `onboardingStatus` is kept for compatibility and derived from the lifecycle state (`DRAFT`..`REJECTED` → `CONFIGURING`, `APPROVED` → `ACTIVE`) until it can be removed.
- A feature switch `SPORTOZEN_ACADEMY_APPROVAL=off|required` (default `off`): with `off` every new academy is created `APPROVED`, which is exactly today's behaviour, so the code can be deployed before the policy is chosen.

## 4. API changes

| Route                                     | Change                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/workspaces/{id}/lifecycle`     | **new.** `{ action: "submit" \| "withdraw", requestId, expectedVersion }`; OWNER only; same origin and rate rules as every write                   |
| `GET /api/workspaces/{id}` / bootstrap    | adds `lifecycle: { state, reason?, decidedAt? }` for members (the reason only for the owner)                                                       |
| `GET /api/platform/accounts`              | adds `lifecycle`, `submittedAt`, owner name, counts of players and members; filter `?state=SUBMITTED`; paged like the delivery list                |
| `PATCH /api/platform/accounts`            | gains `decision: approve \| reject \| suspend \| reactivate`, `reason`, `expectedVersion`; the existing pause, tier and module fields keep working |
| `GET /api/platform/accounts/{id}/history` | **new.** the lifecycle history and the audit rows for that academy (read only)                                                                     |

All new routes join the security matrix test (anonymous 401, stranger 403, another academy's owner 403, wrong origin 403, paused academy 403) and the isolation suite.

## 5. What is restricted while an academy is not yet `APPROVED` (an owner decision, with consequences)

| Option                                  | Behaviour in `DRAFT`, `SUBMITTED`, `REJECTED`                                                                                                                                                                      | Consequence                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Sandbox (recommended)**            | The owner can configure the academy, add players, batches and sessions, and invite **staff**. **Parents cannot be invited, no WhatsApp or email goes to guardians, and fee collection and announcements are off.** | Protects children's data and the sender reputation (the two things that cannot be undone) while letting the owner build everything. A new owner can see value on day one. Needs a few guards in the invitation, communication and finance services |
| **B. Full access, approval is a badge** | Everything works as today; approval only marks the academy as verified                                                                                                                                             | Nothing is protected: an unverified party can message parents. Cheapest to build                                                                                                                                                                   |
| **C. Locked until approved**            | Only the settings and the "submit" screen are available                                                                                                                                                            | Safest, but the owner cannot try the product before a human acts; approval becomes a business bottleneck                                                                                                                                           |

`SUSPENDED` behaves as today's pause: every member gets 403 with the reason shown to the owner.

## 6. Screens

- **Owner:** a banner on every screen while not approved ("Waiting for approval", "Not approved: <reason>. Edit and resubmit", "Suspended: <reason>"), a "Submit for approval" button with a completeness checklist, and a withdraw button while submitted. The checklist contents are an owner decision (D3).
- **Platform administrator:** a queue (oldest submitted first) with the academy's name, country, owner, modules, size and the completeness checklist; approve; reject with a required reason; suspend and reactivate with a required reason; a history panel. Pause and resume as exist today.
- **Everyone else:** parents and coaches of an academy that is not yet approved see a plain "This academy is not open yet" page, not an error.
- Accessibility: the same patterns as the rest (labelled controls, dialog focus trap, announced errors); the reason field has a visible counter and an announced validation message.

## 7. Notifications and audit

- **In-app first:** the platform queue is the notification for administrators (a count badge); the banner is the notification for the owner. These work with email disabled.
- **Email second** (after the provider is configured and tested): "submitted" to the platform administrators' addresses, "approved / not approved (reason) / suspended / reactivated" to the owner. They use the existing templates and outbox, so retries, suppression and international addresses are already handled.
- **Audit:** every transition is in `academy_lifecycle_history` and also written to the existing `workspace_audit` so the academy's trail stays complete. No personal data of children is placed in a reason; the reason field has a length limit and is shown only to the owner and platform administrators.

## 8. Decisions needed

- **D1** Is approval required at all, or only for some tiers or countries? (`required` or `off`.)
- **D2** Which restriction option for an unapproved academy: A, B or C (section 5)?
- **D3** What must be complete before submission (logo, contact email, a branch, a batch, a coach, consent text...)? And what does the administrator check (a document, a call, a payment)? The application can only show a checklist; it cannot verify a person's identity or a business.
- **D4** Who are the platform administrators and how many? Is two-person approval needed? (Supported by adding a second approver; not proposed by default.)
- **D5** Is a rejection final or may the owner resubmit without limit? How long may an academy stay `SUBMITTED` before a reminder?
- **D6** What does `SUSPENDED` do to data: remains readable by the owner for export, or fully closed (today's pause is fully closed)? Is there an "account closure" state with the retention rules in `docs/DELIVERY_DATA_RETENTION.md`?
- **D7** Are existing academies grandfathered as `APPROVED` (proposed) or reviewed?

## 9. Work and tests once approved

Migration plus two repositories; a small lifecycle service (the state machine as a pure function with a table-driven test of every allowed and every refused transition); guards for option A; the routes above; the owner banner and the platform queue. Tests: the state machine exhaustively; concurrency (two decisions, stale version); idempotent retries; the security matrix and isolation suite extended; backfill on the seven older databases; the full browser flow (owner submits, administrator rejects with a reason, owner resubmits, administrator approves, parent invited), with the feature switch off proving today's behaviour is unchanged. Mutation checks on the transition table and on each guard.

I estimate this at a few days of focused work including tests and review; the large uncertainty is D2/D3, not the code.
