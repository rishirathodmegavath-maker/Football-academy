# WP3–WP6 report: backend architecture, data integrity, security, business workflows

Branch `codex/wp3-wp6-hardening`, an isolated worktree at `D:\Sportozen\sportozen-wp3-6`
created from `codex/day1-integration` HEAD `6837e84`. **Nothing is staged, committed,
pushed, merged or deployed.** The main checkout (`D:\Sportozen\sportozen-academy`) was only
read: HEAD `6837e84`, 0 staged, 70 modified, 50 untracked, `docs/FEATURE_D_REVIEW.md`
unmodified, `test-results/` intact.

## 0. Status

| Package                         | Status                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| WP3 backend architecture        | **Done** within the limits below                                                  |
| WP4 database and data integrity | **Done**; real foreign keys deferred by decision (section 4)                      |
| WP5 security                    | **Application-level work done**; production hardening is external (section 5.3)   |
| WP6 business workflows          | **Verified by the existing and new suites; one known defect left open** (PDF-001) |

Independent review: one read-only reviewer, no blockers, two HIGH findings, both fixed
(section 8). A targeted second review of those two fixes found no blocker or HIGH issue (section 10).

## 1. How this was done, and what it depends on

WP1 and WP2 are **uncommitted** in the main checkout (70 modified, 50 untracked files), and
they cover almost every shared backend file. With your approval, the WP1/WP2 working-tree
state (111 files, not `docs/screenshots`, `test-results` or `FEATURE_D_REVIEW.md`) was copied
into the worktree as an untracked base; a pristine copy is at `D:\Sportozen\wp12-snapshot-base`.
**Everything WP3–WP6 changed is delivered as one patch relative to that base:**

- `D:\Sportozen\wp3-wp6-delivery\wp3-wp6.patch` (30 files) and `changed-files.txt`.
- It was dry-run applied to a pristine copy of the base and reproduced the worktree exactly.
- It touches about nine files that WP1/WP2 also modified or created (`workspace-service`, `workspace-access`,
  `http`, three routes, `request-errors.test`, `mock-auth`). Apply it after WP2 is final; line-ending
  noise aside, the hunks are small and localised.

Corrected assumption: this application does not use Prisma. Persistence is Node's `node:sqlite`
with JSON record bodies in `workspace_records` / `academy_finance_records` and hand-written
migrations, so cross-record relationships cannot be database foreign keys.

## 2. WP3: architecture

- **Nested transactions.** `atomic()` now opens a savepoint when a transaction is already
  open and refuses an async callback. `workspaceRepository.save` is atomic, so a record and
  the weekly updates and queued notifications it invalidates change together (a test makes the
  dependent update fail and checks the plan is not saved).
- **`membership-service.ts`.** Invitations and revocation (130 lines) moved out of the
  1,394-line `workspace-service.ts`, re-exported unchanged (same function objects).
- **One definition of a coach's reach.** `coachCoversPlayers()` replaced four copies of
  "this coach is assigned every rostered player" in `workspace-access.ts` and `training-service.ts`.
  Reviewed as equivalent, including empty rosters and unknown players.
- **Errors.** `apiError` answers a duplicate/foreign-key failure with 409 and a busy or locked
  database with 503 + `Retry-After` (primary code `& 0xff`), logged; NOT NULL / CHECK failures stay
  500 on purpose, since they mean the service let bad data through. `WorkspaceError` can carry headers.
- **Route ordering.** `GET /training` now authenticates before validating its query (found by the
  permission matrix).
- Not done, deliberately: a route-wrapper abstraction (the 18 handlers are short and explicit),
  and splitting `communication-service` / the 450-line `saveRecord` switch, which would be
  rewrite-sized work for no verified defect.

## 3. WP4: database and data integrity

- **Migration 008** (`src/server/migrations/008-integrity-guards.ts`), additive and reversible
  (`DROP TRIGGER` / `DROP TABLE`); no rebuilds, no rewrites, no deletes:
  - a record must belong to its academy and carry its row's id, and be valid JSON
    (`workspace_records`, and academy for `academy_finance_records`);
  - history and audit tables (`training_history`, `academy_finance_history`,
    `report_approval_history`, `update_approval_history`, `batch_announcement_history`,
    `workspace_audit`) can be neither **updated nor deleted** (including by `INSERT OR REPLACE`);
  - roles limited to the five defined (memberships, invitations);
  - table `request_rate_limits` with an expiry index.
  - The record-ownership guards are **installed only when every stored row already satisfies them**;
    otherwise they are skipped with a logged warning and install on a later start (tested).
- **Compatibility evidence.** The read-only checker (`scripts/check-data-integrity.ts`) was run
  over **97 local databases** (the Bharat copy and every generation of test and QA data): no ERROR findings; 22 of them warn that a
  player's coach has no active membership (test fixtures). Run it on a copy of production before
  deploying 008.
- **Guards I removed because the evidence contradicted them:** an entitlement-status constraint
  (existing tests legitimately use `SUSPENDED`). DELETE-blocking was first dropped for the same reason
  and then added back on your decision, with a shared test-cleanup helper (section 10).
- **Concurrency defects fixed.**
  - `reply()` did read-modify-write on a conversation with no transaction, while the separate
    communication-worker process appends inbound messages to the same record, so an inbound message
    could be overwritten. It now reads inside the write lock; a test proves the second connection is
    refused at the moment of the read and at the save.
  - `database()` set `busy_timeout` after `journal_mode=WAL`, so concurrent first opens failed
    ("database is locked"): it broke parallel `next build` workers on a fresh database. Fixed by
    setting the timeout first **and** a bounded wait-and-retry around the WAL switch, because SQLite does
    not always honour the busy handler for a journal-mode change (the first fix alone was
    insufficient: the test still failed once; with both, 6 of 6 stress runs of 16 processes passed).
  - Invitation/revocation, platform entitlement changes and the reply are now atomic with their audit entry.
  - `atomic()` called while someone else's transaction is open (Better Auth runs sign-up work in one on
    the shared connection) now fails as a retryable 503 instead of an opaque 500. Not load-tested.
- **Consistency checker** (`src/server/data-integrity.ts`): orphaned attendance/evidence, roster
  mismatches, players/batches/sessions/venues that do not exist, tenant mismatches, approved reports
  without snapshots, guardian links, and finance (payment/receipt/invoice links, wrong child, duplicate
  invoice numbers, negative amounts, overpayment, adjustments below zero). Read-only (tested: file
  hash unchanged), linear time, tolerant of null entries.
- **Not done / needs a decision:** real foreign keys, enum CHECKs and unique constraints on JSON
  fields need table rebuilds (destructive-class) and were deferred by decision; idempotency keys on the
  generic `POST /records/:kind` (training, finance and trials already have them).

## 4. Decisions taken

1. DELETE protection on history and audit tables: **implemented** (section 10).
2. Real foreign keys, CHECKs and table rebuilds: **deferred**; nothing destructive was attempted. Run the integrity checker on a copy of production first when this is revisited.

## 5. WP5: security

### 5.1 Verified sound (no change needed)

A 99-case permission matrix runs every academy API route as anonymous (401), signed-in stranger (403),
owner of another academy (403), foreign or missing origin on every mutating route (403), against a paused
academy (403 for owner, admin, coach, parent), for a revoked or expired member (403), and checks role
limits on writes, parent/child isolation of financial PDFs, no-store caching, and no internals in
refusals. Fourteen tests cover the Platform Administrator and Support boundaries (metadata only; owner-only,
one-hour, player-scoped, read-only, audited, revocable grants; existing roles cannot be replaced). The
logo upload is a PNG data URL of at most 300 kB (SVG excluded). No CORS is configured. Webhook signatures
use constant-time comparison.

### 5.2 Fixed

- **Security headers** (`next.config.ts`): `X-Content-Type-Options`, `X-Frame-Options: DENY`, CSP limited to
  `frame-ancestors/base-uri/form-action/object-src`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, no `X-Powered-By`; HSTS when `BETTER_AUTH_URL` is HTTPS **at build time**
  (verified on a running server and in the build manifest).
- **Write rate limit**, per verified user id, shared across processes (SQLite): 240/min on every
  state-changing route (`SPORTOZEN_WRITE_LIMIT_PER_MINUTE`), 10/min invitation acceptance, 10/h academy
  creation; 429 + `Retry-After`. Review found my first design (keyed on a cookie) was bypassable and
  wrote to the database for unauthenticated requests; it was redesigned and the bypass is a regression test.
  Anonymous requests are neither counted nor written.
- **Membership defect:** an invitee with an earlier lapsed or revoked membership received a membership that stayed
  expired with stale sport restrictions (invitation consumed, no access). Fixed and tested.
- Dependency audit (`pnpm audit`): 6 advisories (vitest, @vitest/mocker, tinypool, minimatch), all in test/lint
  tooling. `pnpm audit --prod` still lists the vitest ones; `package.json` has vitest in `devDependencies`.
  Not upgraded (vitest 3→4 is a major change to the shared toolchain).

### 5.3 Not done: external or out of scope (not claimable from this repository)

`script-src` CSP (needs nonce-based dynamic rendering); MFA; verified e-mail and secure account recovery
(sign-up is open and e-mail unverified); edge/DDoS limiting and the unauthenticated webhook and `/api/auth/*`
endpoints; trusted client-IP configuration for Better Auth's own limiter behind a proxy; backups and
recovery drills; monitoring; secret rotation; multi-instance database; independent penetration test. Stored
JSON parse errors may echo a fragment of a record into server logs.

## 6. WP6: business workflows

No stubs or placeholder implementations exist in the authenticated workspace (only the out-of-scope "AI Video
Analysis: Coming soon" labels and labelled fictional design-preview screens). Workflows are verified by the
65-test browser suite (players, batches, sessions, attendance, evidence, fee plans, invoices, payments,
trials, reports, approval, parent updates, messages, all roles), the 12-test report-review suite, the
simple-session suite, 71 finance tests and the new tests above. Financial and report calculations and PDF
output are unchanged. **Open:** PDF-001 (long-report continuation pages lose the repeated branding/privacy
footer visually). It needs a PDF rasteriser, which this machine lacks (`pdftotext` only); I did not change the
renderer without being able to see the result.

## 7. Verification (local only; this is not GitHub CI)

| Gate                                             | Result                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| ESLint                                           | 0 errors (2 warnings in files WP1/WP2 own)            |
| TypeScript                                       | clean                                                 |
| Unit tests                                       | **753 passed, 51 files** (580 from WP2, plus 173 new) |
| Production build (plain, and with CI's QA flags) | pass                                                  |
| Main browser suite, CI environment               | **65 passed** (12.5 min)                              |
| Report-review browser suite                      | **12 passed**                                         |
| Simple-session browser suite                     | **1 passed**                                          |
| Focused browser subset during development        | 7 passed                                              |
| Header check on a running production server      | pass (HSTS only for an HTTPS build)                   |

Disclosures:

- My first full run was invalid: I ran the main suite without CI's QA environment and got 404s on demo routes. I
  stopped it and reran with CI's exact variables.
- The unit suite then failed once on the startup race test; that exposed the incomplete WAL fix. Lint, typecheck,
  all 753 unit tests and the build were rerun on the final source. The **main browser suite ran on a build that
  predates the WAL-retry edit** (the edit only matters when several processes open a new database simultaneously);
  the report-review and simple-session builds include it.
- The startup test is probabilistic: without the fix it failed 1 of 3 runs.
- I ran prettier over directories twice and it reformatted four files I never meant to change; I reverted each
  and verified the patch against the base.

## 8. Independent review

| #     | Finding                                                                                                | Resolution                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| HIGH  | startup test depended on a git-ignored `.local` directory                                              | fixed (creates it)                                                            |
| HIGH  | rate limiter bypassable by forged cookie names, and wrote DB rows for unauthenticated calls            | redesigned: per verified user, applied after authentication; regression tests |
| MED   | limiter sweep unindexed                                                                                | `expiresAt` index                                                             |
| MED   | a legacy malformed row could block saves once 008 is installed                                         | guards install only on clean data; documented pre-deploy check                |
| LOW   | doc link missing; "per-session" overclaim                                                              | report written; docs corrected                                                |
| LOW   | checker O(n²) and crashed on null roster entries                                                       | indexed; null-safe                                                            |
| LOW   | busy codes compared without `& 0xff`; mapped errors unlogged                                           | fixed                                                                         |
| tests | lock test did not prove the lock covered the read; silent `if` guard; clock-dependent route-limit test | assertion moved into the read; deterministic; fake clock                      |
| risk  | Better Auth transactions share the connection                                                          | clear 503; **not load-tested**                                                |

## 9. Remaining blockers and client decisions

1. Real foreign keys and table rebuilds: deferred (section 4).
2. PDF-001 needs a machine with Poppler (reproduction in section 10).
3. WP2 must be final before the patch is applied (about nine shared files).
4. External production items in 5.3.
5. Upgrade vitest in a dedicated change.

## 10. Closure update

### 10.1 DELETE protection (decision 1)

- Migration 008 adds a `BEFORE DELETE` trigger (`<table>_no_delete`) beside the existing update guard on all six
  history and audit tables. `database()` now sets `PRAGMA recursive_triggers=ON`: without it SQLite deletes the
  row an `INSERT OR REPLACE` replaces **without firing delete triggers**, which would have bypassed both guards
  (demonstrated, then closed; the test fails if the pragma is removed). The table list is exported
  (`APPEND_ONLY_TABLES`) so the migration and tests cannot drift.
- No application code, script or e2e helper deletes from these tables (searched); only the four test files below did.
- Test cleanup: new `tests/unit/helpers/reset-tables.ts` lifts the guard for one cleanup statement and restores it
  with the migration, also when the cleanup fails. Updated: `batch-announcements`, `finance`,
  `period-communication`, `trials` (4 lines each, no assertion changed).
- New `tests/unit/history-protection.test.ts` (12 tests): every table refuses DELETE, UPDATE, REPLACE and upsert;
  inserts still work; the helper restores the guard; the migration re-creates a removed guard; real services still
  append approval, training, finance and audit history.
- Deliberate purge or retention is an operator step: drop the table's `_no_delete` trigger, delete, restart.

### 10.2 PDF-001: left open

Poppler is not installed here (`pdftoppm`, `pdftocairo`, `pdfinfo` absent; the `pdftotext` present is Xpdf 4.00),
so a change could not be verified visually and none was made. Reproduction: open the long legacy demo report
(three pages; see `docs/QA_BUG_LOG.md` PDF-001, `docs/VALIDATION.md`) and rasterise pages 2 and 3, for example
`pdftoppm -r 100 -png report.pdf page`; the repeated academy header, footer rule and privacy line are absent
visually although text extraction finds them. Lead: `generateReportPdf` in `src/features/reports/report-pdf.tsx`
renders the body with `branding={false}` and overlays the header, rules and footer on every page with pdf-lib
(`pages.forEach`, after `page.drawPage`); start by rasterising that overlay. The 120-report Bharat export check
recorded in `docs/FINAL_ACADEMY_BUG_LOG.md` did render continuation pages, so the defect may be specific to the
legacy fixture's path.

### 10.3 Targeted independent review of the two HIGH fixes

A fresh read-only reviewer examined only those areas. **Rate limiter: resolved.** All 16 mutating handlers reach the
per-user limiter; no key collisions; no unauthenticated writes. **Database startup: partially resolved**, then
addressed: the `.local` problem was fixed, but the reviewer showed the 16-process test is only probabilistic (it
caught the original ordering bug 16 times in 448 processes and could not catch removal of the WAL retry). No blocker
and no HIGH issue. Actions taken:

- Added `tests/unit/rate-limit-routes.test.ts` (a route scan that fails if any mutating route skips `sameOrigin`
  or the limiter, plus 429 tests for invitation acceptance and academy creation) and
  `tests/unit/rate-limit-platform.test.ts` (platform PATCH). Mutation-checked: removing the limiter call from
  the platform route, or `sameOrigin` from a route, fails them.
- Added a **deterministic** startup test: another connection holds the write lock; the child announces (marker
  file) that it is about to open the database; the lock is released 700 ms later; the child must succeed after
  waiting. Removing both the busy timeout and the WAL retry fails it. Removing only one does not, because each
  covers the other. The 16-process test is kept and now labelled a smoke test.
- Findings of mine along the way: my first version of the deterministic test was timing-fragile (it failed in 3 of
  5 full-suite runs because the child's start-up time varies under load) and its holder connection lacked a busy
  timeout; both fixed (marker-based timing, holder timeout, best-effort temp-file cleanup because Windows can keep
  a just-exited process's file locked for a moment).
- Accepted, not changed: the limiter fails open if a future route forgets the origin check (now caught by the route
  scan); Better Auth sign-up can cause a transient retryable 503 (still not load-tested); migration 003's
  check-then-ALTER can race for a legacy database opened by two processes at once; migration 008 scans tables
  under the write lock (slow on a very large database); Playwright sets no write-limit variable (the suites passed
  at the default 240/min).

### 10.4 Final verification (local, Windows, Node 24.13; not GitHub CI)

Commands (from `D:\Sportozen\sportozen-wp3-6`; a `pnpm` shim was used because pnpm is not on PATH):

```
npx eslint .                                      # 0 errors, 2 warnings (files WP1/WP2 own)
npx tsc --noEmit                                  # clean
npx vitest run                                    # 789 tests, 54 files
npx next build                                    # plain production build
# CI "validate" environment:
SPORTOZEN_QA_BUILD=1 SPORTOZEN_GALLERY_QA=1 SPORTOZEN_FINAL_QA=1 SPORTOZEN_HOME_UI_QA=1 \
  SPORTOZEN_E2E_EVIDENCE_ROOT=docs/screenshots/final-academy/regression \
  npx next build && npx playwright test
# CI "report-review" environment:
SPORTOZEN_QA_BUILD=1 SPORTOZEN_REPORTS_QA=1 SPORTOZEN_QA_PYTHON=python \
  npx next build && npx playwright test --config playwright.report-review.config.ts
SPORTOZEN_QA_BUILD=1 SPORTOZEN_FINAL_QA=1 \
  npx next build && npx playwright test --config playwright.simple-session.config.ts
```

| Gate                                                          | Result                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint                                                        | 0 errors                                                                                                                                        |
| TypeScript                                                    | clean                                                                                                                                           |
| Unit tests                                                    | 789 tests in 54 files (753 + 36 new); 5 of 6 consecutive full runs after the final test fix passed (the sixth hit the pre-existing flake below) |
| Production build (plain and QA)                               | pass                                                                                                                                            |
| **Main browser suite, build made after the last source edit** | **65 passed** (12.1 min)                                                                                                                        |
| Report-review browser suite                                   | 12 passed                                                                                                                                       |
| Simple-session browser suite                                  | 1 passed                                                                                                                                        |

The one failing full run was the pre-existing, load-sensitive `api-baseline` test "limits a parent's finance view and
invoice PDFs to their own child", which exceeds its 5-second limit when the machine is busy (also noted for WP2). It
is unrelated to this work and was not modified.
