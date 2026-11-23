# WP2 — Data fetching and scalability: implementation report

Branch `codex/day1-integration`, HEAD `6837e84`, working tree uncommitted. The
historical baseline is in
[WP2_DATA_FETCHING_BASELINE.md](WP2_DATA_FETCHING_BASELINE.md) and is unchanged.
"WP1" below means the recorded working-tree state before WP2 began (git tree
`dbdc299`), which is also what the A/B builds were built from. Every "before"
figure uses the baseline's method and dataset (the synthetic Bharat academy, 60
players). Sizes are decoded JSON bytes unless "wire" is stated; KB = 1,000 bytes.

## 1. Status

**WP2 is not complete.** Every screen an Owner, Admin or Coach can open now
reads only what it needs: no staff screen loads the whole-academy payload any
more. What keeps WP2 open:

1. **The production proxy's compression has not been verified** (§8). No
   deployment was available; this is an outstanding deployment requirement.
2. **The second independent review** (§12) found no blocking defect and a list of non-blocking items, all fixed or
   recorded (§12); the fixes were made after that review and were checked by the
   gates and new tests, not by a third review. Treat sign-off on WP2 as yours.
3. **Fee account size is still linear in invoices** (§7). Its server cost is
   fixed (1,458 → 19 statements; about 1.8 s → 28 ms at twelve months of
   invoices), but the Owner's payload is still ~1 MB for twelve months of
   invoices for 60 players. Bounding it needs paging with server-side totals
   and an export path, which changes what the Fees screen shows. That is a
   product decision, not made here.
4. **Calendar and Training still load every session in full** (268 KB of their
   284 KB). A summary list is available (`view=summary`, with counts) but the
   two screens' editors use the full session records, so I did not switch them
   without a decision.

| Item                                    | Result                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WP2.1 Remove unnecessary reloads        | Complete                                                                                                                                                                                                                 |
| WP2.2 Compression                       | Complete in the application; **production proxy not verified** (§8)                                                                                                                                                      |
| WP2.3 Bootstrap and Home summary        | Complete for Owner, Admin, Coach; Home SQL cost measured, not changed (§9)                                                                                                                                               |
| WP2.4 Focused records, screen by screen | **All staff screens migrated** (§6): Reports list, detail and monthly review editor, Players, Training, Calendar, Fees, Settings, Messages, Development, session attendance and evidence. Remaining: items 3 and 4 above |
| WP2.5 Academy-scoped store              | Complete; freshness and access rules strengthened (§4)                                                                                                                                                                   |
| Parent Home cold-load regression        | Cause found and fixed (§5)                                                                                                                                                                                               |
| Extended synthetic coverage             | Done (§10)                                                                                                                                                                                                               |
| Independent review                      | Round 1 done, one blocking finding fixed; round 2 found no blocking defect; non-blocking items fixed or recorded                                                                                                         |

Nothing was committed, pushed, merged or deployed. No schema, index or stored
data change was made or proposed. `docs/FEATURE_D_REVIEW.md` and `test-results/`
are preserved (§14).

## 2. Measurements

Same data, browser and method as the baseline, on one Windows laptop over
loopback. Cold deep link, owner unless noted, median of five interleaved runs
per build; "WP1" is the build before WP2, "Final" is the final tree. **Timing
noise is real:** the same WP1 build measured 288 ms and 553 ms for the same
screen in two runs on this machine, so only the interleaved WP1-versus-Final
pair inside one run is comparable, and differences under about 30 ms are not
significant.

**Initial Home** (unchanged since the first report)

| Role          | Ready cold / warm / slow network | API requests | Decoded / wire      |
| ------------- | -------------------------------- | ------------ | ------------------- |
| Owner, WP1    | 322 / 193 / 15,214 ms            | 2            | 2,534 KB / 2,534 KB |
| Owner, Final  | 287 / 119 / **2,926 ms**         | 2            | 12.6 KB / 2.4 KB    |
| Coach, WP1    | 292 / 120 / 5,369 ms             | 1            | 438.7 KB / 438.7 KB |
| Coach, Final  | 269 / 121 / **2,828 ms**         | 1            | 1.5 KB / 0.7 KB     |
| Parent, WP1   | 234 / 94 / 2,965 ms              | 2            | 26.1 KB / 26.1 KB   |
| Parent, Final | 234 / 100 / 2,904 ms             | 2            | 26.1 KB / 3.3 KB    |

**First open of each screen** (the whole-academy payload was 2,523 KB for the
Owner and 438.7 KB for the Coach)

| Screen                          | WP1: requests, decoded | Final: requests | Final decoded (wire)   | Ready WP1 → Final                                    |
| ------------------------------- | ---------------------- | --------------- | ---------------------- | ---------------------------------------------------- |
| Reports (list, selected report) | 1, 2,523 KB            | 3               | ≈ 153 KB               | 296 → 302 ms                                         |
| Players                         | 2, 2,523 KB            | 4               | 132.6 KB (15.2 KB)     | 292 → 279 ms                                         |
| Fees                            | 1, 2,523 KB            | 2               | 43.7 KB + fee account  | –                                                    |
| Settings                        | 1, 2,523 KB            | 1               | 44.2 KB                | –                                                    |
| **Messages**, owner             | 2, 2,523.8 KB          | 5               | **54.9 KB (11.3 KB)**  | 497 → 372 ms                                         |
| Messages, parent                | 1, 25.8 KB             | 2               | 5.9 KB (2.3 KB)        | 297 → 335 ms (with the player in the URL: 316 → 314) |
| **Development**, owner          | 1, 2,523.2 KB          | 2               | **55.4 KB (9.6 KB)**   | 491 → 334 ms                                         |
| Development, parent             | 2, 25.9 KB             | 3               | 2.9 KB (1.5 KB)        | 341 → 346 ms (with the player: 283 → 302)            |
| **Reports editor**, owner       | 1, 2,523.2 KB          | 6               | **253.9 KB (25.4 KB)** | 528 → 503 ms                                         |
| **Training**, owner             | 1, 2,523.2 KB          | 3               | **283.9 KB (17.9 KB)** | 539 → 428 ms                                         |
| Training, coach                 | 1, 438.7 KB            | 3               | **68.6 KB (6.9 KB)**   | 439 → 362 ms                                         |
| **Calendar**, owner             | 1, 2,523.2 KB          | 3               | **283.9 KB (17.9 KB)** | 535 → 376 ms                                         |

Notes. (a) **Parent Messages and Development** moved 77% and 89% less data but
need one request more than WP1 (the child is known only after the small
payload), so their ready time is level with WP1 within noise (between −2 and +38 ms across three passes);
two earlier iterations were slower (+50 and +68 ms) and were improved by
bundling the four Messages reads into one request and starting them with the
payload when the URL names the player. (b) One pass of Parent Development with the player in the URL read 303 ms against 218 ms for WP1; a second and third pass the same screen read 346 against 341 ms and 302 against 283 ms (parent, player in the URL). Differences of this size are within this machine's noise, so parent Development is level with WP1, not faster.
(c) Training and Calendar are still dominated by the session list (268 KB of
full session records), see §1 item 4. (d) Wire sizes assume the application's
gzip; the production proxy is unverified (§8).

**After a save** (decoded; unchanged rows carry over from the first report)

| Action                    | WP1        | Final                                                                                                      |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| Edit a player             | 2,523.6 KB | 132.8 KB                                                                                                   |
| Create a session          | 2,530.0 KB | 1,104.9 KB at the time of measuring; Training's payload is now 284 KB, so this is now smaller (re-measure) |
| Record attendance (coach) | 447.3 KB   | 199.5 KB at the time of measuring; attendance is now a 4 KB read of that session (re-measure)              |
| Create a trial enrolment  | 2,524.7 KB | 133.9 KB                                                                                                   |
| Create a fee plan         | 2,540.4 KB | 11.8 KB (finance only)                                                                                     |
| Save trial rules          | 2,523.5 KB | 0.3 KB                                                                                                     |
| Prepare a monthly draft   | 2,532.1 KB | not re-measured since the editor moved to focused reads                                                    |

I did not re-measure the save rows marked above after the last migrations; the
request-count assertions in `wp2-requests.spec.ts` (one payload refetch per
save, attendance re-read once) did run and pass.

## 3. What changed in this continuation

1. **Messages and Development** moved off the whole-academy payload (§6).
2. **Reports editor** (monthly review workspace) moved to focused reads (§6),
   and the opt-in source check removes the wasted work in finding N5.
3. **Calendar and Training** no longer load attendance and evidence: they are
   read for the open session (§6).
4. **Fee account**: the quadratic server cost was found and fixed (§7).
5. **Store**: a 403 no longer empties the store (§4, review round 1).
6. Stable ordering for parent-scoped queries (N9 part), the unexplained
   `ECONNRESET` investigated (§9), Home SQL cost attributed (§9).

## 4. Cache freshness and security

**The 20-second window.** Every API request is authorised again by the server,
and each section change re-runs the server page's membership check (a refusal
there replaces the portal). The window therefore only decides how long
_already-fetched, already-authorised_ data may be shown again without a new
request. Setting it to 0 everywhere would make screens re-download what the user
has already seen, and would not remove the real exposure, which is the round
trip before the server's refusal arrives. It is kept at 20 s for ordinary data.

- **Sensitive data is never served from memory to a screen that was not showing
  it.** These entries are fetched every time a screen opens them, and are hidden
  (not just refetched) while that happens: the fee account, the communication
  view, an opened report (private notes, sources), the Messages bundle (message
  text, report content, internal notes for staff), a player's full reports and
  evidence (staff notes) and a session's evidence. Concurrent components showing
  the same entry share it. This closes review finding N3: **no Owner, Admin or
  Coach screen reads the general whole-academy payload any more**, so that
  payload's private report fields and conversation notes are no longer cached for
  staff at all. Parents and Support still receive a payload, but it is already
  sanitised by the server (approved snapshots only, no sources, no internal
  notes).
- **A refusal that means ended access empties the store at once.** A 401 drops
  everything. A 403 is different (the server also uses it for a role limit or a
  business rule on one action): it marks only its own entry as refused and asks
  the bootstrap once whether access still stands; only if that is refused too is
  the store emptied. A refused entry is not re-requested on remount within the
  window.
- **The store lives only as long as the portal** (dropped on unmount and before a
  full navigation for sign-out or an academy switch). On the server it never
  lives in module state.

No authorisation decision is cached: the store holds records only, never a
role, membership or permission. **Remaining exposure:** for up to 20 s a user
whose access was just revoked can see ordinary figures they had already fetched
when they return to a screen; the next server request is refused and clears
everything.

Tests: `academy-store.test.ts` (30), `use-store-entry.test.ts` (2),
`wp2-store.spec.ts` (revocation, dead session, a refused request that must not
blank the portal, no cross-academy data).

## 5. Parent Home cold load

**Cause: the shell-while-loading state I added.** A controlled A/B on one idle
machine: the WP1 build, the current build, and a variant identical to current
except it shows the old plain "Loading…" page while the payload is in flight. 15
interleaved cold loads each, Parent Home:

| Build                  | Ready (median, range) | Payload request starts | Script | **Layout** | Task total |
| ---------------------- | --------------------- | ---------------------- | ------ | ---------- | ---------- |
| WP1                    | 221 ms (214–234)      | 131 ms                 | 63 ms  | 41 ms      | 189 ms     |
| Current (before fix)   | **246 ms (239–270)**  | 141 ms                 | 70 ms  | **60 ms**  | 212 ms     |
| Variant, plain loading | 226 ms (222–236)      | 139 ms                 | 66 ms  | 41 ms      | 188 ms     |

The payload request starts at about the same time and returns in the same time;
the difference is the second, larger layout when the whole shell is drawn while
loading and then redrawn with content. **Fix:** the first paint of a screen that
must wait for the payload is the plain loading page again; once the portal has
shown its shell, later in-app navigations keep it. Re-measured: WP1 226 ms,
current 227 ms, variant 226 ms (layout 42/42/41).

## 6. Focused reads and screen migrations

All reads start from the viewer's `visibleRecords`; filters only narrow. A
request without query parameters is the long-standing response.

| Read                                                                           | Used by                                     | Notes                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /bootstrap`                                                               | every screen                                | 0 SQL statements; seeded by the server page                                                                                                    |
| `GET /home`                                                                    | staff Home                                  | summary, no payload                                                                                                                            |
| `GET /records/:kind?limit&cursor&filters`                                      | lists                                       | stable `ORDER BY rowid` for parent-scoped queries (N9)                                                                                         |
| `GET /records/report?view=summary[&review=1]`                                  | Reports list, editor queue, Players history | `review=1` adds the saved-source check for monthly drafts and is **opt-in** (N5)                                                               |
| `GET /records/report?view=content&player=`                                     | inside the Messages bundle                  | only the fields a message is prepared from: snapshot text, approved plan id/focus, source evidence ids (staff only), monthly flag (staff only) |
| `GET /records/report/:id?review=1[&sources=1]`                                 | opened report, editor                       | `sources=1` returns the sessions, reviewed observations, attendance and drill focus behind a monthly draft, nothing else                       |
| `GET /player-messages?player=`                                                 | Messages                                    | plans, updates, conversations and report content for one player, composed from the same filtered reads (one request instead of four)           |
| `GET /records/session?view=summary[&counts=1]`                                 | Players next session; counts available      | `counts=1` adds present/absent/excused/unmarked and awaiting-review counts, opt-in                                                             |
| `GET /records/attendance?session=`, `GET /records/evidence?session=&compare=1` | Calendar, Training, session desk            | `compare=1` adds `comparablePrevious`, replacing the client's comparison against all the player's evidence                                     |
| `GET /records/{plan,update,conversation,weekly}?player=`                       | Development, editor, delivery panel         | existing filters, now also for updates and weekly plans                                                                                        |
| `GET /?kinds=…`                                                                | reduced payloads                            | per-screen kind lists in `workspace-profiles.ts`                                                                                               |

**Screens.** Reports, Players, Training, Calendar, Fees and Settings as in the
first report. **Messages** reads the player's bundle (preview, message form,
conversations, delivery panel); a deep link `sourceReport` is checked against the
bundle. **Development** loads players, batches, plans and drills, the player's
weekly plans on their own, and the trial summary from its own endpoint. **Reports
editor**: the queue is the report summaries with the saved-source check; the open
report and its sources come from one detail read; "Other recorded development
reports" read the player's plans, reports and evidence. The `reports-editor`
profile is just players and batches. **Training and Calendar**: the session
panel and desk read the open session's attendance and evidence; `training` and
`calendar` no longer list those kinds.

**Honest notes.** `workspace-screen.tsx` and the list at the top of
`FootballTraining` (`training.tsx`) are unreferenced, dead code; they still read
the old payload shape and were left alone. The `counts=1` read exists and is
tested but no live screen displays those counts today (only the dead list did).

**Tests.** `records-query.test.ts` (50), `messages-development-reads.test.ts`
(17), `session-reads.test.ts` (10), `finance-scaling.test.ts` (3),
`report-review.test.ts` (16): each new read is checked for Owner, Admin, Coach
(own and another's player), Parent (own child, another family), Support
(audited), the other academy, an outsider and signed-out, and against the
long-standing reads kind by kind. Browser: `academy-portal.spec.ts` (Messages,
Development, parent flows), `monthly-report-review.spec.ts` (12, the editor),
`wp2-requests.spec.ts` (request counts, Calendar kinds, one attendance read per
open session), all fail if a screen reads a record kind its payload did not load.

## 7. Fee account scaling

The extended copy (§10) showed the fee account growing faster than the data. I
measured it on a copy of the Bharat database with 1, 3, 6 and 12 months of
invoices for 60 players (one invoice each per month; payments for two thirds,
half of those verified): `scripts/measure-fee-growth.ts`.

| Months (invoices) | Owner payload      | Statements before → after | Server time before → after | Parent payload |
| ----------------- | ------------------ | ------------------------- | -------------------------- | -------------- |
| 1 (60)            | 94 KB (12 KB gz)   | 138 → **19**              | 10 → 1.8 ms                | 2.5 KB         |
| 3 (180)           | 258 KB (36 KB gz)  | 378 → **19**              | 59 → 2.9 ms                | 6.7 KB         |
| 6 (360)           | 504 KB (70 KB gz)  | 738 → **19**              | 374 → 4.5 ms               | 12.9 KB        |
| 12 (720)          | 997 KB (137 KB gz) | 1,458 → **19**            | 1,838 → 27.6 ms            | 25.3 KB        |

**Cause:** for every invoice the view listed all payments and all adjustments of
the academy and filtered them, so cost grew with invoices × payments. The "before"
times were measured while other work was running, but the shape (12× the invoices,
180× the time) is the defect. **Fix:** payments and adjustments are read once,
grouped by invoice, and passed in (`bookedByInvoice` in `finance-service.ts`);
the single-invoice paths in the write actions are unchanged. Results are
identical (`finance-scaling.test.ts` checks every invoice's figures against its
own payments and adjustments and that statements stay constant as months are
added; it fails on the old code). **Not changed:** the Owner's payload still grows
linearly (≈ 1.4 KB per invoice). Bounding it needs paging, server-side totals and
a CSV export path, which changes what the Fees screen shows by default ("All
recorded periods"); that is the decision in §13.

## 8. Compression and the production proxy

The repository contains no reverse-proxy, hosting, Docker, CDN or deployment
configuration (`.github/workflows/ci.yml` only builds and tests; production is
`next start`). **The real proxy configuration and a production deployment are not
available to me, so I did not verify it and did not invent one. This is an
outstanding deployment requirement; the gate has not passed.**

Verified locally only: `compressibleJson` (`src/server/http.ts`, gzip for GET
bodies of at least 1 KB, `Vary: Cookie, Accept-Encoding`, `no-store, private`)
takes the Owner payload from 2,530,383 bytes to 118,792 on the wire. Localhost
results say nothing about the proxy. `scripts/verify-api-compression.mjs` checks
the deployed path end to end (single gzip layer, one gunzip yields JSON, decoded
body equals the unencoded response, no encoding without `Accept-Encoding`,
`Vary`, private no-store); it passes against the local build and fails on a
deliberately double-compressed stand-in. To close this item, run it against the
real deployment with an authorised signed-in cookie:

```
SPORTOZEN_COOKIE='<name>=<value>' node scripts/verify-api-compression.mjs https://<host>/api/workspaces/<academyId>
```

## 9. Database, server cost, and the other findings

**No schema, index or data change.** Every read uses the primary-key index.

**Home summary SQL (measured, not changed).** `scripts/profile-home-sql.ts`
attributes the statements: the Owner's 70 are 60 single-player lookups, 9 list
reads and 1 entitlement read; the Coach's 130 are 120 lookups, 9 lists, 1. The
test fixture's 3 players need fewer, so the count does grow with players. But the
60 lookups take 0.49 ms in total of the summary's ~21 ms; the time is the list
reads and JSON parsing (reports 7.0 ms, evidence 2.7 ms, attendance 1.3 ms,
sessions 0.8 ms). Removing the per-player lookups would save under 1 ms, so I did
not change a role-scoped path for it.

**N5** (wasted source check): fixed. The summary no longer computes the saved-
source check unless `review=1` is requested, and only the monthly review queue
requests it (tested). **N9**: parent-scoped record queries now have a stable
`ORDER BY` (the same `rowid` order the staff queries use). Paging remains offset
based: rows inserted between two page reads can shift; no list in the app pages
through more than one page today. **Fee account**: §7.

**`ECONNRESET` (not reproduced, cause unknown, no retries added).** The one
failure was `read ECONNRESET` on a plain `GET` of the whole workspace payload
(2.5 MB) through Playwright's request client, right after the PDF step of the
report-review suite. I tested the leading hypothesis, Node's 5-second keep-alive
(Next uses the Node default) closing an idle connection the client then reuses:
six idle gaps from 4.9 to 6 s, six trials each, against the production server,
with the default and with a 70-second keep-alive, gave **no resets**. I then read
the 2.5 MB payload 300 times back to back and 40 times after random 3–7 s idle
gaps: **340 of 340 succeeded, 0 resets**. (Responses with a non-200 status in the
first experiment were the auth endpoint at the longer idle gaps and are not
resets.) The failure did not recur in this continuation's full runs either. I
cannot name a cause; the evidence excludes keep-alive reuse and large-body
resets under these conditions, and I left the suite unchanged so any recurrence
fails loudly.

## 10. Extended synthetic coverage

`tests/unit/helpers/extended-fixture.ts` adds, through the real services,
payments (one verified, one pending), a trial enrolment, an approved and
published parent update, a conversation with a public and an internal message, a
weekly plan (a draft), a Platform Administrator and an authorised Support member
linked to one child. The original fixture and the original Bharat database are
untouched. `extended-entities.test.ts` (15) checks each for Owner, Coach, Parent,
Support, Platform Admin and the other academy. `scripts/extend-synthetic-copy.ts`
adds the same kinds at scale to a copy of the Bharat database.

| Owner read              | Original                | Extended                                            |
| ----------------------- | ----------------------- | --------------------------------------------------- |
| Whole payload           | 2,523 KB, 81 statements | 2,710 KB, 91 statements                             |
| Fee account (one month) | 11.1 KB, 18 statements  | 93.8 KB, 138 statements before the §7 fix, 19 after |
| Communication view      | –                       | 0.6 KB, 8 statements                                |
| Trial view (one player) | –                       | 0.9 KB, 13 statements                               |
| Report list             | 58.7 KB                 | 83.3 KB                                             |

## 11. Verification (final tree)

| Gate                                              | Result                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint, TypeScript                                | exit 0                                                                                                                                              |
| Unit tests                                        | 580 passed, 44 files                                                                                                                                |
| Production builds (CI and reports configurations) | compiled                                                                                                                                            |
| Browser, main suite                               | 65 passed (16.4 min)                                                                                                                                |
| Report review suite                               | 12 passed                                                                                                                                           |
| Simple session suite                              | 1 passed (the first attempt failed to start because a server left over from a gates run I had stopped still held its port; I removed it and re-ran) |

Local runs only; this is not a claim about GitHub CI.

**Existing tests I changed (none weakened; read these).**

1. `academy-portal.spec.ts` `workspaceReady`: it waited for the full-payload
   request when opening Home; it accepts the Home summary or payload read and
   still asserts 200 and the academy id. Added: a console watcher in every page
   that fails the test if a screen reads a record kind its payload did not load.
2. `academy-portal.spec.ts` parent fee step: I had replaced the page's finance
   wait with a direct API call; the review caught it, and the original wait is
   restored.
3. `simple-session-creation.spec.ts`: the interrupted "workspace refresh" matcher
   accepts the reduced payload URL as well; the behaviour under test is unchanged.
4. `wp2-requests.spec.ts`: the Calendar kinds assertion now lists the new kinds
   (without attendance and evidence) and asserts no attendance/evidence read
   happens at Calendar open; opening a session asserts one attendance and one
   evidence read for that session and none in the payload.
5. `monthly-report-review.spec.ts`: the same console watcher; no assertion
   removed.
6. `records-query.test.ts`: the monthly-draft test asks for `review=1` where it
   expects the saved-source check (the check is now opt-in, N5) and also asserts
   that a plain summary carries none.

**Incidents.** (a) The gates caught a real regression of mine: after the editor
moved to an asynchronous detail read, the report-review test "08b keeps … focus
across player changes" failed once; the cause was keyboard focus being lost when
the player select was rebuilt after the report loaded. Fixed (focus is restored
again once the report has loaded), and it passed in the following full runs.
(b) I once deleted a directory of tracked screenshots while removing test
byproducts and restored them exactly from HEAD. (c) Browser runs rewrite tracked
screenshots and `next-env.d.ts`; each time they were restored from HEAD.

## 12. Independent reviews

### Round 1 (earlier in this work)

A separate read-only agent reviewed the then-current diff (55 files) and ran the
unit suite and scratch scripts against the real store; it did not run a browser.

**Blocking, fixed. B1:** a 401/403 emptied the whole store, the portal unmounted,
a refused save destroyed the open form, and the Settings tabs looped on a 403
(`useCommunication` was enabled for every role and academy). The store now empties
only on a 401 or on a 403 the bootstrap confirms (§4); a refused entry is not
re-requested on remount; `useCommunication` is enabled only where the server will
answer; tests added (store unit tests and a browser test).

| #   | Finding                                                                | Resolution                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | A parent fee check was weakened to a direct API call                   | Original restored                                                                                                                                                            |
| N2  | Parent "Report unavailable" fell through to the plans card             | Fixed                                                                                                                                                                        |
| N3  | Whole-academy payload cached private report fields and internal notes  | **Closed**: no staff screen reads that payload any more (§4)                                                                                                                 |
| N4  | Overlapping invalidations aborted the first load                       | Fixed, tested                                                                                                                                                                |
| N5  | Source check computed for every draft but unused                       | **Fixed** (opt-in `review=1`, used by the editor queue)                                                                                                                      |
| N6  | The unloaded-kind guard ran in production; dead `workspace-screen.tsx` | I first made the guard development-only, then **reverted** that: tests run against production builds and need the guard to log. It only logs. The dead file is left in place |
| N7  | Portal cleanup could clear a newer academy's store                     | Fixed                                                                                                                                                                        |
| N8  | Refusal with a non-JSON body was not recognised                        | Fixed                                                                                                                                                                        |
| N9  | Offset paging; parent queries without `ORDER BY`                       | Ordering fixed; offset paging documented (§9)                                                                                                                                |
| N10 | Untested refusal/loop/concurrent paths                                 | Tested                                                                                                                                                                       |

### Round 2 (final tree)

A second read-only agent reviewed everything added since round 1 (35 files) plus
the whole diff, without running anything. **No blocking defect.** It confirmed by
reading the code: every new read starts from `visibleRecords`; the Messages
bundle is exactly the four filtered reads (no widening, extra parameters are a
400, SUPPORT gets sanitised plans and reports and no updates or conversations);
parents get no internal notes, `monthly` or source ids; `?sources=1` returns
only the report's sessions, reviewed observations (four fields, no staff notes),
the player's attendance and drill focus; the profile kind lists cover every
record kind Messages, Development, the editor, Training and Calendar read; the
fee-account change is equivalent; the portal-level prefetch shares the store
entry and does not double-request (I also confirmed one `player-messages` request
in the measured request lists). It could not run anything, so browser behaviour
rests on the gates in §11.

| #     | Finding                                                                                                                                                                              | Resolution                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-1  | No test proved drafts / revision requests are excluded from report content, or that staff (not parents) get `monthly` and `sourceEvidenceIds` (Messages' draft rules depend on them) | **Fixed**: new test follows a monthly report from draft, to revision requested, to approved for Owner, Admin, Coach, both parents, the other coach and Support                                                                       |
| R2-2  | The collapsed "Other recorded development reports" panel downloaded the player's whole report history on every player change                                                         | **Fixed**: it reads only once the panel is opened (or a deep link opens it)                                                                                                                                                          |
| R2-3  | A sensitive consumer that remounts in the same commit refetches and flashes "Loading…" (the editor's collapsed panel after each save)                                                | **Open, minor**: one extra request and a brief flash inside a collapsed panel; Messages avoids it through the portal-level prefetch                                                                                                  |
| R2-4  | Every communication command refetched the whole Messages bundle                                                                                                                      | **Fixed**: the bundle is tagged `workspace` only; `resolveReply`, the one command that writes a conversation, already invalidates it                                                                                                 |
| R2-5  | `playerMessages()` ran its four reads without a shared lookup scope                                                                                                                  | **Fixed** (one scope)                                                                                                                                                                                                                |
| R2-6  | Creating an invoice or an adjustment still summed every invoice's billed amount with the per-invoice listing                                                                         | **Fixed**: both now read payments and adjustments once (the 71 finance tests pass)                                                                                                                                                   |
| R2-7  | `counts=1` has no live consumer; a type comment overstated what it counts                                                                                                            | Comment fixed. The read is tested and unused by any live screen today (§6); stated, not claimed as a UI feature                                                                                                                      |
| R2-8  | Unreachable code that would silently show empty lists if reused (`Dialog` block in `portal-reports.tsx`, `workspace-screen.tsx`, the old list in `FootballTraining`)                 | **Open**, recorded in §6 and §13                                                                                                                                                                                                     |
| R2-9  | Evidence cache keys by player and by session shared a prefix                                                                                                                         | **Fixed** (`session-evidence:`)                                                                                                                                                                                                      |
| R2-10 | Some new tests restate the implementation (`reviewSubject` vs `reportReviewEligibility`; comparison vs `comparableEvidence`); the coach `?sources=1` test checks status only         | Acknowledged. The explicit negatives (no internal note, no staff note, 400s, cross-academy, draft exclusion) are independent checks. The coach case is covered by the draft/own-player test but not by an assertion on content scope |
| R2-11 | A failed refresh replaces Messages / attendance / the panel with an error card, losing local draft state; two stale comments                                                         | Comments **fixed**; the error-path behaviour is **open, minor**                                                                                                                                                                      |

It also noted that the Fees check in `academy-portal.spec.ts` now asserts that a
finance request happens when Fees opens (as the sensitive-data rule requires)
instead of asserting that none does; that is the intended behaviour and is stated
in §11.

## 13. Remaining work and decisions

1. **Production proxy compression** (§8): run the check against the real
   deployment. Not done; blocked on access.
2. **Fee account paging** (§7): needs a decision on the Fees screen's default view
   (paged invoices, server totals, CSV export). Server cost is already fixed.
3. **Calendar/Training session list as summaries** (§1 item 4): optional,
   saves about 170 KB of the remaining 284 KB, touches the session editors.
4. **Round 2 review findings** (§12), if any are open.
5. **Re-measure the save payloads** marked in §2 after the last migrations.
6. The unexplained `ECONNRESET` (§9) stays recorded as unexplained.
7. The dead code noted in §6 (`workspace-screen.tsx`, the old list in
   `FootballTraining`) can be deleted separately.

## 14. Git status and protected files

Branch `codex/day1-integration`, HEAD `6837e84` (unchanged). **Staged: 0.**
Tracked files modified: 70. Untracked: 50 (the WP1/WP2 source, test, script and
doc files, plus screenshots and evidence the existing QA specs write under
`docs/screenshots/`; I did not delete any of them). Nothing was committed,
pushed, merged or deployed.

Protected files: `docs/FEATURE_D_REVIEW.md` is unmodified (last written
2026-10-31 03:26). `test-results/` is present and nothing in it was deleted; the
existing `api-baseline` unit test rewrites `test-results/api-baseline.json` on
every run, so that one file's timestamp changed. Playwright output was sent to
`.local/` so it could not clear `test-results/`. `next-env.d.ts` and the tracked
screenshots that test runs rewrite were restored from HEAD each time. The dev
server on port 3005 is running and was not touched. Temporary files created for
measurement are under `.local/` (`e2e-ab-*.sqlite`, `wp1-baseline`) and the session
scratch directory; none is part of the source tree.
