# WP2 — Data fetching and scalability: investigation and baseline

Status: investigation only. No application code, schema or API was changed.
Measured 31 October – 1 November 2026 on `codex/day1-integration` at `6837e84`
plus the uncommitted WP1 working tree (request parsing, lookup scope, DEF-05).

Units: KB = 1,000 bytes, MB = 1,000,000 bytes. "Raw" means the JSON as sent
by the server today; "gzip" is a computed figure, not what is sent (see §6.3).

## Summary

- The academy portal has one read path. `useWorkspace` downloads the whole
  academy payload once when the portal opens, nothing renders until it
  arrives, and every successful save downloads it again in full.
- On the synthetic 60-player Bharat academy the owner's payload is
  **2,523,194 bytes** (81 SQL statements, about 26 ms to build in process).
  The historical 2.46 MB figure is close to this, but its dataset state and
  unit were not recorded, so this document uses only the re-measured value.
- **Reports are 56.5 %** of that payload. Approved report snapshots
  (667 KB) and the retained monthly source models (611 KB) account for 90 % of
  the report bytes. Evidence (23.5 %), attendance (9.4 %) and sessions (8.4 %)
  make up most of the rest.
- **API responses are sent uncompressed** by the production server
  (`next start`); HTML pages are gzip-compressed. On an emulated slow 4G
  connection the owner's Home took 15.2 s to appear, 12.2 s of it downloading
  the payload. On a local loopback connection it took 0.32 s cold.
- **Every save costs one full reload**: about 2.52 MB for the owner and
  0.44 MB for a coach. Finance saves reload the workspace even though
  finance writes no workspace data; trial rule saves do the same.
- Home needs counts and a few short lists; it receives the entire academy.

Root causes (detail in §5):

1. One monolithic client state is the source of truth for every screen and
   gates the first render.
2. "Reload everything after a write" is the only consistency mechanism.
3. The read model is the storage model: stored bodies, including approval
   snapshots and generated source models, are returned to list screens.
4. Side hooks refetch on object identity or on mount, not on what changed.
5. API JSON is not compressed in transit.
6. No server-side filtering or pagination is used, although permission-scoped
   per-kind endpoints already exist.

## 1. Current architecture and request flow

```
Browser                                  Next.js server (node:sqlite)
───────                                  ────────────────────────────
GET /workspace/:id ────────────────────▶ page.tsx: context() = session +
                                          membership + academy + entitlement
                   ◀── HTML (gzip) ────── renders <AcademyPortal key=:id>
hydrate AcademyPortal
└─ useWorkspace(:id) mount effect
   GET /api/workspaces/:id ────────────▶ context() + workspace():
                                          visibleRecords × 17 kinds, members,
                                          guardians, entitlement, monthly
                                          freshness (owner: 81 statements)
                   ◀── 2.52 MB JSON, uncompressed
render PortalShell + section            (nothing renders before this arrives)
└─ section hooks: /finance, /trials?player=, /communication,
   /communication/announcements, /places

Section change:
router.push(?section=…) ───────────────▶ RSC GET /workspace/:id (context() again)
                   ◀── ~1.3 KB RSC ────── AcademyPortal stays mounted; no reload

Save:
POST|PUT|PATCH /api/workspaces/:id/… ──▶ service write (BEGIN IMMEDIATE)
then GET /api/workspaces/:id ──────────▶ full rebuild, as on first load
(+ /finance or /trials refetch for finance and trial saves)

Academy switch / sign-out:
window.location.assign(…)                full navigation; all client state dropped
```

Code references:

- Entry page re-checks access on every render and keys the portal by academy:
  `src/app/workspace/[academyId]/page.tsx:15-22`.
- Single client store: `src/hooks/use-workspace.ts:57-191`. Mount fetch
  `:78-97`; `reload()` `:66-77`; `mutate()` reloads after every write `:98-158`
  (`await reload()` at `:113-114`).
- The portal renders a loading screen until the payload arrives:
  `src/features/workspaces/academy-portal.tsx:72-91`.
- Payload builder: `src/server/workspace-service.ts:148-150` (`workspace()`
  wraps `workspacePayload()` in the WP1 lookup scope), records for all 17
  kinds at `:151-154`, kinds list `:49-67`.
- Academy switching is a full navigation by design
  (`src/lib/private-navigation.ts`). `docs/MULTI_ACADEMY_FOUNDATION.md`
  states that private records are fetched "without client storage or shared
  query caches" and that the server rechecks membership on every operation.

## 2. Full-workspace API call-site inventory

### 2.1 Direct callers of `GET /api/workspaces/[academyId]`

| Call site | Trigger |
|---|---|
| `use-workspace.ts:78-97` | Portal mount: every full page load of `/workspace/:id` (sign-in redirect, browser refresh, academy switch, deep link). |
| `use-workspace.ts:113-114` (`reload()` inside `mutate`) | After **every** successful `save`, `action`, `configure`, `training`, `period`, `communication` or `finance` call. |
| `use-trials.ts:100` | After every trial command, in parallel with the trial refetch. |
| `academy-portal.tsx:82` | "Retry workspace" button on a load error. |
| `portal-settings.tsx:373` | Reload after an academy-settings save error or conflict. |
| `workspace-screen.tsx:47` | **Unreachable.** Nothing imports `WorkspaceScreen`; it is legacy code that still compiles. |

No server component fetches the payload. Nineteen e2e, simulation and
professional test files call the endpoint directly, mostly to read state for
assertions (for example 26 GET calls in `tests/e2e/workspaces.spec.ts`), so
its shape is a test contract.

### 2.2 Mutation entry points (each one ends in a full reload)

All of these go through `useWorkspace.mutate`, which holds a single-flight
lock and then awaits a full reload.

| Wrapper | Endpoint | Call sites in the live portal |
|---|---|---|
| `save` | `POST/PUT /records/:kind[/:id]` | `portal-players.tsx:95,276`; `portal-training.tsx:253`; `plan-and-report.tsx:114,251,311`; `messages.tsx:93,164,332`; `parent-preferences.tsx:34,89`; `academy-structure.tsx:27,52` |
| `action` | `POST /actions` | `messages.tsx:377,400,414,426,525,562`; `plan-and-report.tsx:427`; `period-plans.tsx:510`; `report-review-workspace.tsx:693`; `portal-settings.tsx:1323,1445`; `academy-structure.tsx:98` |
| `training` | `POST /training` | `training.tsx:31` (`useTraining.submit`, used by `portal-calendar.tsx:64`, `portal-training.tsx:51`, `training.tsx:76`: sessions, attendance, evidence, review, status, squads, venues); `portal-settings.tsx:1147` |
| `period` | `POST /periods` | `period-plans.tsx:23`; `report-review-workspace.tsx:222,678,908` |
| `communication` | `POST /communication` | `communication-controls.tsx:71,248,319,430,502,595,629`; `messages.tsx:505` |
| `configure` | `PATCH /` | `use-academy-settings.ts:80` |
| `finance` | `POST /finance` | `use-finance.ts:77`, then a separate finance refetch at `:86` |

### 2.3 Other data hooks that depend on the workspace

| Hook (mounted by) | Request | Refetch trigger | Note |
|---|---|---|---|
| `useFinance` (`portal-home.tsx:37` owner/admin Home card, `portal-parent-home.tsx:33`, `portal-fees.tsx:53`) | `GET /finance` | Each mount; after its own saves | Each mounted instance fetches separately; Home → Fees → Home fetches finance three times. |
| `useTrials` (`portal-trials.tsx:43,653`) | `GET /trials?player=` | Mount and player change; after its own saves (also reloads the workspace) | |
| `useCommunication` (`communication-controls.tsx:17` settings panel, `:456` delivery panel) | `GET /communication` | Effect depends on `[w.data]` (`use-communication.ts:44`) | Refetches after **every** workspace reload while mounted. |
| `useAnnouncements` (`batch-announcements.tsx:60`) | `GET /communication/announcements` | Mount; after its own commands | Independent of the workspace. |
| `useSessionLocation` (`session-location-search.tsx:18`) | `GET /places` | Mount | Independent. |

Existing read endpoints the portal does **not** use:
`GET /records/:kind` and `GET /records/:kind/:id`
(`records/[kind]/route.ts:13-27`, `records/[kind]/[recordId]/route.ts`).
They are already scoped by `visibleRecords` / `visibleRecord`.
`GET /finance` and `GET /trials` already accept `?player=`.

## 3. Payload breakdown

Measured in process with the server modules on a temporary copy of
`.local/e2e-bharat-day2-…sqlite` (academy `65a3535d…`, 60 players,
6 batches, 1 owner, 6 coaches, 60 guardians, August–October 2026 data).
Personas are the first active member of each role. Two builds of each payload
were byte-identical.

### 3.1 By role

| Role | Raw bytes | gzip (computed) | brotli q4 (computed) | SQL statements | In-process build | Records visible |
|---|---|---|---|---|---|---|
| Owner | 2,523,194 | 118,018 | 68,463 | 81 | 26.5 ms | 60 players, 60 sessions, 600 attendance, 504 evidence, 120 reports |
| Coach (U8) | 438,735 | 21,294 | 15,513 | 139 | 23.2 ms | 10 players, 10 sessions, 100 attendance, 84 evidence, 20 reports |
| Parent (U8 guardian 1) | 25,775 | 2,909 | 2,729 | 19 | 1.5 ms | 1 child, 2 approved reports, 1 plan |

The dataset has no ADMIN or SUPPORT members.

### 3.2 Owner payload by section and record kind

| Part | Count | Bytes | Share | Avg bytes/record |
|---|---|---|---|---|
| `records.report` | 120 | 1,425,225 | 56.5 % | 11,877 |
| `records.evidence` | 504 | 593,035 | 23.5 % | 1,177 |
| `records.attendance` | 600 | 237,043 | 9.4 % | 395 |
| `records.session` | 60 | 212,026 | 8.4 % | 3,534 |
| `records.player` | 60 | 19,945 | 0.8 % | 332 |
| `members` | 67 | 10,275 | 0.4 % | |
| `guardians` | 60 | 7,797 | 0.3 % | |
| `records.drill` | 24 | 7,685 | 0.3 % | 320 |
| `records.squad` | 6 | 4,134 | 0.2 % | 689 |
| `records.plan` | 6 | 4,009 | 0.2 % | 668 |
| academy, membership, viewer, subscription, venue, branch | | 1,712 | 0.1 % | |
| weekly, program, update, conversation, fee, preference, dietary | 0 | | | |

### 3.3 By the requested categories

| Category | Owner bytes | Where it comes from |
|---|---|---|
| Players and guardians | 27,742 (1.1 %) | `records.player`, `guardians` |
| Coaches and memberships | 10,548 (0.4 %) | `members` (all 67 members, including 60 parents), `membership`, `viewer` |
| Sessions and attendance | 449,069 (17.8 %) | `records.session` (agenda 86.7 KB, roster 48.5 KB, objectives 17.8 KB), `records.attendance` |
| Coach evidence | 593,035 (23.5 %) | `records.evidence` (observation, conditions and method text) |
| Reports and snapshots | 1,425,225 (56.5 %) | §3.4 |
| Finance, invoices, fee plans | 2 (empty legacy `fee` kind) | Not in this payload. Served by `GET /finance` (owner: 11,111 bytes, of which 10,801 are invoice suggestions for 60 players; the dataset has no plans or invoices). |
| Trials | 0 | Not in this payload. Served per player by `GET /trials?player=` (0.2 KB with no enrolment). |
| Communications | 2 (empty `update`, `conversation`) | `GET /communication` 643 bytes; announcements 503 bytes. |
| Other | 17,267 (0.7 %) | drills, batches (squads), plans, academy configuration, subscription, venue, branch |

**Dataset gap:** the Bharat seed has no invoices, payments, trials, updates,
conversations or weekly plans. Their size at scale cannot be measured on this
dataset; WP2 needs an extended synthetic seed before sizing those endpoints.

### 3.4 Report records

Summed over the owner's 120 reports (all approved, all monthly reviews):

| Field | Bytes | Notes |
|---|---|---|
| `snapshot` | 667,248 | Approval-time copy rendered on screen and in PDFs. Includes `evidence` 287,821, `presentationData` 175,972 (`measurementSeries` 132,640), `activities` 94,280. |
| `monthlySources` | 610,739 | Generated draft sources, retained after approval. `model` is 531,341 bytes (`evidence` 256,369, `presentationData` 150,160, `activities` 94,280). |
| `observation`, `closingNote`, `nextStep` | 54,975 | Report text; repeated inside `snapshot`. |
| `sourceEvidenceIds`, `monthlySources.sessionIds`, `monthlySources.evidenceIds` | 57,456 | ID lists; `sourceEvidenceIds` is set from `monthlySources.evidenceIds` (`period-service.ts:549`). |
| `approvedPlan` | 7,500 | |
| `reportingPeriod`, `monthlySources.period` | 27,600 | The same value stored twice. |

Duplication, measured on the same payload:

- In all 120 reports, `monthlySources.model.focus`, `.practised` and
  `.activities` are byte-identical to the snapshot's fields (116,532 bytes).
  `model.presentationData` and `model.evidence` differ from the snapshot in
  every report: the snapshot adds the coach evaluation and reshapes evidence.
- 462 of the 702 evidence entries inside snapshots repeat the text of a live
  evidence record that is also in the payload.
- What-if figures only (not proposals; consumers depend on these fields):
  - Without `monthlySources.model` on approved reports, the owner payload
    would be 1,990,751 bytes raw (−21 %), or 108,499 gzip (−8 %).
  - With reports reduced to summary fields (id, player, period, reporting
    period, status, version, correction link, plan id), it would be
    1,136,060 bytes raw (−55 %), or 66,640 gzip (−44 %). The 120 report
    summaries themselves come to about 38 KB.

Who reads these fields today:

- **The snapshot** is the source of truth for approved reports on screen,
  in PDFs, in parent views, practice and messages (`portal-reports.tsx`,
  `plan-and-report.tsx`, `practice.tsx`, `messages.tsx`, `portal-records.ts`,
  `portal-source-selection.ts` and others). It must stay available for detail
  views.
- **`monthlySources`** is read for approved reports as well as drafts:
  - `portal-reports.tsx:655,696,723-736` (prefers the snapshot, shows source
    ids);
  - `period-plans.tsx:338,440,450`;
  - `report-review-workspace.tsx:61,119,643-647,790-888`;
  - `messages.tsx:68`;
  - `plan-and-report.tsx:295`.

  It cannot simply be dropped; it can move to a detail request.
- **The server** uses `monthlySources` for freshness checks
  (`period-service.ts:205`). That never runs on this dataset, because all
  reports are approved.

## 4. Screen-by-screen data requirements

"Unused" means present in the payload and not read by the screen.

| Screen | Displays | Needed for operations | Fetched but unused | Shape needed | Filtering / pagination |
|---|---|---|---|---|---|
| **Home (owner, admin, coach)** `portal-home.tsx:99-151` | Greeting (own member name); next and today's sessions (≤ 3, roster size, batch); counts of active players, batches, upcoming sessions and open conversations; 4 most recent activities (reviewed evidence, last conversation message); queues of evidence awaiting review, report drafts and unmarked attendance today; this month's report progress and approved-report count; focus plan; branch present; finance outstanding and pending counts (separate `/finance`) | Navigation only | All report snapshots and monthly sources, evidence bodies, attendance outside today, session agendas and objectives outside next/today, guardians, drills, venues | Summary: counts plus at most about 10 small items | Today and upcoming only; no pagination |
| **Home (parent)** `portal-parent-home.tsx` | Linked children, approved weekly plans, published updates, `parentSchedule`, the child's fees (`/finance`) | Navigation | Little; the parent payload is 25.8 KB, 89.6 % of it two approved report snapshots | Child-scoped summary | Per child |
| **Players** `portal-players.tsx` | Directory (name, batch, age category, status, coach, search `?q=`); profile (player, guardians, current plan, approved-report history via `playerDevelopmentHistory`, next session); trials panel (own endpoint) | Create and edit player (`save`), trial commands | Sessions beyond the player's next one, all attendance and evidence, other players' reports | Directory summaries plus per-player detail | Server-side search and paging at scale |
| **Calendar (sessions)** `portal-calendar.tsx:126-140,853-858` | Week or 42-day month grid filtered by batch, coach, status and venue; session drawer with attendance and evidence for the selected session | Session commands (`training`) | Reports, evidence and attendance outside the selected session, sessions outside the visible window | Session summaries in the window plus selected-session detail | Date window `from`/`to` plus filters |
| **Training and attendance** `portal-training.tsx:106-122`, `training.tsx:77-118` | Session list; selected session (agenda, objectives, roster); its attendance and evidence; drills, venues, batches, branches | Session, attendance, evidence and review commands | Reports, and attendance or evidence for other sessions | Per-session detail; list summaries | By session; list by date |
| **Reports** `portal-reports.tsx:76-90`, `report-review-workspace.tsx` | Player list with each player's report status for the period (client-side paging already exists); selected report (`snapshot`, or `monthlySources.model` for drafts); review sources (the month's sessions, attendance and evidence for one player); freshness | Prepare, save, approve and correct (`period`, `action`) | Full bodies of every report not on screen | List summaries plus one report detail plus review sources for one player and month | Period, batch, status, page |
| **Finance** `portal-fees.tsx`, `portal-fee-editor.tsx`, `portal-fee-detail.tsx` | Finance view from `/finance`; player names and batches from the workspace | Finance commands | From the workspace: everything except player and batch names | Existing finance endpoint plus player lookup | Invoices and payments grow without bound and will need paging; `?player=` exists |
| **Trials** `portal-trials.tsx` | Per-player trial view from `/trials?player=`; members | Trial commands | The full workspace reloaded after each command | Existing endpoint plus the updated player | Per player (exists) |
| **Messages and communications** `messages.tsx:29-42`, `communication-controls.tsx` | The selected player's conversations, updates, plans and reports; members; delivery details (`/communication`); announcements (separate) | Conversation, update and communication commands | Every other player's records | Per-player thread data | Per player |
| **Settings** `portal-settings.tsx` | Academy configuration, branches, venues, members, subscription, communication settings (`/communication`) | `configure`, invitations, membership actions | Reports, evidence, attendance, sessions | Configuration and members | None |

The portal shell itself (`portal-shell.tsx`) needs the academy, membership,
viewer and members (for names). Player selectors need the players' id, name
and batch.

## 5. Request amplification findings

Measured in a real browser (§6.2). Every phase was recorded after its screen
had finished loading. "Full reload" means `GET /api/workspaces/:id`.

Bytes are the decoded response sizes as measured. The owner's payload grows
slightly as the run creates records.

| Action (role) | Requests, in order | Full reloads | Response bytes |
|---|---|---|---|
| Edit a player (owner) | `PUT /records/player/:id` (353) → full reload (2,523,219) → RSC navigation (3,125) | 1 | 2,526,697 |
| Create a session draft (owner) | `POST /training` (1,429) → full reload (2,528,608) → RSC navigation (3,175) | 1 | 2,533,212 |
| Record attendance (coach) | `POST /training` (3,185) → full reload (444,148; includes the owner's new session for this batch) | 1 | 447,333 |
| Create a fee plan (owner) | `POST /finance` (359) → full reload (2,528,607) → `GET /finance` (11,484) | 1 | 2,540,450 |
| Save trial rules (owner) | `POST /trials` (118) → `GET /trials?player=` (162) → full reload (2,523,219) | 1 | 2,523,499 |
| Create a trial enrolment (owner) | `POST /trials` (597) → `GET /trials?player=` (850) → full reload (2,523,218) | 1 | 2,524,665 |
| Prepare a monthly draft (owner) | `POST /periods` (1,697) → full reload (2,530,383) → RSC navigation (3,205) | 1 | 2,535,285 |
| Open Messages (owner) | RSC navigation (3,082) | 0 | 3,082 |
| Open a player's conversation (owner) | RSC navigation (3,126) → `GET /communication` (643) | 0 | 3,769 |
| Open Reports, then a report (owner) | none observed | 0 | 0 |
| Switch section (any role) | 0–1 RSC navigation (about 3 KB), plus the screen's own request: `/finance` for Fees and owner Home (11,111), `/finance` for parent Home (313), `/api/auth/get-session` for parent More | 0 | ≤ 15 KB |

Findings and their root causes:

1. **Every save re-downloads the academy** (root causes 1 and 2).
   `mutate` always awaits `reload()` (`use-workspace.ts:113-114`). The write
   responses already contain the saved record (session, player, report,
   attendance result), but they are discarded; the only exception is a
   training-session merge used when the reload fails (`:116-145`).
2. **Finance saves reload data that finance never changes.** Finance writes
   only to `academy_finance_records`, `academy_finance_history` and
   `academy_finance_submissions` (`finance-repository.ts`,
   `finance-service.ts`). The workspace payload has no finance data apart
   from the empty legacy `fee` kind. Yet `useFinance.mutate` calls
   `workspace.finance`, which reloads the workspace, and then refetches
   finance (`use-finance.ts:77,86`): two reads per save, one of them 2.52 MB.
3. **Trial saves always reload the workspace.** Enrolment and conversion do
   change one player's `status` (`trial-service.ts:337,427`), so the player
   list must refresh. Trial-rule saves change no workspace data at all
   (`use-trials.ts:100`).
4. **Communication data refetches on any workspace change.**
   `useCommunication` depends on the whole workspace object
   (`use-communication.ts:44`). While the delivery panel or the
   communication settings panel is mounted, every save adds a
   `GET /communication`. This is traced from code; the browser run opened the
   panel but performed no save while it was mounted.
5. **The first render waits for the whole payload.** The portal shows
   "Loading your academy…" until the payload arrives
   (`academy-portal.tsx:72-91`), and the request cannot start before
   hydration (about 146 ms after navigation start cold, 50 ms warm). On slow
   4G the owner waited 12.2 s for this one response.
6. **Finance is fetched once per mounted hook, not per academy.** Owner
   Home → Fees → Home issued three `GET /finance` requests.
7. **Section switches are cheap and intentional.** Each `router.push`
   re-renders the page server component, which calls `context()` again
   (`page.tsx:17`). This re-checks membership on every section change. It is
   a security property to keep, not waste.

## 6. Baseline measurements

### 6.1 Server, in process

As §3.1. The same in-process figures from WP1 (statements 1,266 → 81 for the
owner payload) are reproduced here. The payload's SHA-256 prefixes are owner
`73c36a31fa9a2102`, coach `c7cdcf15ce81d974` and parent `eb61be4ef6e98b38`.
They are stable across repeated builds and match the WP1 logs.

### 6.2 Browser

Method:

- **Build and server:** `next start` from the existing `.next-final-qa`
  production build. It matches the working tree except the one-line WP1 F1
  decoder change in `src/server/http.ts`, which does not affect reads.
- **Data:** the server ran on port 3107 against a temporary copy of the
  Bharat database. Saves went to the copy, which was deleted afterwards.
- **Browser:** headless Chromium (Playwright 1.63), viewport 1536×1024.
- **Accounts:** synthetic accounts from `.local/bharat-qa-access.json`; each
  role signed in once.
- **Runs:**
  - "cold" is a fresh browser context, so nothing is cached;
  - "warm" is a reload in the same context, with static assets cached;
  - "throttled" is one cold load with 150 ms latency, about 1.6 Mbit/s down
    and 750 kbit/s up, plus 4× CPU slowdown.
- **"Ready"** is the time from navigation start until Home's heading is in
  the DOM.
- **Repetition:** three cold and three warm runs per role; medians reported.

| Role | Run | Home ready | Workspace response time | Workspace request starts | Requests (document / API / static / other) | API bytes on the wire |
|---|---|---|---|---|---|---|
| Owner | cold | 322 ms | 45 ms | 146 ms | 1 / 2 / 16 / 4 | 2,534,333 |
| Owner | warm | 193 ms | 40 ms | 53 ms | 1 / 2 / 16 / 4 | 2,534,333 |
| Owner | throttled | 15,214 ms | 12,223 ms | 2,278 ms | 1 / 2 / 16 / 4 | 2,534,333 |
| Coach | cold | 292 ms | 34 ms | 152 ms | 1 / 1 / 16 / 4 | 438,749 |
| Coach | warm | 120 ms | 32 ms | 48 ms | 1 / 1 / 16 / 4 | 438,749 |
| Coach | throttled | 5,369 ms | 2,269 ms | 2,534 ms | 1 / 1 / 16 / 4 | 438,749 |
| Parent | cold | 234 ms | 8 ms | 141 ms | 1 / 2 / 16 / 3 | 26,113 |
| Parent | warm | 94 ms | 7 ms | 47 ms | 1 / 2 / 16 / 3 | 26,113 |
| Parent | throttled | 2,965 ms | 284 ms | 2,349 ms | 1 / 2 / 16 / 3 | 26,113 |

- **API requests on Home:** the owner and parent make two (workspace, then
  `/finance`); the coach makes one (workspace only).
- **Other requests:** static JS and CSS are 16 requests and 333,661 bytes;
  "other" is images and fonts (0.58–0.74 MB, the same for every role).
- **Memory:** after Home loaded, the used JS heap was 12.1 MB for the owner
  and 9.5 MB for the coach and parent.

Request counts after saves and section switches are in §5.

### 6.3 Compression

Next.js gzip-compresses the HTML document (`content-encoding: gzip`, 8,227 →
2,213 bytes), but the route-handler JSON responses arrived with no
`content-encoding`. The owner payload was 2,523,209 bytes on the wire for
2,523,194 bytes of JSON. Computed gzip would be 118 KB (21× smaller) and
brotli 68 KB.

Whether production sits behind a compressing proxy is not documented
(`docs/SECURITY_AND_DEPLOYMENT.md` does not mention it) and needs
verification.

### 6.4 Conditions and limits

- **Machine:** one Windows laptop over local loopback; absolute timings vary
  with load. WP1 saw ±2× run-to-run variation in in-process medians.
- **Throttled run:** an emulation, not a device measurement.
- **Date rollover:** the date changed from 31 October to 1 November during
  the work. No measured payload depends on the current date; finance
  `asOfDate` does.
- **Uncovered roles:** ADMIN and SUPPORT were not measured; the dataset has
  neither.

## 7. Proposed target architecture

Principles, unchanged from today:

- Every request is authorised on the server through `context()` and
  `visibleRecords` / `visibleRecord`. Authorisation decisions are never cached
  across requests.
- Private data is held in memory only, inside the academy portal, and dropped
  on academy switch, sign-out and any 401 or 403. Nothing goes into
  `localStorage`, `sessionStorage`, IndexedDB or a cross-academy cache.
- `GET /api/workspaces/:id` and every existing field stay as they are for
  compatibility and tests.

### 7.1 Evaluation of the proposed directions

| Direction | Recommendation | Why | Trade-offs |
|---|---|---|---|
| Dedicated Home summary endpoint | **Yes**, with a bootstrap payload | Home needs counts and at most about 10 items (§4). On its own it does not help, because the shell and player selectors still wait for the full payload, so pair it with a small bootstrap. | One more endpoint whose counts must match the screens' rules (parent projections, coach scope). Compute it from `visibleRecords` and reuse the existing client derivations (`portalSessionSummary`, `currentPlayerPlan`, `monthReportProgress`) in shared code so the numbers cannot drift. |
| Filtered and paginated records endpoints | **Yes**, by extending `GET /records/:kind` | These are already permission-scoped and unused. Add `player`, `session`, `from`/`to`, `status`, `view=summary` and `limit`/`cursor`. | Filtering after `visibleRecords` keeps authorisation identical, but the server still reads the whole kind. That is fine at this scale. Indexes on `playerId` or dates inside JSON bodies would be a schema change and need approval. |
| Academy-scoped client cache | **Yes, as a small in-house store**; no new library for now | Needs are modest: dedupe requests in flight, key by resource and parameters, invalidate by tag, abort on unmount, discard per academy. The existing hooks already follow this pattern; this centralises it. | Library features (background refetch, devtools) are not needed today. Revisit if polling or a large invalidation matrix appears. |
| Targeted invalidation and incremental updates | **Yes, gradually** | Write responses already return the saved records with versions. Apply them to the store only when the version is newer, then refetch only the affected summaries. | A wrong mapping from mutation to tags leaves stale screens. The mapping must be explicit and tested per command. |
| Remove unnecessary full reloads | **Yes, first** | Finance saves and trial-rule saves are verified not to change workspace data; the communication refetch is identity-driven. | Small, low-risk changes. Each is measurable with the §5 table. |
| Compress API responses | **Decision needed** | 21× smaller on the wire for the current payload. The biggest single win on mobile networks. | Deployment topology must be known (app server or proxy). CPU cost on the server is small at this size. |

### 7.2 Target request flow

```
Portal open:   GET /api/workspaces/:id/bootstrap   academy, membership, viewer,
                                                    members (names, roles),
                                                    players-lite, batches, branches
               GET /api/workspaces/:id/home        role-aware counts and short lists
Screen open:   GET /records/:kind?view=summary&…   list summaries (paged and filtered)
Detail open:   GET /records/:kind/:id              full record (snapshot, sources)
Review:        GET /records/session?player=&from=&to=  (and attendance, evidence)
Save:          POST …  →  apply returned record (version-checked)
                       →  refetch only invalidated summaries
Unmigrated:    the full GET /api/workspaces/:id is loaded lazily, only by
               screens not yet migrated
```

Rough sizes from the measured parts, for the Bharat owner: players-lite plus
members plus batches is about 35–40 KB raw; Home summary is a few KB. These
are estimates to verify in WP2, not results.

## 8. Recommended implementation sequence

Each step ships separately, keeps the full endpoint unchanged, and is
re-measured with the §6 method on the same dataset.

1. **Measurement in the repo.** Add the browser request-count script and the
   payload-breakdown script under `scripts/`, plus API-harness tests that pin
   the full payload's digest and shape per role. No behaviour change.
2. **Remove proven waste.** No API change.
   - Finance saves stop reloading the workspace.
   - Trial-rule saves stop reloading the workspace; enrolment and conversion
     keep a reload until a player endpoint exists.
   - `useCommunication` refetches on academy change and after its own
     commands, instead of on every payload change.
3. **Compression.** Decide where it happens, then implement and measure.
4. **Bootstrap plus Home summary.**
   - The portal renders the shell from the bootstrap and Home from the
     summary.
   - Other screens still read the full payload, loaded lazily the first time
     one of them opens.
5. **Reports list and detail split.** This is the largest share of the
   payload.
   - The list uses summaries.
   - The detail view uses `GET /records/report/:id`.
   - The review workspace uses that player's month sources.
   - Freshness (`monthlyReportReview`) moves to the detail response.
6. **Sessions, attendance and evidence.** The Calendar loads by date window;
   Training and the attendance desk load one session at a time.
7. **Players directory and profile.** Server-side search and paging.
8. **Messages per player.** Load the communication view and announcements
   only when needed.
9. **Targeted invalidation everywhere.** Once no screen reads the full
   payload, `mutate` stops calling `reload()`.
10. **Decide the full endpoint's future.** Recommendation: keep it for
    compatibility, support and tests.

## 9. Risks and backward-compatibility requirements

- **Authorisation drift.** New endpoints must be built only from `context()`
  plus `visibleRecords` / `visibleRecord`; never from raw repository reads.
  Cover each one in the API harness for:
  - Owner and Admin;
  - Coach, for their own players and another coach's players;
  - Parent, for their own child and another family's child;
  - Support (audited);
  - a signed-in user with no membership;
  - another academy.
- **Parent and support projections.** Summaries must not leak staff notes,
  internal messages, unapproved reports or their counts. Today's
  projections live in `readVisibleRecords` (`workspace-access.ts`).
- **Support audit volume.** Every support read writes an audit row. Splitting
  one payload into several requests multiplies those rows. Product needs to
  decide whether that is acceptable or whether the unit of audit should
  change.
- **Consistency between screens.** Today one reload makes every screen
  consistent. With partial refetches, a missed invalidation shows stale data.
  Mitigations:
  - keep version checks (`expectedVersion` / `recordVersion`) on every write;
  - surface 409 conflicts as today;
  - test the mutation-to-tag map.
- **Revocation and academy switch.** The store must be dropped on academy
  switch (already a full navigation), sign-out, 401 and 403. Section changes
  must keep re-running `context()`.
- **Existing behaviours to keep:**
  - the single-flight mutation lock;
  - the "saved but the view could not refresh" message and the training
    session merge (`use-workspace.ts:113-149`);
  - unsaved-changes guards;
  - query-string deep links.
- **Tests.** Nineteen test files read the full endpoint. Keep its shape and
  bytes unchanged; this can be verified by digest.
- **Server cost.** Summary endpoints computed from `visibleRecords` still
  read whole kinds. At about 10× this dataset, consider indexes; that is a
  schema decision.
- **Monthly freshness.** `assertMonthlyCurrent` runs per draft inside the
  payload today. Moving it to report detail changes when staleness is shown;
  this needs a product check.
- **Dead code.** `workspace-screen.tsx` is unreachable but still compiles and
  calls `useWorkspace`. Decide whether to remove it before refactoring hooks.

## 10. Acceptance criteria for WP2

All measured with the §6 method, on the same Bharat dataset and the same
machine class, and reported against this baseline:

1. **Compatibility.** `GET /api/workspaces/:id` returns byte-identical
   payloads for owner, coach and parent (digests in §6.1). No existing API
   field is removed, and all existing unit and e2e suites pass.
2. **Home.**
   - A cold owner Home load makes no full workspace request.
   - Home data (bootstrap plus summary) totals at most 50 KB raw for the
     Bharat owner.
   - Every Home number equals the value the current client derives from the
     full payload, checked by equivalence tests for each role.
3. **Saves on migrated screens.**
   - Editing a player, creating a session, recording attendance, creating a
     fee plan, saving trial rules and preparing a monthly draft cause no
     full workspace request.
   - Each moves at most 50 KB raw in total for the Bharat owner.
   - A finance save makes at most one finance read.
4. **No amplification.**
   - No hook refetches on object identity.
   - Opening a screen issues at most one request per resource it needs.
5. **Authorisation.**
   - Every new endpoint and query parameter is covered for all roles,
     another academy and an outsider.
   - Parent responses never contain staff notes, internal messages or
     unapproved reports.
   - Every support read is audited.
6. **Privacy of client state.**
   - No private data is written to browser storage.
   - Switching academy, signing out, or receiving a 401 or 403 drops the
     store; a test covers each.
   - Revocation and coach reassignment show on the next request.
7. **Measured improvement.** Ready time (cold, warm, throttled), bytes and
   request counts are re-measured and reported. Improvements are claimed only
   from those measurements.

## Appendix A. Files inspected

**Client:**

- `src/app/workspace/[academyId]/page.tsx`
- `src/features/workspaces/academy-portal.tsx`
- `src/features/workspaces/portal-shell.tsx`
- `src/features/workspaces/portal-home.tsx`
- `src/features/workspaces/portal-parent-home.tsx`
- `src/features/workspaces/portal-players.tsx`
- `src/features/workspaces/portal-calendar.tsx`
- `src/features/workspaces/portal-training.tsx`
- `src/features/workspaces/training.tsx`
- `src/features/workspaces/portal-reports.tsx`
- `src/features/workspaces/report-review-workspace.tsx`
- `src/features/workspaces/period-plans.tsx`
- `src/features/workspaces/plan-and-report.tsx`
- `src/features/workspaces/messages.tsx`
- `src/features/workspaces/communication-controls.tsx`
- `src/features/workspaces/batch-announcements.tsx`
- `src/features/workspaces/portal-fees.tsx`
- `src/features/workspaces/portal-trials.tsx`
- `src/features/workspaces/portal-settings.tsx`
- `src/features/workspaces/workspace-screen.tsx`
- `src/hooks/use-workspace.ts`
- `src/hooks/use-finance.ts`
- `src/hooks/use-trials.ts`
- `src/hooks/use-communication.ts`
- `src/hooks/use-announcements.ts`
- `src/hooks/use-session-location.ts`
- `src/hooks/use-academy-settings.ts`
- `src/services/portal-records.ts`
- `src/services/report-period-filter.ts`
- `src/lib/private-navigation.ts`

**Server:**

- `src/server/workspace-service.ts`
- `src/server/workspace-access.ts`
- `src/server/workspace-repository.ts`
- `src/server/database.ts`
- `src/server/finance-service.ts`
- `src/server/finance-repository.ts`
- `src/server/trial-service.ts`
- `src/server/period-service.ts`
- `src/server/http.ts`
- `src/app/api/workspaces/**/route.ts`

**Other:**

- `docs/MULTI_ACADEMY_FOUNDATION.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY_AND_DEPLOYMENT.md`
- `next.config.ts`
- `package.json`
- `playwright.bharat.config.ts`
- the e2e specs used for UI selectors

## Appendix B. Reproduction

- **Where the scripts are.** The investigation scripts are not committed,
  because this task was investigation only. Step 1 of §8 adds equivalents
  under `scripts/`.
- **Payload breakdown.** Load the server modules on a temporary copy of the
  Bharat database, as `scripts/measure-workspace-access.ts` does. Then
  serialise the payload and sum `JSON.stringify` byte lengths per section,
  kind and field.
- **Browser run:**
  1. Start `next start --port 3107` with `SPORTOZEN_QA_BUILD=1`,
     `SPORTOZEN_FINAL_QA=1`, `SPORTOZEN_GALLERY_QA=1`, `BETTER_AUTH_URL` and
     `SPORTOZEN_DATABASE_PATH` pointing at a database copy.
  2. Run a Playwright script that signs each role in once, reuses the
     session for every context, and records same-origin requests per phase
     (method, path, status, encoded and decoded sizes, timing).
  3. Note that Better Auth rate-limits sign-in, so repeated sign-ins return
     429.
