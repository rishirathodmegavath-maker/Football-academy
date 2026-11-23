# Drill library: Stage 1 corrections (16 November 2026)

Full reports: `D:\Sportozen\drill-library-correction-delivery\`.

* **Sessions keep a complete snapshot** of every drill (content, safety, diagram, version, capture time). A draft keeps the snapshot it holds; remove and re-add a drill to take a newer version. Sessions saved before this change are labelled "Historical content unavailable" and never filled from today's catalogue.
* **Approved reports are frozen.** Only a draft report may consult the current catalogue.
* **Changing a catalogue drill:** raise its `contentVersion`, then regenerate the manifest with `UPDATE_DRILL_MANIFEST=1 npx vitest run tests/unit/drill-content-lock.test.ts`. The suite fails otherwise.
* **Academy drills:** category, safety (at least one line, plus locked lines inherited from a library drill), purpose at most 160 and cue at most 120 characters are enforced on the server. Edits merge field by field.
* **Drill 13** needs every participant to have a recorded date of birth and be 12 or over (internal rule). Enforced when a session is saved, booked, scheduled, started or generated from a series, and for a development plan.
* **Revision history** is kept for academy drills (`kind = drillrevision` rows, append-only in code). Database-level protection awaits migration approval.
* **Legacy "copy template"** no longer exists on the plan screen; a known legacy template id maps to one deterministic drill (`from-tpl-<id>`).
* **Browser tests** start the app with the project's own Next.js executable; no global pnpm is needed.
