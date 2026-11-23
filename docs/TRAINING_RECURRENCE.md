# Recurring sessions, session wrap-up and attendance history (Phase 9)

These three features extend the existing Training/Sessions module. They add no second training system: a recurring session is an ordinary football session, and every existing rule (status transitions, booking conflicts, rosters, attendance, coach scope, the parent projection) still applies to it.

**No database migration was added.** Records are stored as JSON in the existing `workspace_records` table (its `kind` column is unconstrained), every change is written to `training_history` as before, and notice de-duplication uses the existing e-mail outbox.

## 1. What a user can do

| Feature | Owner / Admin | Coach | Parent |
| --- | --- | --- | --- |
| Create a weekly series | any squad | only a squad whose every player they cover, and only with themselves assigned | no |
| Preview a series (nothing is written) | yes | same limits | no |
| Process a series again ("Add missing dates") | yes | their own series | no |
| Cancel one occurrence | yes | their own sessions | no |
| Cancel the whole series | yes | their own series; occurrences they are no longer assigned to are left alone and reported | no |
| Write or read a session wrap-up | yes | sessions they are assigned to and cover | **never** |
| Read a player's attendance history | any player | their own players | only a linked child |
| See the follow-up flag and correction notes | yes | their own players | **never** |
| See a cancelled session on the schedule | yes | yes | yes, only for a child on it, without the reason |

Support staff and people with no membership in the academy are refused everything above. An unapproved or suspended academy is closed to all of it (the existing approval rule, enforced in the one access function).

## 2. Recurring sessions

A series is a weekly rule: batch (squad), venue and location, assigned coaches, the weekdays (Monday to Sunday), a first and last date, a start and end time, an optional theme and drill plan, and optional holiday dates. **Limits:** at most 26 weeks between the first and last date and at most 60 sessions; the end time must follow the start on the same day, within eight hours. Editing the schedule of a whole series is out of scope: cancel it and create a new one. Single occurrences can still be rescheduled through the existing "Reschedule".

### How dates become sessions

1. Dates are walked as **local calendar days**, never by adding 7 x 24 hours to an instant, so a clock change cannot move a session to another day.
2. The instant of each date comes from the existing `resolveSessionTime`: a local time is accepted only if exactly one instant represents it.
3. A date is **skipped, never moved**, and listed in the preview and on the series with its reason:

| Reason | Meaning |
| --- | --- |
| Holiday | the owner excluded that date (with a label) |
| Already started | the session would already have started |
| Clock change | the local time does not exist (spring gap) or is ambiguous (autumn repeated hour) in the branch's time zone |
| Booking conflict | the existing coach, player or venue overlap check (including venue zones and buffers) failed |

Everything that passes is created as a **scheduled** session with the squad's current roster, one UNMARKED attendance record per player, and the drill plan, exactly as a single session is. Nothing is double-booked.

### Idempotency

* Every occurrence has the deterministic id `<series id>:<YYYY-MM-DD>`, and `(academyId, kind, id)` is the table's primary key, so a date can exist only once.
* Submitting the same request twice returns the saved answer (the existing per-user request key).
* "Process again" (`seriesSync`) creates only the dates that do not exist yet: a date that was blocked by a conflict that has since cleared, nothing else. A date that was cancelled, rescheduled or completed keeps its id and is **never** recreated.
* Two processors using the same version: one wins, the other gets a 409.

### Cancelling

* **One occurrence** uses the existing status change (reason required, same transition rules). Only that session changes; the series and its other dates are untouched.
* **The whole series** cancels this series' sessions that are scheduled and have not started. Sessions in progress, finished, already cancelled, or past their start time are left alone, and the ones left alone are listed. Other series' sessions are never touched. A cancelled series cannot be processed or cancelled again.

## 3. Cancellation notices

See `docs/EMAIL.md` ("Session cancellation notices"). In short: linked parents are e-mailed through the existing outbox (`SESSION_NOTICE`), once per session or once per series, never duplicated, never dropped at the hourly limit, and every recipient is counted in the outcome the cancelling user sees. A parent's schedule also shows the cancelled session, marked cancelled, for 24 hours after it would have ended. Only a session the parent had seen as confirmed is shown or announced.

## 4. Session wrap-up

A staff-only record, one per session (its id is the session id), versioned like every training record with each version kept in the history:

* for every planned drill: outcome (completed / partly done / skipped), minutes actually done and a note. **Planned minutes and drill names come from the saved agenda**, not from what the browser sends;
* coach observations, achievements and improvement notes.

It can be written while the session is in progress or after it is completed. **It is optional and never blocks completion**; the existing completion rules (attendance marked, evidence reviewed) are unchanged. It is not in the default academy payload, is never part of a parent projection, and cannot be written through the generic records route.

## 5. Attendance history

Computed on read from the existing attendance and session records (no table of its own):

* only **completed** sessions count; cancelled and unmarked ones do not;
* **percentage** = present / (present + absent + excused), one decimal; shown as "no sessions yet" when nothing is recorded;
* **consecutive absences** = the latest run of absent marks, newest first. An excused absence neither adds to the run nor ends it; a present mark ends it;
* **follow-up** = three or more consecutive absences, cleared by the next present mark. Staff only: the server does not send a parent the flag or the staff correction notes.

Existing correction rules are unchanged: changing a marked status needs a reason, a cancelled session's attendance cannot be changed, and the history updates as soon as a mark is corrected.

## 6. API

| Call | Purpose |
| --- | --- |
| `POST /api/workspaces/:id/training` action `seriesPreview` / `series` / `seriesSync` / `seriesCancel` / `wrapup` | the new commands, through the existing training endpoint (same origin check, request key, version check and audit) |
| `GET  /api/workspaces/:id/attendance-history?player=<id>` | one player's history (staff, or a parent for a linked child) |
| `GET  /api/workspaces/:id/attendance-history?followUp=1` | players needing follow-up (staff) |
| `GET  /api/workspaces/:id/records/wrapup?session=<id>` | one session's wrap-up (staff, in scope) |

## 7. Performance

`resolveSessionTime` used to try all 1,681 possible offsets for every call, which was fine for one session but took about 3 seconds to plan 60 sessions. It now tries only the offsets in force near the date and verifies each candidate exactly as before; `tests/unit/resolve-session-time.test.ts` keeps the old implementation as a reference and checks that both agree on every clock-change day of 2026 in six zones (including 30- and 45-minute ones). Previewing and creating 60 sessions takes about 35 ms and 50 ms.

## 8. Not done (decisions for the owner)

* editing a series' schedule in place (cancel and recreate instead);
* an academy-wide holiday calendar (holidays are per series);
* parent-visible wrap-up summaries;
* any WhatsApp notification (cancellation notices are e-mail only; live WhatsApp sending remains disabled);
* an automatic reminder or message when a follow-up flag is raised;
* retention of wrap-up text (it follows the session; the 12-month rule covers delivery history only).
