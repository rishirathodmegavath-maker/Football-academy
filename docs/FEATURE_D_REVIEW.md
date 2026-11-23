# Feature D final review

Scope: optional plan numbers, mobile fee dialogs, per-session messaging, suggestion-period documentation and Git hygiene. Work remains uncommitted; no push or deployment.

## Optional plan numbers

An Owner can empty Term length and Payment due after (days). The form sends `null` for an empty visible field, and the service removes its saved value. Omitted fields preserve their previous values; untouched populated fields retain their values. Custom-frequency plans still require a duration. A Term plan with no duration can be saved but cannot produce a suggestion until a duration is supplied.

## Per-session plans

Automatic suggestions do not support Per session plans. The plan editor, applicable plan selectors, plan list and suggestions area explain this limitation. Owners can use **Fee Plans → Issue player invoice** to record a session charge manually, using the session date for the billing period. This records an invoice, not a payment.

## Existing suggestion periods (unchanged)

`financeView` computes `asOfDate` using the academy timezone and passes that date to `financeInvoiceProposal`. Each suggested period starts on that date, not on the first day of the calendar month, enrolment anniversary or plan effective date. Reloading on a later academy date can therefore move an unissued suggested period. Effective dates determine eligibility; they do not anchor recurring billing periods.

- Weekly periods include seven days.
- Monthly, quarterly, half-yearly and yearly periods end one day before the corresponding date one, three, six or twelve months later, with month-end clamping. Free plans use a monthly period.
- Term and custom periods use the saved duration, inclusive of the start date.
- The due date is the period start plus the saved due-after days, defaulting to zero when absent.
- A period extending beyond the plan, assignment or exception end date is unavailable. Existing invoice overlap/duplicate checks still apply.

For example, a monthly suggestion starting 2026-10-31 ends 2026-11-29 under the existing month-end rule. Five due-after days gives a due date of 2026-11-05. Issued invoices retain their recorded periods.

No billing-period calculation was changed during this continuation. Calendar-aligned, anniversary-aligned or catch-up billing requires confirmation of the intended rules before implementation.

## Verification and evidence

Verified on 31 October 2026 on `codex/day1-integration`, based on `36a9229` with the existing uncommitted changes.

| Check | Result |
| --- | --- |
| ESLint | Passed |
| TypeScript | Passed |
| Unit tests | 325 passed across 31 files, including 71 finance tests |
| Isolated production build | Passed; warning about dynamic database filesystem tracing |
| Fee workflow browser test | Passed: batch fees, exceptions, suggestions, one-time extras and role boundaries |
| Mobile/optional-number browser test | Passed after correcting test selectors, allowing intentionally locked currency and centring scrolled controls |
| Git diff whitespace check | Passed |

The mobile test exercised all five dialogs at 390 × 844 and 320 × 568 in Chromium. It checked horizontal bounds and overflow, scrolled every visible control fully into view, checked control-centre hit testing and enabled action buttons, and completed reviewed invoice issuance at 320px. No browser page errors occurred. All 20 start/end screenshots were visually reviewed using the two contact sheets below. Long forms scroll internally; the action buttons remain available. Native closed selects abbreviate long option labels at 320px; the controls themselves remain within the dialog.

- [390px contact sheet: all five dialogs, start and end](../.local/feature-d-review/fee-configuration/phones/390-contact-sheet.png)
- [320px contact sheet: all five dialogs, start and end](../.local/feature-d-review/fee-configuration/phones/320-contact-sheet.png)
- [Individual captures](../.local/feature-d-review/fee-configuration/phones/)
- [Full Git status](../.local/feature-d-review/git-status.txt)

Runtime databases, authentication state, traces, logs and screenshots are kept under ignored `.local/` or `test-results/`. Git checks confirmed no newly tracked runtime records or generated artifacts. The QA build's generated `next-env.d.ts` path change was restored. Existing historical tracked evidence logs were left unchanged. The regression test source and this review document are intentional reviewable files.

Final working tree: 21 modified files and 5 untracked source/test/documentation files, including pre-existing work outside Feature D. Nothing is staged, committed or pushed. This continuation changed only the fee regression test and added this review document; the saved functional fixes were already present and have now been verified.

Environment notes: `pnpm` was unavailable on this shell's PATH, so the existing package scripts were run using `npm.cmd` without installing dependencies or changing the lockfile. Browser verification used an ignored local Playwright config that starts the same Next server with Node directly. Windows left the isolated test server running during teardown; only the server processes started by this review were stopped. Unit tests emitted SQLite experimental notices and two non-failing fetch warnings in the scheduling PDF test.
