# Design standard (Football app)

The written standard that goes with the tokens in `src/styles/globals.css` (decision UX-D4: a written standard plus a tokens file; UX-D3: one interface font). It is enforced by `tests/unit/design-standard.test.ts`, which stops new drift and never asks for a rewrite.

## Rules for new and changed CSS

1. **Colour:** no hex or `rgb()` literal. Use a token: `--text`, `--text-secondary`, `--text-tertiary`, `--text-strong`, `--border`, `--border-strong`, `--surface-card`, `--surface-subtle`, `--surface-hover`, `--green`, `--green-dark`, `--red`, `--status-info-*`, `--status-success-*`, `--status-danger-*`, `--status-warning-*`, `--overlay`. A colour that is missing is added to `:root` first, with a name that says its role.
2. **Font:** `var(--portal-font)` (Noto Sans first, system fonts for scripts it does not cover) or `inherit`. No other `font-family`.
3. **Type scale:** `--fs-caption` 12 px, `--fs-small` 13 px, `--fs-body` 14 px, `--fs-lead` 16 px, `--fs-title` 20 px. Nothing below 12 px.
4. **Spacing:** a 4 px step scale, `--space-1` to `--space-6` (4, 8, 12, 16, 24, 32).
5. **Radius:** `--radius-sm` 6 px for buttons and fields, `--radius-md` 8 px for cards, `--radius-lg` 12 px for dialogs, `--radius-full` for pills.
6. **Focus:** a visible ring in `--focus-ring` (the green). A field shows focus on its box (green border and `--focus-ring-soft`), never as a second box inside it.
7. **Target size:** at least 24 px square for every control (WCAG 2.2 AA 2.5.8). The portal enforces this once in `globals.css`. On touch screens (`@media (pointer: coarse)`) tabs, card links and the drill library's controls are 44 px tall.
8. **Breakpoints:** one scale, 480, 768, 1024 and 1280 px. Write `min-width: N` for N and up, `max-width: N - 1` for below N (479, 767, 1023, 1279) so the two sides never overlap. CSS cannot read variables in a media query, so the scale lives here and in the test.
9. **Tab rows** that scroll sideways get the shared edge shadow (`globals.css`, "Wave 5 shared patterns"): add the row's class to that rule.

## What is not yet on the standard (the baseline)

The old stylesheets still hold literal colours, many widths off the scale and a few raw fonts. They are **not** rewritten in one pass: bulk replacement changes how screens look (roadmap V9: replace when you touch the file). The exact counts per stylesheet are in `tests/unit/design-standard.baseline.json`; the test fails when any count goes up, and fails when a file reaches a lower count without the baseline being lowered, so the numbers only fall.

- **Moved to tokens in Wave 5:** `src/features/workspaces/drill-library.css` (held to the strict rules in the test).
- **Breakpoints:** the one-pixel duplicates 767/768, 899/900, 1023/1024 and 1199/1200 were merged to one value. Widths such as 540, 600/601, 640, 700, 720, 760, 800, 900, 1000, 1050, 1100, 1150, 1180, 1200, 1250, 1350 and 1400-1600 remain; each is listed per file in the baseline. When a stylesheet is next changed, move its widths to the nearest scale step and look at the screen at 480, 768, 1024 and 1280 px.
- **Type:** about 53 distinct font sizes are in use, and about 370 declarations use 9, 10 or 11 px. They are not changed here.

## When you add or change a stylesheet

Run `npx vitest run tests/unit/design-standard.test.ts`. If you removed literals, lower the baseline: `UPDATE_DESIGN_BASELINE=1 npx vitest run tests/unit/design-standard.test.ts`, and commit the new `design-standard.baseline.json`.
