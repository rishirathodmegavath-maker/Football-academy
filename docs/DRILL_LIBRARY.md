# Football drill library: architecture

Status: implemented in the Football working copy, 16 November 2026. Nothing here
has been committed, migrated or deployed.

## What it is

A drill library inside the existing Training module (the "Drills Library" tab,
not a sidebar item):

1. **Universal catalogue.** The 50 approved drills in seven predefined
   categories (7/8/9/9/7/5/5), maintained centrally, read-only at run time.
2. **Academy drills.** Created, edited, archived and restored by the academy.
3. **Academy copies.** One deterministic academy copy per universal drill.
4. **Session, recurring-series and plan integration.** A searchable multi-select
   picker, ordering, per-drill minutes and a total.
5. **Structured diagrams** for every drill, from ten reusable archetypes.

## Where things live

| Concern | Path |
|---|---|
| Types, the seven categories, id rules | `src/domain/drill-library.ts` |
| The catalogue (50 entries, 7 category files, index) | `src/config/drills/` |
| Diagram archetypes and academy presets | `src/config/drills/diagrams.ts` |
| Country heading policy (fail-closed) | `src/config/drills/heading-policy.ts` |
| Diagram validation | `src/services/drill-diagram-rules.ts` |
| Search, filters, ordering (pure) | `src/services/drill-library-view.ts` |
| Server service (catalogue, resolve, customise, archive, write guards) | `src/server/drill-library-service.ts` |
| Catalogue route (authenticated, read-only) | `src/app/api/workspaces/[academyId]/drills/catalogue/route.ts` |
| Actions `customiseDrill`, `archiveDrill`, `restoreDrill` | `src/app/api/workspaces/[academyId]/actions/route.ts` |
| Library screen, forms | `src/features/workspaces/drill-library.tsx` (+ `-parts.tsx`, `.css`) |
| Session / series / plan picker | `src/features/workspaces/drill-picker.tsx` |
| Diagram renderer (inline SVG, no dependency) | `src/features/workspaces/drill-diagram.tsx` |
| Catalogue hook | `src/hooks/use-drill-catalogue.ts` |

## Storage and seeding

* **Universal drills are code.** They are a frozen, typed array in
  `src/config/drills`, changed only by a reviewed release. There is no table,
  no seeding step and no migration: repeated deployment cannot duplicate or
  overwrite anything, and an academy's data is never touched.
* **Academy drills** are `drill` workspace records (`workspace_records`, kind
  `drill`). Their new fields are optional JSON, so older drills (name, focus,
  purpose and cue only) stay valid and show as "Uncategorised" until edited.
* **The initial counts stay identifiable.** Each initial drill carries
  `number` (1-50) and `origin: "INITIAL_50"`; the per-category initial counts
  are constants. Later central additions get `origin: "ADDED"` and numbers above
  50, so the original distribution can always be proved.
* **Identifiers.** `uni-001` ... for the catalogue; `from-uni-001` ... for an
  academy copy. Both prefixes are reserved: no record route can write `uni-*`,
  and a `from-uni-*` record can only be created by the customise action.

## The catalogue route

`GET /api/workspaces/{academyId}/drills/catalogue` is authenticated like every
other academy route (session, active membership, active entitlement, approved
academy, MFA policy) and additionally requires a staff role (owner, admin,
coach) and the development module. Parents and Support get 403, a visitor 401,
another academy's owner 403. Draft entries are never served. There is no write
method.

## Permissions (enforced on the server)

| Action | Owner | Admin | Coach | Parent | Support |
|---|---|---|---|---|---|
| View the universal catalogue | yes | yes | yes | no | no |
| View academy drills | yes | yes | yes | no | no |
| Create an academy drill | yes | yes | yes | no | no |
| Edit / archive / restore an academy drill | any | any | own only | no | no |
| Customise a universal drill | yes | yes | yes | no | no |
| Change a universal drill | no | no | no | no | no |
| Add a drill to a session / series / plan | yes | yes | on own sessions | no | no |

"Own" means the drill's `createdBy` is the coach. Older drills have no creator,
so only the owner and admins manage them. A customised copy is created by the
first person to customise; it is then academy-wide (everyone can use it), and
managed by its creator, owners and admins. The membership is re-read inside the
write transaction, so a revoked coach cannot finish an edit.

## Concurrency and idempotency

* Editing a stored academy drill requires `expectedVersion`; a stale or missing
  version is 409. The version is the `workspace_records` row version.
* Customising runs in one `BEGIN IMMEDIATE` transaction that looks for the
  deterministic copy id first, so repeated or concurrent calls return the one
  copy.
* Archive and restore are idempotent and audited once per change.

## Historical preservation

A session already stores a snapshot of each drill (`agenda[].drill` and
`drillVersion`). That mechanism is unchanged:

* An **academy drill** snapshot is the record at the time of planning
  (without its concurrency counter). Editing or archiving the drill later never
  rewrites a saved session, evidence or wrap-up.
* A **universal drill** snapshot is deliberately small (name, focus, purpose,
  cue, category, `universalVersion`) so sessions stay small; the staff-only
  coaching text is read from the catalogue by id. Each catalogue entry has a
  `contentVersion`. **A release that changes a drill's coaching text must raise
  its `contentVersion`.** A saved session therefore shows its original name,
  purpose and cue permanently, and records which content version it used.
  The full previous coaching text of an earlier version is not retained by the
  application (see the limitations register).
* A recurring series stores drill ids and snapshots the current drill into each
  session when that session is created (existing behaviour).
* **Archived drills** stay readable for history. They are refused for a *new*
  session, series or plan, but a draft, series or plan that already contains one
  can still be saved or extended.

## What families see

Name, `purpose` and `cue` can appear in a monthly report (existing behaviour:
the report copies only `name`, `purpose`, `cue` and the drill id). They are
therefore short (160 and 120 characters at most for the catalogue) and free of
staff detail, and the screens say so. Every other field (instructions, coaching
points, mistakes, safety, equipment, setup, references, diagrams) is staff-only:
parents and Support receive no `drill`, `session` or `plan` detail in any
payload, and a test scans the report model for leaks.

## Heading (Drill 49)

Drill 49 keeps its number, name and objective and is stored as `DRAFT`, so the
catalogue route, the library, the picker and `customise` never see it. Its
draft content covers only the non-heading part (clearing and controlling with
the foot and chest); the heading component is explicitly "not authored". A
country policy table (`heading-policy.ts`) records, per ISO country, whether
heading guidance has been verified against a primary source. **India is
configured and unverified**, so heading is disabled; an entry needs
`verified: true`, a `source` and a `verifiedOn` date to enable anything, and an
unknown country is closed. No age limit, repetition limit or heading
recommendation has been written.

## Diagrams

Every drill has a structured diagram (players by team, cones, goals, balls,
hurdles, walls, zones, and pass / run / dribble arrows) on a 100 x 64 abstract
board. It is schematic, never to scale, and states no real distances. Ten
archetypes (slalom, grid, rondo, triangle, hourglass, wall lane, shooting lane,
three-team rotation, four-goal game, pitch thirds) build the layouts and each
drill adds its own elements. A single small SVG component renders them; there is
no graphics dependency. Academy drills choose one of the predefined layouts;
a custom diagram builder is not part of this release. Tests validate that every
diagram is inside the board and distinct.

## Compatibility notes

* `WorkspaceDrill` gains only optional fields; `ownership` also allows
  `UNIVERSAL_CATALOGUE` (used only in snapshots).
* The workspace payload's `records.drill` holds only the academy's own drills,
  so the API baseline and screen payload sizes are unchanged.
* The old sidebar contract is kept: there is no "Drills Library" navigation
  item; the library is a tab inside Training.
* The legacy `/coach/drills` demo-store screen is not touched.
