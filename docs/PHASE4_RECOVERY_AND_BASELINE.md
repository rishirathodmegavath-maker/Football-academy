# Phase 4 recovery and baseline verification report

Workspace: `D:\Sportozen\sportozen-phase4` (plain copy of `D:\Sportozen\wp69-clean`, no git metadata).
Nothing outside this folder was modified. Status labels follow the Phase 4 brief.

## 1. Workspace creation

| Check | Result |
|---|---|
| Destination existed before | No |
| Source intact | Yes: 1,135 files hashed (SHA-256) before and after the copy; source unchanged |
| Destination vs source | 1,135 / 1,135 files, all SHA-256 identical at creation |
| Not copied (build output and local data) | `node_modules`, `.next*`, `.local` (test databases), `test-results`, `playwright-report`, `tsconfig.tsbuildinfo`, `.git` |
| Dependencies | `pnpm install --frozen-lockfile` (pnpm 11.19.0), from the lockfile only |
| Source manifest | scratchpad `p4/baseline-manifest.json` |

## 2. Recovery of the original redesign: **Recovered**

Method: the recorded Antigravity `edit_file` calls (exact Target and Replacement strings, with the tool's own
success message) were re-applied to the baseline files on an LF view and written back with each file's original
line endings. No source was reconstructed from compiled CSS.

| Evidence | Result |
|---|---|
| Edits replayed (steps up to 1900) | 31 recorded; 28 applied; 3 skipped because the original tool reported them as failed (two for `globals.css`, one for `preview.tsx`); **0 target mismatches** |
| Files changed by the replay | 18 (`primitives.tsx`, 2 design-preview files, `academy-portal.tsx`, `training.tsx`, 11 stylesheets, `portal.css`, `globals.css`) |
| Independent second replay (separate implementation, Stage A) | Identical to the workspace for all 16 files it covers (LF-normalised; it does not cover the two design-preview files) |
| Source-map copies in the recovery folder | `primitives.tsx`, `preview.tsx`, `approved-homes.tsx` are **byte-identical** to the workspace files (LF-normalised) |
| Compiled-CSS cross-check | 682 of 763 added declarations (89%) found in the independently compiled builds; the rest were probably rewritten by the CSS minifier and are not independently confirmed |
| Line endings | Preserved per file (CRLF for the stylesheets, LF for `.tsx` files that were LF) |
| Files not touched | Every other baseline file is byte-identical to the manifest, except `portal-shell.tsx` (section 3) and the build-generated `next-env.d.ts` |

Not replayed on purpose: the later 18:51 WP1 edits (see section 3), the edits Antigravity made to my WP6–8 test
files (`ops.test.ts`, `secret-scan.test.ts`; the baseline already holds the final versions) and its scripts.

Residual uncertainty: the replay reproduces every edit the agent recorded. A change made outside the recorded tool
calls (for example by hand in the editor) could not be seen. The three byte-identical source-map files support that
nothing is missing, but the stylesheets are checked only by the 89% cross-check.

## 3. The three-file conflict: decisions

Decision applied: the recovered original redesign is the baseline; the later WP1 shell edits were reviewed one by one.

| # | WP1 change | Decision | Reason |
|---|---|---|---|
| 1a | Academy monogram instead of the generic shield icon when no logo is uploaded | **Accepted**, adapted | Better than an icon labelled "not yet uploaded". Initials come from the real academy name. Styled with the redesign's own colours (`color: inherit`, 12px) in a 36px box; the WP1 teal `#69e5be` and 16px size were not used because they clash with the redesign and do not fit three letters |
| 1b | Logo fallback to `/design-preview/approved-home/riverside-crest.png` for any academy named "riverside" | **Rejected** | Hard-codes a demo asset from the non-production preview into the live workspace; it is fixture data by another name and would break if the preview is removed |
| 2 | Human-readable role labels | **Accepted**, adapted | Implemented as a typed `Record<AcademyRole, string>` so a new role cannot be forgotten, instead of nested conditionals |
| 3 | Search width constrained to 420px | **Rejected** | The redesign already constrains the search to `min(100%, 360px)` at 36px height; the WP1 edit fixed the pre-redesign 840px. Applying 420px would override a recovered design decision for no gain |
| 4 | Dark sidebar semantic tokens (`#092635`, `#193746`, `#29d8a5` …) | **Rejected** | The redesign's sidebar is slate navy `#0f172a` with green accents; the WP1 teal-navy set would change the visual identity. The five tokens were not used anywhere else, so adopting them would add unused tokens. A token layer for the sidebar can be reconsidered when colours are consolidated |
| 5 | Active navigation indicator and styling | **Nothing to merge** | No recorded WP1 edit contains one. The redesign already styles `.portal-sidebar nav button.active` (tinted green, inset ring, bold) and the shell already sets `aria-current="page"` |

Also applied: `ShieldCheck` import removed (it became unused); the crest has `role="img"` and an accessible name.

## 4. Baseline verification

Environment: Windows 11, Node 24, pnpm 11.19.0, Next.js 16.4.1, Playwright 1.63 (Chromium).

| Check | Result | Classification |
|---|---|---|
| TypeScript typecheck | Pass, no errors | n/a |
| ESLint | 0 errors, **2 warnings** (unused `Settings` import in `design-preview/preview.tsx` and `approved-homes.tsx`) | **Recovery-related** (the clean baseline has none; introduced by the recorded Antigravity edits). Cosmetic, in non-production code; deliberately not fixed yet |
| Unit tests (Vitest 4.1.12) | 72 files passed, 1 skipped; 1,058 tests passed, 2 skipped | Identical to the baseline counts |
| Production build (plain) | Pass | n/a |
| Production build with the CI QA flags | Pass | n/a |
| Browser suite (CI flags: `SPORTOZEN_QA_BUILD`, `GALLERY_QA`, `FINAL_QA`, `HOME_UI_QA`; main config, 69 specs) | **65 passed, 4 failed** (15.8 min) | See below. `monthly-report-review` and `account-security` use separate configs and were not run in this baseline |
| Browser suite, first attempt with a plain build | Invalid: 3 gallery specs failed because the preview routes return 404 without the QA flags | Environment/test-infrastructure issue; the run was stopped and repeated with the CI flags |

### Browser failures, classified

The previous clean baseline (before the redesign) passed all of these except `academy-portal`, which failed only on a
`git rev-parse HEAD` step because the frozen copy has no git metadata. That step did not run here either (this
workspace also has no git metadata), but `academy-portal` now stops earlier, at a font assertion.

| # | Spec | Failure | Classification | Cause (evidence) | Proposed handling |
|---|---|---|---|---|---|
| 1 | `academy-portal` main flow | `document.fonts` for "Portal Noto" are not all `loaded`; heading font should contain "Portal Noto" | **Recovery-related** (recovered redesign) | The redesign replaced the portal font stack `Portal Noto, Arial` with a system stack (`-apple-system … Inter …`). The two `@font-face` rules for the bundled Noto Sans still exist but nothing uses them, so they never load. Rendering will now differ per operating system, and "Inter" is not bundled | **Owner decision:** keep the recovered system stack and update the assertion, or restore the bundled font in the stack. Not changed yet |
| 2 | `fee-plan-save` | Save button background is `rgb(21,103,54)`, test expects `rgb(0,153,109)` | **Recovery-related** | The test encodes the pre-redesign teal brand button; the redesign's primary button is green | Update the assertion to the redesign's token when Stage C touches fees |
| 3 | `training` (coach) | `getByText("COACH", exact)` not found | **Phase 4 implementation** (my accepted WP1 change 2) | The shell's role chip now reads "Coach" instead of the raw enum "COACH"; page snapshot shows `Coach` | Update the selector to the readable label. Expected consequence of the decision |
| 4 | `trial-enrolment` | Times out (4.0 min) waiting for the "Review trial summary" dialog; fails the same way when run alone, so it is not flakiness | **Recovery-related, real UI defect** | The mobile screenshot at the failure shows the trial action buttons overlapping each other (text from "Record trial feedback", "Update status", "Review trial summary" and "Publish…" runs over its neighbours), so the click does not reach the intended button. `portal-trials.css` was never restyled, and the redesign's generic button rules now break its layout | Fix in Stage C (trials screen). Do not work around in the test |

None of the four indicates data loss, an authorization problem or a security regression.

Build artefact note: `next build` rewrites `next-env.d.ts`; that file differs from the baseline only by what Next generates.

## 5. Status of the recovery (precise labels)

- Original Phase 4 source edits: **Recovered** (exact replay, verified as above).
- Phase 4 redesign in the real workspace: **Recovered**, not yet **Implemented** for the screens the recovered work does not reach (see `PHASE4_SCREEN_AUDIT.md`).
- Locally verified: typecheck, lint (2 recovery-related warnings), 1,058 unit tests, build. Browser suite 65/69 with 4 classified failures. Not independently reviewed. Not integrated. Not production validated.
