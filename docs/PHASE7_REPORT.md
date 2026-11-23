# Sportozen Academy: remaining work report (Phase 7)

Written for: the repository owner, who decides the open product questions and the acceptance testing.

Phase 7 closes what Phases 5 and 6 left open and prepares the owner's acceptance testing and the eventual deployment. It is reported separately from Phases 5 and 6, which are frozen (`phase5-final-snapshot`, `phase6-final-snapshot`, `phase5-*.patch`, `phase6-*.patch`: none overwritten).

Nothing was committed, pushed, merged, deployed, reset, stashed or cleaned. The main checkout, the Phase 2 worktrees, the clean validation copy, the recovery folders and the original databases were not modified (the seven older databases were only _copied_ for the migration check). No email, WhatsApp message or payment was sent or taken; no account, DNS record or credential was created; nothing was bought. The one external action was reading Zoho's public ZeptoMail documentation.

**Classification used below:** `Completed` = built or written; `Verified` = checked on the final tree by the evidence named; `Needs owner approval` = a decision or a change that is not mine to make; `Deferred to deployment` = cannot be done before a server, domain or provider exists; `Needs real-device/manual validation` = automated checks cannot settle it.

## 1. Executive summary

- **No Critical or High defect is open in the verified scope.** The final tree passed typecheck, ESLint (0 errors, 0 warnings), 1,307 unit and integration tests, all three production builds, the browser suites (main 75, account security 2, email and authentication 6, monthly report review 12), preflight, the secret scan, the migration check on seven older databases, and the WSL and Docker operational tests (section 11).
- **Mobile speed (lab, production build): load 2.67 s to 2.05 s (-23 %), largest paint 3.20 s to 2.77 s (-13 %), transfer 463 to 380 KB (-18 %), blocking time 338 to 190 ms (-44 %); first paint unchanged at 0.78 s.** The largest paint is still about 2.8 s on the deliberately harsh profile; whether that matters on a real phone is a real-device question.
- **The Communication delivery list is now read one bounded page at a time** instead of loading every job of the academy: at 150,000 jobs the old read took 1,483 ms and every new page takes 0.1 to 2.7 ms (worst case, a search with no match: 71 ms).
- **The 124 label-in-name accessibility findings are gone**: axe-core reports zero violations on 48 page-views (it reported 124 before). A real screen-reader test has not been done and is in the acceptance plan.
- **Four decisions are prepared and need you**: academy approval workflow, delivery-data retention, the operational-script fixes (WP8), and the first ZeptoMail adapter after deployment. Each has alternatives and consequences in its own document.
- **A manual acceptance test plan exists. Every test in it is marked NOT PERFORMED.**
- **Not production ready and not production validated.** That needs a server, a domain, a tested email provider, alert routing and a real-device test, none of which exist yet.

## 2. Baseline and findings verified (Task 1)

The working tree was compared with `phase6-final-snapshot` before any change: 796 files, 0 differences. The Phase 5 and 6 reports were read and each open finding was re-checked before work on it:

| Finding                                                                  | Re-verified how                                                  | Still present?                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| L2/O3 mobile largest paint about 3.2 s                                   | rebuilt the tree, same benchmark: 3,196 ms median over six pages | Yes (reproduced), then improved             |
| L3/O1 the Communication view loads every job                             | measured on 150,000 rows: 1,483 ms                               | Yes, then fixed                             |
| L3/O2 delivery-table retention undecided                                 | measured row sizes and growth                                    | Yes: proposal prepared                      |
| L1 no academy approval step                                              | read the code: `onboardingStatus` is set once and read nowhere   | Yes: proposal prepared                      |
| L5 124 avatar label-in-name nodes                                        | axe on the build before the fix                                  | Present (as 124 owner fee rows), then fixed |
| L4 WP8 findings                                                          | replayed with the real code (section 8)                          | Four of five reproduced, one reasoned       |
| Parent Settings showed staff-only tabs; parent Fees showed staff filters | read the code                                                    | Yes, then fixed                             |

## 3. Mobile performance (Task 2): Completed, Verified in the lab; Needs real-device validation

**Method.** Same as Phase 5 and 6: `next build` and `next start` (not `next dev`), the same 60-player database copy, the same scripts and profile (390 x 844, 4x CPU slowdown, 1.6 Mbps, 150 ms round trip), nothing else running, median of 3 runs per page, six pages (parent: Home, Messages, Reports; owner: Home, Players, Reports). "Before" is the working tree before the performance change, built fresh (it differs from the Phase 6 snapshot only by the paging route and the avatar markup, neither on the Home path); it reproduced the Phase 6 figures (3,196 ms against 3,204 ms). A copy of the frozen snapshot could not be built separately (its dependencies are linked outside the project, which the bundler refuses).

**Where the time went** (timeline of the Parent Home on that profile, `perf-timeline`): 306 KB of script arrived by 2.5 s, the page hydrated at 2.7 s, then asked for its data (three requests, one after another), and the first card was painted at 3.2 s. The server was never the bottleneck (the data answer takes 200 ms of the 3.2 s on this profile).

**What was changed.** The portal imported every screen in the first download. Only Home and the shell are needed first; the other screens are about 90 % of the application's code and drag in form validation (zod, 31 KB compressed) that Home does not use. They are now separate chunks (`portal-lazy.tsx`), requested when the screen is opened, started in parallel with the data request for the screen named in the address, and fetched quietly in the background three seconds after the page has finished loading (skipped when the browser asks to save data or reports a very slow link). A screen whose code file cannot be fetched (a page left open across an update) shows a clear message and a Reload button (`portal-screen-boundary.tsx`) instead of a broken page; this is tested in a real browser with the chunks blocked.

| Mobile profile, median of six pages | Before   | After one change (screens split) | Final tree             |
| ----------------------------------- | -------- | -------------------------------- | ---------------------- |
| Page load                           | 2,666 ms | 2,044 ms                         | **2,046 ms**           |
| First paint                         | 780 ms   | 772 ms                           | **776 ms** (unchanged) |
| Largest paint                       | 3,196 ms | 2,702 ms                         | **2,768 ms**           |
| Transfer before the page is ready   | 463 KB   | 366 KB                           | **380 KB**             |
| Total blocking time                 | 338 ms   | 199 ms                           | **190 ms**             |
| Requests                            | 24       | 22                               | 24                     |

Parent Home alone: load 2,665 to 2,060 ms, largest paint 3,216 to 2,844 ms, transfer 412 to 288 KB. The difference between the middle and last columns is the extra preload of the opened screen's code, which was not distinguishable from run-to-run noise (about 100 ms); I kept it because it is small and logical and do not claim it as a gain.

**Costs, stated plainly.** (1) The quiet background fetch downloads more after the page is ready: on the final build 107 KB for a parent (total 392 KB against 412 KB before the change) and 165 KB for an owner (total 670 KB against 633 KB before, 37 KB more), measured over the 15 seconds after the page was ready; the bytes arrive later instead of earlier, and an owner who never opens those screens downloads more than before. (2) The first visit to a screen right after the page loads waits for one small chunk if the background fetch has not reached it yet; with the fallback message if the network fails. (3) Desktop on localhost is unchanged within noise (first paint 120 to 160 ms, in-app navigation 65 to 94 ms against 64 to 95 ms before) and each page loads 190 to 260 KB of script instead of about 300 KB.

**Evaluated and not done.** Rendering the first data on the server (so the page arrives with its first card): about 200 ms of the remaining 2.8 s, at the price of a second copy of the screen-selection logic on the server and larger HTML. Not justified without a real-device measurement. Critical CSS (41 KB of stylesheet, two files): small and not on the measured path. Further trimming of React and Next themselves: not possible from here. **Needs real-device validation:** the profile is a lab model; the acceptance plan (section 6 of `docs/ACCEPTANCE_TEST_PLAN.md`) asks for a stopwatch measurement on a real phone.

Evidence: `evidence/perf-mobile-p7before.json`, `-p7after1.json`, `-p7after2.json`, `-p7final.json`, `perf-pages-p7final.json`, `perf-nav-p7final.json`, build logs `p7-build-*.log`.

## 4. Communication delivery list (Task 3): Completed, Verified

**Problem.** `GET /communication` returned every delivery job of the academy and the screen filtered them in the browser.

**Solution.**

- **API** `GET /api/workspaces/{id}/communication/jobs?limit&cursor&state&type&playerId&q&order`: keyset pagination by (due time, id), default 25 and at most 100 (more is refused with 400), newest or oldest first, filters on status, type and player, free-text search over the player's name, the guardian's name, the period and the reason (a typed `%` or `_` is plain text), an opaque cursor that names no academy (a damaged one, or one made for the other sort order, is refused with 400). Rows carry no claim, lease, provider receipt or academy id.
- **Authorization** is the academy session plus the same visibility rules as the records: owner and administrator read the whole academy; a coach only the players they can see; a guardian only jobs addressed to themself about their own child; a named player must be visible to the caller. A cursor, a player id or a search from another academy reads nothing of it (tested). Announcement jobs (which have no player) are not part of this list.
- **Existing `GET /communication`** keeps its `jobs` field for compatibility, now limited to the newest 25 with a `jobsMore` flag; its other contents are unchanged.
- **Indexes** (migration 012, indexes only, idempotent, reversible): `(academy, due, id)`, `(academy, player, due, id)`, `(academy, guardian, due, id)` and `(academy, status, due, id)`, partial on person-addressed jobs. The query plans were checked: no sort step.
- **Screen.** The player's "Delivery and approval details" now shows 25 at a time with "Show older notifications", a status filter, a search box (waits for a pause in typing), a loading state, an empty state (different texts for "none yet" and "none match"), an error with "Try again", and refreshes in place after a cancel. A keyset page cannot repeat or skip a row when new jobs arrive between requests (tested: a newer job appears on refresh, an older one is still ahead, nothing repeats). The code that reads the list is a new hook and component; the cancel button and everything else on the panel behave as before.

**Verification.** 24 unit tests walk 900 jobs (plus 400 in a second academy and 40 announcement jobs) page by page: completeness, order, bounds, filters, search, arrival of new jobs, a damaged cursor, every role, cross-academy attacks, query plans; six deliberate mutations of the code (drop the guardian filter, inclusive cursor, drop the player authorization, unbounded limit, include announcement jobs, ignore the status filter) were each caught (the first one was _not_ caught at first because the fixture never gave a child's jobs to two guardians; a test for that was added). The route is in the security matrix (anonymous 401, stranger 403, other academy 403, paused academy 403). A browser test pages through 60 jobs, filters, searches, forces a failed read and recovers, and checks a guardian sees only their own 40.

**Measured on 150,000 jobs per academy** (two academies, 300,000 rows; `evidence/p7-jobs-perf.json`): old read of the whole academy 1,483 ms; owner first page 0.09 ms; a page from the middle of the history 0.09 ms; a status filter 0.09 ms; one player 2.0 ms; a guardian 0.12 ms; a coach with 40 of 300 players 0.17 ms; search by player name 2.7 ms; by reason text 0.9 ms; **a search with no match anywhere scans the academy's jobs: 71 ms** (accepted and bounded; the response is still one page).

**Behaviour notes.** An owner now sees the person-addressed jobs of the whole academy, including a job for a player who has since been removed (delivery history is an audit record); there is no academy-wide delivery log screen (the API supports one; adding it is a product decision, not built).

## 5. Accessibility (Task 6): Completed, Verified by automated checks; Needs real-device/manual validation

- **The avatar finding.** The 124 nodes were the fee-list row buttons: the button has a descriptive name ("Open Asha Sharma Monthly fee fee details") but the avatar's initials ("AS") were visible _text_ that the name did not contain (WCAG 2.5.3 Label in Name). The initials are decoration (the name is always written next to them), so they are no longer text in the page: the avatar draws them from a `data-initials` attribute with CSS and stays hidden from assistive technology. Initials of non-Latin and astral names now take a whole character (the old code split such a character in half).
- **Found by re-running axe on the build:** the same pattern on the settings logo button (fixed the same way) and an empty fee table that scrolls sideways on a phone with nothing focusable in it (the table area is now a labelled, keyboard-focusable region). The empty table did not appear in the Phase 6 axe run and I did not establish why; the fix does not depend on the cause.
- **Staff-style controls shown to people who cannot use them:** a coach or guardian no longer sees the Academy, Team and Sessions tabs in Settings (they only said "unavailable"), and a guardian no longer sees the batch filter and name search on Fees.
- **Results, final build:** axe-core (WCAG 2 A and AA, 2.1 A and AA, best practice) on 48 page-views (owner, coach, parent, 1366 and 390 px): **0 violations** (Phase 6: 124 label-in-name). Keyboard spec (sign-in labels, announced error, skip link, focus visible on the first 30 stops, dialog trap and return of focus, touch-target sizes) passed in the full run. Overflow with 70-letter names, 400-letter announcements and 11-digit amounts at four widths: none. Console and CSP: no error on the owner and parent pages. Three-engine sweep (Chromium, Firefox, WebKit; 96 page-views each): no overflow, no console error.
- **Not claimed:** no real screen reader, no real device, no user with a disability has used it. The acceptance plan has the checklist (NVDA, VoiceOver, TalkBack; keyboard only). The remaining "control without a name" counts from my own sweep script are the same heuristic artifacts as in Phase 6 (axe, which computes names properly, finds none). The cosmetic double border on the fees search box on narrow widths was not touched.

## 6. Academy approval workflow (Task 5): Needs owner approval (nothing built)

`docs/ACADEMY_APPROVAL_PROPOSAL.md`: what exists today (an academy is usable the moment it is created; `onboardingStatus` is never changed and never read; the only gate is the platform's pause); the proposed states (draft, submitted, approved, rejected with a reason, suspended) and the allowed transitions; a new table with history instead of a field in the configuration JSON; every existing academy backfilled as approved so nothing changes for anyone; a feature switch whose default reproduces today's behaviour; API and screen changes; notifications that work with email off; three options for what an unapproved academy may do (recommended: build everything but cannot invite parents, message guardians, collect fees or announce) with consequences; and seven decisions (D1 to D7). **No non-breaking subset was implemented**: every part of it depends on D1 or D2, and a half-built lifecycle would be worse than none.

## 7. Delivery-data retention (Task 4): Needs owner approval (nothing deleted)

`docs/DELIVERY_DATA_RETENTION.md`: inventory of every table that grows with what it holds and whether it is personal data; measured cost (about 1.4 KB per delivered job with its attempt and indexes: roughly 90 MB per year for 650 guardians receiving 100 messages a year, 4.5 GB for ten such academies over five years); what must never be deleted by a job (financial records, the email suppression list, approval history, anything still changing, rows that give duplicate protection for a provider's repeated webhooks); a keep / archive-then-delete / delete-soon table with _options_ for the periods (6, 12 or 24 months for jobs; 30 to 90 days for raw inbound webhook bodies; the audit not shorter than the financial records) and no invented legal periods; the privacy implications (a job row ties a guardian to a child; backups still hold deleted rows for up to a year); a staged implementation (report-only first, archive with a verified checksum, batched deletion, kill switch, tests, rollback); and six decisions (D1 to D6). The finished email outbox is already purged at 90 days (existing behaviour, checked).

## 8. WP8 operational findings (Task 8): assessed; fixing them Needs owner approval

`docs/WP8_OPEN_FINDINGS.md`. The operational scripts were **not modified**. Each was replayed with the real code from outside it:

| Finding                                                                                                         | Reproduced                     | Severity      | Blocks release?                      |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------- | ------------------------------------ |
| Warning/critical oscillation never produces an alert (8 alternating passes: 0 alerts; 2 steady passes: 1 alert) | Yes                            | Medium        | No; fix before unattended production |
| A check that stops being reported never resolves (397 passes later it is still in the state)                    | Yes                            | Low-Medium    | No                                   |
| Deep and minute runs 4 seconds apart count as two confirmation passes (an alert after one real observation)     | Yes                            | Low           | No                                   |
| `rollback.sh` reports success when the worker restart fails (exit 0, `rollback.succeeded`)                      | Yes, in WSL on the real script | Medium        | No; fix before production            |
| Stale-lock takeover has a check-then-delete window                                                              | No (reasoned from the code)    | Low, accepted | No                                   |

Each has a root cause, a targeted fix and the regression tests that would prove it, in the document. None is a Critical or High defect. The thing that does block production is not in the list: **no alert destination is configured**.

## 9. ZeptoMail readiness (Task 7): Completed (documentation and tests); the adapter Deferred to deployment

`docs/EMAIL.md` section 16 was rewritten from Zoho's current public documentation (read this phase): the adapter architecture (one more transport and one event feed behind the existing outbox; no second email system), the environment variables (existing ones, and _proposed_ names for the new ones, none read by the code), what the sender domain needs (a Mail Agent, a DKIM record and a CNAME for the bounce subdomain; Zoho removed SPF from its verification; DMARC starting at `p=none`), webhook events and signing, the behaviour the feed must have (all already implemented for Postmark), international address limits, and the external requirements. It records that Zoho's documentation is in transition (an API host `cpaas.zoho.com` on the page read, regional `api.zeptomail.*` hosts only in third-party integrations), so **the host, the event names and the retry policy must be confirmed from the owner's account**; that is why no adapter was written. The local `file` and `capture` transports and the `disabled` default are untouched.

International addresses: 32 new tests (`tests/unit/email-international.test.ts`) confirm that internationalised domains are converted to their ASCII form (`münchen.de`, `例え.jp`, `пример.рф`), invalid and look-alike-dangerous forms are refused (bad labels, bad punycode, bidirectional overrides, header injection), and that an address with a non-ASCII local part passes the check but cannot be an account (a property of mail systems; documented). No code change was needed.

## 10. Manual acceptance plan (Task 9): Completed; every test Needs real-device/manual validation

`docs/ACCEPTANCE_TEST_PLAN.md`: setup (accounts, test data, devices), 82 numbered tests with steps, expected results and empty "Actual" and "Result" columns for the platform administrator (8), owner (account and academy 7, players and batches 5, invitations 5, sessions and attendance 7, fees and money 10, reports and PDFs 5, announcements and messaging 8), coach (8), parent (11) and cross-role and two-academy checks (8); real-device guidance (nine checks per phone, what to record); screen-reader and keyboard guidance (NVDA, VoiceOver, TalkBack, what good looks like); sign-off conditions; a defect log. **No test is marked passed.**

## 11. Complete regression on the final tree (Task 10)

Run twice because I changed three small things after the first full run (the settings-logo initials, the fee-table scroll region, one unused variable in a test). The first run is `evidence/phase7-final-regression.log`, the final run `evidence/phase7-final-regression-run2.log`; the figures below are from the final run unless marked.

| Check                                                                   | Result                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                                              | exit 0                                                                                                                                                                                                                |
| ESLint                                                                  | exit 0, **0 errors, 0 warnings** (Phase 6 closed with one unused-variable warning in a test; removed)                                                                                                                 |
| Unit and integration (Vitest)                                           | 83 files passed, 1 skipped (84); **1,307 tests passed, 4 skipped** (1,311). Phase 6: 1,247 passed. The 60 new tests: 24 delivery list, 32 international email, 4 elsewhere, from the new route in the security matrix |
| Plain production build, QA build, reports-QA build                      | exit 0, 0, 0                                                                                                                                                                                                          |
| Main browser suite (Chromium, QA build)                                 | **75 passed, 0 failed** (Phase 6: 74; the extra one is `phase7-delivery-list.spec.ts`)                                                                                                                                |
| Account security (two-step sign-in)                                     | 2 passed                                                                                                                                                                                                              |
| Email and authentication                                                | 6 passed                                                                                                                                                                                                              |
| Monthly report review and PDF                                           | 12 passed                                                                                                                                                                                                             |
| Preflight (`--build`, throw-away environment), secret scan              | passed, "No secrets found"                                                                                                                                                                                            |
| Migration check, seven older databases                                  | all ok, nothing lost or changed                                                                                                                                                                                       |
| WSL Ubuntu: release and rollback / ops delivery / host hardening (root) | 48 checks / 14 checks / 6 checks: ALL PASSED                                                                                                                                                                          |
| Docker nginx proxy                                                      | 18 checks: ALL PASSED                                                                                                                                                                                                 |
| axe-core, 48 page-views, final plain build                              | **0 violations**                                                                                                                                                                                                      |
| Overflow with hostile content, 4 widths, owner and parent               | none                                                                                                                                                                                                                  |
| Console and CSP, owner and parent                                       | clean                                                                                                                                                                                                                 |
| Responsive and console sweep, Chromium / Firefox / WebKit               | 96 page-views each; no overflow, no console error                                                                                                                                                                     |

The first full run (`phase7-final-regression.log`) had identical counts (1,307 unit, 75 / 2 / 6 / 12 browser).

Also on the final tree: performance (section 3), axe and sweeps (section 5), preflight with a throw-away environment (passes), secret scan (no secrets found), migration check of seven older databases through migration 012 (integrity ok, 0 foreign-key violations, no table lost, no existing data changed, a second open stable, original files untouched; `evidence/p7-migration-report.json`), WSL Ubuntu: release and rollback harness (48 checks), ops-delivery (14 checks) and host hardening (6 checks, run as root: the first attempt without root failed on `nft` and `sshd`, which need privileges), and the nginx proxy test in Docker (18 checks; a first attempt inside WSL failed because WSL has no Docker, which is a wrong-environment run, kept as `...WRONG-ENVIRONMENT...log`).

**Skipped (4, intentional):** `deploy-scripts.test.ts` (whole file), one test in `preflight.test.ts` and two in `ops-review-fixes.test.ts` are `skipIf(win32)`; covered on Linux by the WSL harnesses above; the three files themselves were not run on Linux. **Not run:** Firefox and WebKit end-to-end suites (swept only); real devices; any real provider; load beyond the Phase 5 smoke check.

**History, for honesty.** In this phase: (1) my first pagination tests all passed at once, so I mutated the code; one mutation survived, which showed a gap in my fixture, and I added the missing case. (2) The first rebuild after the screen split failed because the bundler requires the loading options written inline; fixed. (3) The first axe run on the final build found two things my earlier changes had not covered (section 5). (4) Preflight needed a throw-away environment and a non-placeholder origin; host tests need root. None of these reached the full regression as a failure; the first full run was green.

## 12. Remaining risks and deferred decisions

| Item                                                                                                                | Severity                 | Classification                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------ |
| No academy approval step (proposal ready)                                                                           | Medium (product)         | Needs owner approval                       |
| No retention for delivery data (proposal ready; pilot-safe, long-term not)                                          | Medium over time         | Needs owner approval                       |
| WP8: alert logic and rollback (assessed, reproduced)                                                                | Medium / Low             | Needs owner approval to change the scripts |
| No alert destination, external uptime probe or log shipping                                                         | **Blocks production**    | Deferred to deployment                     |
| ZeptoMail adapter not built; password recovery and verification are off until it is                                 | Needed before production | Deferred to deployment                     |
| Largest paint about 2.8 s on the lab profile                                                                        | Medium                   | Needs real-device validation               |
| No real screen-reader, device or user test; Firefox and WebKit only swept                                           | Medium                   | Needs real-device/manual validation        |
| The acceptance plan has not been performed                                                                          | n/a                      | Needs manual validation                    |
| The quiet background download is extra data for users on metered plans (skipped when the browser asks to save data) | Low                      | Needs owner awareness                      |
| No formal penetration test (Phase 6 checks stand; nothing in Phase 7 touches authentication)                        | n/a                      | Needs owner decision                       |
| Academy-wide delivery log screen not built                                                                          | Low                      | Needs owner decision                       |
| Cosmetic double border on the fees search box on narrow widths                                                      | Low                      | Not done                                   |
| Fixes 1a, 1b, 2, 3, 4 of `docs/WP8_OPEN_FINDINGS.md`                                                                | see section 8            | Needs owner approval                       |
| `origin-check-...@example.com` test account in the developer's own local database                                   | Info                     | Unchanged                                  |

## 13. Changed-file inventory (Phase 7, against `phase6-final-snapshot`)

16 modified, 15 added, 0 deleted:

```
A docs/ACADEMY_APPROVAL_PROPOSAL.md
A docs/ACCEPTANCE_TEST_PLAN.md
A docs/DELIVERY_DATA_RETENTION.md
M docs/EMAIL.md
A docs/PHASE7_REPORT.md
A docs/WP8_OPEN_FINDINGS.md
A src/app/api/workspaces/[academyId]/communication/jobs/route.ts
M src/components/ui/primitives.tsx
M src/domain/communication.ts
M src/features/workspaces/academy-portal.tsx
M src/features/workspaces/communication-controls.tsx
A src/features/workspaces/delivery-job-list.css
A src/features/workspaces/delivery-job-list.tsx
M src/features/workspaces/portal-fees.tsx
A src/features/workspaces/portal-lazy.tsx
A src/features/workspaces/portal-screen-boundary.tsx
M src/features/workspaces/portal-settings.css
M src/features/workspaces/portal-settings.tsx
M src/hooks/use-communication.ts
A src/hooks/use-delivery-jobs.ts
M src/server/communication-repository.ts
M src/server/communication-service.ts
M src/server/database.ts
A src/server/migrations/012-delivery-job-paging.ts
M src/styles/globals.css
M tests/e2e/phase6-finance.spec.ts
A tests/e2e/phase7-delivery-list.spec.ts
M tests/unit/code-inventory.test.ts
A tests/unit/communication-jobs.test.ts
A tests/unit/email-international.test.ts
M tests/unit/security-matrix.test.ts
```

Purpose: `communication-repository.ts`, `communication-service.ts`, `domain/communication.ts`, `migrations/012-delivery-job-paging.ts`, `database.ts`, the new jobs route, `use-delivery-jobs.ts`, `delivery-job-list.tsx` and `.css`, `communication-controls.tsx` and `use-communication.ts` (section 4); `portal-lazy.tsx`, `portal-screen-boundary.tsx`, `academy-portal.tsx` (section 3); `primitives.tsx`, `globals.css`, `portal-settings.tsx` and `.css`, `portal-fees.tsx` (section 5); `code-inventory.test.ts` (the reviewed-SQL list gains the paged query's fixed fragments), `security-matrix.test.ts` (the new route), `phase6-finance.spec.ts` (an unused variable removed); new tests `communication-jobs.test.ts`, `email-international.test.ts`, `phase7-delivery-list.spec.ts`; documents `EMAIL.md` (rewritten section 16), `ACADEMY_APPROVAL_PROPOSAL.md`, `DELIVERY_DATA_RETENTION.md`, `WP8_OPEN_FINDINGS.md`, `ACCEPTANCE_TEST_PLAN.md`, `PHASE7_REPORT.md`.

## 14. Reproducible patches and checksums

The patches and their SHA-256 checksums are in the delivery copy of this report (`phase5-delivery/PHASE7_REPORT.md`): a file cannot contain its own checksum.

## 15. Recommendation

Proceed to your acceptance testing on a local or staging build with `docs/ACCEPTANCE_TEST_PLAN.md`, and take the four decisions (approval, retention, WP8 changes, ZeptoMail after deployment) in your own time: none blocks the testing. **Do not call the application production ready.** Before production: a server, a domain, the deployment rehearsed once from `docs/DEPLOYMENT.md`, alert routing and an external uptime probe, backups off the server, an email provider built and tested from the deployed host, a real-device and screen-reader test, and your decision on the questions above. Local release readiness is not production validation.
