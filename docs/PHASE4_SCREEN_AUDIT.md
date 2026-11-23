# Phase 4 Stage B: architecture and screen audit

Scope: the database-backed workspace in this folder (`sportozen-phase4`, a copy of the verified `wp69-clean`
tree) after the recovered redesign was replayed. Read-only inspection; no screen has been changed beyond the
recovery and the shell decisions in `PHASE4_RECOVERY_AND_BASELINE.md`.

## 1. What is the live application and what is not

| Area | Route / entry | Data | Status in production |
|---|---|---|---|
| **Live workspace** | `/workspace/[academyId]` renders `AcademyPortal` (client; screen chosen by `?section=`), `/workspace` (academy chooser), `/sign-in`, `/reset-password`, `/account/security`, `/platform` | `/api/workspaces/[academyId]/{bootstrap,home,records/[kind],finance,training,communication,trials,player-messages,places}`; report and finance PDFs | Served |
| Demo family | `/owner/*`, `/coach/*`, `/parent/*` (`app/(demo)`), `components/layout/app-shell.tsx`, `features/{academy,analytics,attendance,development,drills,evidence,fees,parent,parent-development,players,reports,sessions}` | `AcademyProvider` with fixtures | **404 in production** unless `SPORTOZEN_GALLERY_QA=1` |
| Design preview | `/design-preview/*`, `features/design-preview` (about 21,000 lines incl. `fixtures.ts`, `preview-session-records.ts`) | Fixtures | **404 in production** unless `SPORTOZEN_GALLERY_QA=1` |

Consequences for Phase 4:

- The redesign must land only in `features/workspaces` and the shared primitives/tokens. The demo family and the preview are non-production reference code and must not be extended.
- `components/ui/primitives.tsx` is shared: 18 live-workspace files import it, and the demo family uses it too. Changes there affect both.
- `styles/globals.css` is about 3,100 lines. Most of it styles the demo `.sidebar` shell, plus a minified `.secure-*` block (line 3090) used by the sign-in, chooser and account-security screens.

## 2. Roles and gating (as implemented, not changed)

Roles: `OWNER`, `ADMIN`, `COACH`, `PARENT`, `SUPPORT` (`AcademyRole`). Gating lives in `academy-portal.tsx` (`allowed`): Support sees only reports, players, development and settings (lands on reports); Parent cannot open players or training; nobody but a Parent opens `practice`. Fees need OWNER, ADMIN or PARENT and the `fees` module. Platform Admin is a separate route (`/platform`) and is untouched by this phase. Server-side authorization is independent of the UI and must stay so.

## 3. Design-system findings (recovered redesign)

- The redesign is almost entirely a **CSS restyle of existing markup**: 11 portal stylesheets plus `portal.css` and the `:root` tokens in `globals.css`. The only recorded TypeScript changes are `Button` variants (`outline`, `danger`) and sizes (`btn-sm`, `btn-lg`) in `primitives.tsx` and two lint clean-ups. This means Stage C is mostly finishing and verifying, not re-implementing.
- Palette in force: slate navy `#0f172a` (sidebar, ink), green `#15803d`/`#4ade80` (brand accent and active state), slate greys for borders and text. Tokens exist in `:root` (`--navy`, `--green`, `--text-*`, `--border*`, `--canvas`, `--surface-*`, `--radius-*`).
- **Token adoption is low.** Hard-coded hex colours versus `var(--…)` uses: portal.css 128/6, portal-home 51/1, portal-parent-home 18/1, portal-players 23/0, portal-calendar 125/0, portal-training 110/0, portal-reports 77/0, report-review 57/0, portal-fees 68/38, portal-settings 66/11. Consolidating onto tokens is possible but is a broad change; propose it as an optional, last work package.
- **Not covered by the recovered redesign:** `portal-trials.css`, the sign-in / reset-password / chooser / account-security screens (still the legacy `.secure-*` block, wordmark colour `#102f45` from the older teal palette, class `report-kicker`), `messages`, `plan-and-report`, `period-plans`, `communication-controls`, and the fee editor beyond `portal-fees.css`.
- Accessibility signals (count of `aria-*` attributes): portal-home 0, portal-parent-home 1, messages 0, sign-in 0, chooser 0, versus settings 30, training 32, reports 20, calendar 22. Active navigation already sets `aria-current="page"` and an `.active` class styled by the redesign.

## 4. Screen-by-screen matrix

"Design state" describes what the recovered redesign already provides. "Verification" lists the existing automated coverage that must stay green plus what Stage C must add.

| Screen | Existing implementation | Design state (recovered) | Backend integration | Remaining UI work | Verification |
|---|---|---|---|---|---|
| **Shell and navigation** | `portal-shell.tsx` (333 lines), `portal.css`; sidebar, mobile menu dialog, search, role chip, account menu | Restyled dark sidebar, active state, 36px search at max 360px, 6 breakpoints. Accepted from WP1: academy monogram fallback, readable role label | Session and membership from the bootstrap payload; sign-out through Better Auth client | Audit mobile menu and focus trap; keyboard order; sidebar nav count per role; contrast of `#94a3b8` on `#0f172a` | `workspaces.spec`, `mobile.spec`, `ux-simplification.spec`; add a shell responsive check at 4 widths |
| **Owner dashboard** | `portal-home.tsx` (519), `portal-home.css` | Restyled (150 lines changed) | `/home` | 0 `aria-*` in the TSX: add landmarks and labels for cards and charts; empty and error states exist (1 alert, 1 status) | `home-ui.spec`, `academy-portal.spec` (owner); screenshots at 4 widths |
| **Coach dashboard** | same component, `coach` branch | Shares the owner styling | `/home` | Check coach-specific cards at tablet and mobile | `academy-portal.spec` (coach), role walk-through |
| **Parent dashboard** | `portal-parent-home.tsx` (364), `portal-parent-home.css`, `parent-preferences.tsx`, `practice.tsx` | Restyled (52 lines) | `/bootstrap`, player records, messages | 1 `aria-*` only; mobile-first check (parents mostly use phones); linked-child selector | `academy-portal.spec` (parent), `mobile.spec` |
| **Players: directory and detail** | `portal-players.tsx` (1118), `portal-players.css`, `academy-form.tsx`, `academy-structure.tsx` | Restyled (96 lines) | `/records/player`, create/update mutations, batches | Table to card behaviour on narrow screens; form field errors | `player-form.spec`, `academy-portal.spec` |
| **Calendar** | `portal-calendar.tsx` (1314), `portal-calendar.css` (1059) | Lightly restyled (18 lines) | `/records/session`, `/places`, scheduling services | Largest layout risk at six widths; check overlap with the new shell | `calendar-ui.spec` (six widths), `portal-scheduling.spec` |
| **Training and sessions** | `portal-training.tsx` (1085), `training.tsx` (2070), `session-editor.css` | Lightly restyled (21 + 13 lines) | `/training`, `/records/session`, attendance, evidence | Session editor form hierarchy; drafts and unsaved-changes prompts | `training.spec`, `session-draft-save.spec`, `simple-session-creation.spec` |
| **Reports** | `portal-reports.tsx` (784), `portal-reports.css` | Restyled (29 lines) | `/records/report`, report PDF | Tab semantics, empty state | `reports.spec` |
| **Monthly report review** | `report-review-workspace.tsx` (1252), `report-review-workspace.css` | Restyled (44 lines) | `/records/report/[id]?review=1`, PDF | Heaviest form; 16 `disabled` controls to check | `monthly-report-review.spec` (separate config, port 3013) |
| **Fees and payments** | `portal-fees.tsx` (879), `portal-fee-editor.tsx` (1168), `portal-fee-detail.tsx`, `portal-fees.css` (best token use) | Restyled (75 lines) | `/finance`, finance PDFs | Invoice table at tablet width; fee-plan form | `fee-configuration.spec`, `fee-plan-save.spec`, `academy-portal.spec` finance steps |
| **Settings and profile** | `portal-settings.tsx` (1511), `portal-settings.css` | Restyled (40 lines); tabs: Academy, Team, Sessions, Notifications, Integrations, Account | academy settings, invitations, communication | Tab semantics exist (`aria-selected`); Account tab links to security | `portal-settings.spec`, `portal-onboarding.spec` |
| **Messages / announcements** | `messages.tsx`, `batch-announcements.tsx`, `communication-controls.tsx` | Announcements restyled (9 lines); messages not covered | `/communication`, `/player-messages` | Messages has 0 `aria-*`; restyle to match | `batch-announcements.spec`, `communication.spec`, `period-communication.spec` |
| **Trials** | `portal-trials.tsx` (674), `portal-trials.css` (70) | **Not covered** by the recovered redesign | `/trials` | Restyle to the shell's tokens | `trial-enrolment.spec` |
| **Sign-in, reset, chooser** | `sign-in.tsx`, `reset-password.tsx`, `chooser.tsx`, legacy `.secure-*` CSS | **Not covered** | Better Auth, `/api/workspaces` | Restyle to the new identity; keep WP6 second-step and enrolment flows | `workspaces.spec`, `account-security.spec` (separate config, port 3014) |
| **Account security** | `account-security.tsx` (307), `/account/security` | **Not covered** | Better Auth two-factor, session list | Same; do not alter the MFA logic | `account-security.spec` |
| **Platform admin** | `platform-accounts.tsx` (71) | Unaffected | `/api/platform/accounts` | None; keep out of scope | existing unit and e2e coverage |

## 5. Mock-only functionality and duplicate screens

- The demo family and the design preview use fixtures and are not reachable in production. They duplicate the live screens by design (visual reference). No live screen imports them; only the three `app/design-preview` routes import `features/design-preview`.
- The preview still carries two lint warnings (unused `Settings` import) in `preview.tsx` and `approved-homes.tsx`, introduced by the recorded Antigravity edits; the clean baseline had none.
- No live workspace screen was found using fixture data in this audit; confirmation under real roles belongs to Stage D.

## 6. Proposed work packages for Stage C (for approval)

1. **WP-A Shell and tokens:** finish the shell (focus order, mobile menu, contrast), decide the sidebar token question (see recovery report), fix the two preview warnings.
2. **WP-B Dashboards:** owner, coach, parent home; add landmarks and labels.
3. **WP-C Players and calendar.**
4. **WP-D Training, sessions, reports, monthly review.**
5. **WP-E Fees and settings.**
6. **WP-F Messages, trials, sign-in, reset, chooser, account security** (the screens the recovered redesign does not reach).
7. **WP-G Role verification and screenshots** at desktop, laptop, tablet and mobile, then the Gemini visual review.

Optional and last: replace repeated hex colours with the existing tokens, screen by screen, only where a screen is already being touched.
