# Drill library: safety and limitations register

16 November 2026. Written for the people who will review the content and decide
what may be relied on. Status words: **Implemented** (code exists), **Tested**
(automated tests pass), **Reproduced** (re-run by the engineer), **Pending**,
**Blocked**, **Production-blocking**. Nothing here has had external or
third-party verification.

## 1. Safety content

| Drill | What was done | What is NOT done |
|---|---|---|
| 13 Blindfold Soccer Movements | Redesigned as an individual, supervised, eyes-closed balance and awareness activity: marked individual lanes with a clear buffer, nothing in the lane but a stationary ball, no physical blindfold by default, stationary or slow controlled movements only, no running, collisions, passing or contact, a spotter outside each lane, voluntary, anyone may stop at once without explanation. **Minimum age 12**, stated as an *internal Sportozen product restriction, not a football association rule*. Tests check each of these statements and that the instructions contain no running, passing or contact. | No governing-body or medical source for an eyes-closed activity was found. The minimum age is a conservative internal choice and needs safeguarding sign-off. |
| 18 The Time Glass Passing Drill | Kept the exact name. Built as an hourglass-shaped passing layout in timed rounds, documented as **Sportozen's defined interpretation, not an established drill** (the name was not found as a recognised drill). | No source for the name or layout. |
| 24 Long-Ball Aerial Control | Chest, thigh and foot control only; heading is not offered as an alternative. Low, gentle service for younger groups, lighter balls, clear receiving box. A test fails if any instruction mentions heading. | No source for service heights; none are stated. |
| 34 Hurdle Shooting | Low, soft or collapsible hurdles or flat markers; a clear landing area; the shot is taken only after balance is regained and never while airborne; one shooter at a time; waiting players beside and behind, never in the line of fire; goal anchored; goalkeeper optional. Tests check these statements and the diagram. | Hurdle height, spacing and distances are left to the coach: no number was invented and none could be sourced. |
| 43 3-Team Transition Game (2v4 Intense Pressing) | Three-team rotation with built-in recovery; pressing only on named triggers (back pass, poor touch, receiver facing own goal, ball played to the presser's side); roles on winning or losing the ball; short bouts stopped early if quality drops; no sliding tackles, no tackling from behind, no contact above the waist; water. | No source for work and rest durations; none are stated. |
| 49 Heading Control & Clearance | Kept as `DRAFT`: never served, never selectable. Only a non-heading control-and-clearance part is written. The heading component is explicitly "not authored". A country policy table is fail-closed; **India is configured and unverified**, so heading is disabled. No age limit, repetition limit or recommendation was invented. | **Heading cannot be enabled** until the relevant country's guidance is verified against primary sources. The primary pages (for example the national associations) could not be opened, and no Indian guidance was found. |

General rules enforced by tests across all drills: no distances, no repetition
targets, no percentages, no medical or physiological claims, and no
association rule stated as a Sportozen fact. Age bands on drills are
*suitability* guidance, not safety limits.

## 2. References

* Every published drill records its references individually.
* **No publisher page could be opened** (no network access to the publishers
  when the content was written). The FIFA Training Centre and UEFA pages are
  recorded as `LOCATED_NOT_OPENED`: found by search, not verified against the
  page. All wording is original Sportozen text.
* Every published drill also carries an explicit `LIMITATION` record: no
  drill-specific authoritative source was located. **Production-blocking
  before wider claims**: a qualified coach educator must review and verify the
  content and its sources.

## 3. Known limitations

1. **Content review is pending.** The 49 published drills are original
   coaching practice written without access to the publisher pages. They are
   complete and tested for structure, but not independently reviewed.
2. **Universal drill history is by version, not by text.** A saved session
   keeps its drill's name, purpose, cue and `universalVersion` permanently.
   The staff-only coaching text is read from the catalogue by id; the
   application does not retain the *previous text* of a catalogue drill after a
   release changes it. A release that changes a drill's coaching text must
   raise its `contentVersion`. An academy copy is never changed by a release.
3. **Copies do not follow the catalogue.** A customised copy is independent: a
   later release does not update it, and there is no merge or "reset to
   universal" action.
4. **One copy per universal drill, per academy.** The first person to
   customise owns it; other coaches can use it but not edit it (the owner and
   admins can). A coach who wants their own variant creates a new academy
   drill.
5. **Coach edit rights narrowed.** Older academy drills have no creator, so
   coaches can no longer edit them (owner and admin can). This is the approved
   policy, and it changes today's behaviour for older drills.
6. **Family-visible fields are staff-authored.** An academy drill's name,
   purpose and cue can appear in a monthly report. The form says so, but
   nothing can judge the wording; catalogue drills are length- and
   content-checked.
7. **Academy drill snapshots are full records.** A session stores the whole
   academy drill (including staff-only content) in its snapshot, as it always
   has. Parents never receive it, but it makes sessions larger than a
   universal-drill snapshot.
8. **Diagrams are schematic** (a 100 x 64 abstract board). Academy drills pick
   a predefined layout; a custom diagram builder is not included.
9. **Older drills may have no category.** The API still accepts a create
   without a category (kept for compatibility with existing callers); the new
   screen always requires one, and any edit of an older drill requires one.
10. **Existing template copy still duplicates.** The older "Copy drill
    template" control in the Development plan screen is unchanged and creates a
    new drill each time; it is outside this feature.
11. **Search is a simple word match** on name, skills, tags and category; there
    is no ranking, no paging (the catalogue has 50 drills) and no translation.
12. **No change to the legacy demo `/coach/drills` screen.**
13. **Accessibility** was designed in (roles, labels, focus handling from the
    dialog library, keyboard-operable controls) and checked by automated tests
    only; no screen-reader or full audit was done.
14. **Browser coverage** is Chromium only (the project's test browser).

## 4. Production blockers

1. Verified heading guidance per country, then a reviewed heading component
   (Drill 49 stays unpublished until then).
2. Coach-educator and safeguarding review of all content, with sources opened
   and verified; sign-off on Drill 13's internal minimum age.
3. Any legal or retention position on what academies may record in drills
   (nothing child-specific is stored by the library).
