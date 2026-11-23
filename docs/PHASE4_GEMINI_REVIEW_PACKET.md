# Phase 4 visual review packet (for Gemini Antigravity, read-only)

Status: **prepared, not yet performed.** I cannot call Gemini from this environment. Gemini is restricted to visual
review and must not edit any file in `D:\Sportozen\sportozen-phase4`.

## What to review

Screenshots (full page, real database-backed data, Owner / Coach / Parent):

- After: `docs/screenshots/phase4/after/<viewport>-<role>-<screen>.png`
- Before (pre-Phase-4 baseline, same data and viewports): `docs/screenshots/phase4/before/…` (same file names)
- Viewports: `desktop` 1440×900, `laptop` 1280×720, `tablet` 820×1180, `mobile` 390×844
- Screens: owner/coach home, calendar, players, training, reports, fees (owner, parent), settings, messages;
  parent home, calendar, reports, fees, settings, messages, development, practice; owner player with a trial
  enrolment; sign-in, password reset, academy chooser, account security.
- Machine-measured results (not a substitute for review): `docs/screenshots/phase4/after/audit.json`.

## Please assess

1. Design consistency: one slate-and-green identity across shell, dashboards, forms and the sign-in pages.
2. Visual hierarchy, typography (bundled Noto Sans) and spacing.
3. Responsive behaviour at each viewport; anything clipped, overlapping or cramped.
4. Accessibility: focus visibility, contrast, touch-target size, reading order.
5. Comparison with the recovered Phase 4 design direction (slate navy sidebar, green accent).

## Known points to judge, not defects

- The academy's own brand accent (configurable per academy) colours some primary buttons; the seeded academy uses blue.
- Full-page captures show the sticky mobile header part-way down the page; that is a capture artefact.
- Charts and the AI video card are existing placeholders ("Coming soon").

## How to return feedback

A list of findings, each with: screenshot name, what is wrong, why, and a suggested direction. The implementation owner
will accept only justified changes.
