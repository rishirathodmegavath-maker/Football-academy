# Football sprint: behaviour notes

Written for engineers and the product owner who will review or extend these workflows. It describes what the code now does, which approved decisions it follows, and what it deliberately does not do. Source of the priorities: `parity-audit/08_roadmap.md` (P0-02, P1-01, P1-04, P1-08, P1-09, P1-10).

Nothing here needed a database migration, a new table, a trigger change or a protected file. The new record kind (`closure`) is a JSON row in the existing `workspace_records` table, like every other academy record.

## Player lifecycle (P0-02)

`src/domain/player-lifecycle.ts` is the single definition.

| Status | Takes part in new rosters, recurring fee suggestions, announcements, "active" counts | New records (plans, reports, updates, observations, invoices, fee exceptions, legacy fees) |
|---|---|---|
| ACTIVE, TRIAL, (unset) | yes | yes |
| PAUSED | no | yes |
| INACTIVE | no | yes |
| ARCHIVED | no | **refused (409) until restored** |

- Only an owner or admin moves a player into or out of PAUSED or ARCHIVED. A coach keeps the limited control they already had (ACTIVE, TRIAL, INACTIVE) on their own players.
- An archived profile accepts no edit except a restore.
- Existing history is never changed: sessions already created keep their roster, invoices and reports stay readable, the batch placement is kept so a restore returns the player to the same batch.
- Per-session billing for a session that really took place stays available for PAUSED and INACTIVE players; it is refused for ARCHIVED.
- Every status change is written to the audit log.

## Placement source of truth (P1-01, decision D9)

`player.squadId` is authoritative. Saving a batch roster (`training` action `squad`) now applies the roster to the players in the same transaction: players added are placed in the batch and taken off any other batch's roster; players removed lose their placement; a renamed batch updates its players' labels. An archived player cannot be newly placed. The player form already kept both sides in step and still does.

`scripts/check-data-integrity.ts` now reports, as WARNINGs and never repairing anything: a player placed in a batch whose roster does not list them; a roster that lists a player placed elsewhere; a roster-only placement from older data; a player on more than one roster; an unknown status. Existing databases may show roster-only warnings; that is older data, not a new fault.

## Report withdrawal (P1-10)

Owner or admin, with a written reason (10 to 1,000 characters). The approved report returns to "Revision Requested" and loses its snapshot, so families, the PDF and update sources stop seeing it immediately. Updates published from it are unpublished (set to REJECTED so they can be resubmitted after a correction) and their queued external deliveries cancelled. The approved version stays in the append-only approval history; the reason is on the report and in the audit log. The internal withdrawal note is never part of a family projection and is dropped if the report is approved again.

## Parent payment reference (P1-09)

A parent may report a payment reference for their own child's invoice: it is created as PENDING; staff verify or reject it as before. It is the only finance action a parent has. At most three references per parent may wait for review. A reference already used in the academy is refused with a message that does not say who used it. Nothing is collected online and a pending reference never reduces a balance.

## All-day closures (P1-08, version 1)

Academy-wide or one branch, whole days only (no part-day or per-batch closures, as decided). Owner or admin records and lifts them (Calendar, "Closed Days"). A closure:

- blocks creating, rescheduling or scheduling a session on a closed day (409, with the reason);
- makes a weekly series skip those dates with the reason "Closed day";
- never cancels a session that already exists. The dialog lists sessions still scheduled on closed days so staff cancel them deliberately, with the normal cancellation notice;
- is shown to families only as dates, scope and the note written for them. The internal reason never leaves staff screens.

## Coach hand-over (P1-04)

Revoking a coach who still has players, upcoming sessions or active weekly series requires either a replacement coach or an explicit "leave unassigned". A replacement takes over everything in one transaction; sessions already held and a session in progress keep their coach; the move is audited and kept in the training history. Who may revoke whom is unchanged (the ADMIN revocation policy is still pending the owner's decision), and revoking other roles is unchanged.

## Not done, on purpose

See `00_REMAINING_WORK_REGISTER.md` in the delivery folder for the blocked items and why (legal, database, protected files, external services, pending decisions).
