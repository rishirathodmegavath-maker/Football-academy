# Google sign-in

Status: **implemented and tested against a stand-in for Google. Not tested with real Google: no credentials have been configured yet.** Not deployed.

Written for: the application owner and whoever operates the deployment.

Google sign-in is Better Auth's own social provider, configured in `src/server/auth.ts`. There is no second authentication system. A Google sign-in creates the same session as a password sign-in, and what a person may then see is decided by the unchanged membership, role, academy-approval and two-step checks.

## 1. Turning it on

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | its secret; server only, never in Git, the browser or a log |
| `BETTER_AUTH_URL` | the exact address people use in the browser (https in production) |

Set both Google variables or neither (one alone stops the server with an explanatory error). Without them the button is shown disabled and nothing else changes. **Callback URL to register in Google: `<BETTER_AUTH_URL>/api/auth/callback/google`.** Step-by-step console settings: the delivery document `GOOGLE_CLOUD_SETUP.md`.

## 2. Rules

* **Linking.** A Google sign-in is linked to an existing account only when that account's own address is already verified and Google confirms the same address (`account.accountLinking`: `requireLocalEmailVerified: true`, no trusted providers). A refused attempt changes nothing: no link, the address stays unverified, the password is untouched, no session. The sign-in screen says what to do.
* **New people.** Google must confirm the address. The account has no role and no academy; it starts an academy (which waits for approval) or accepts an invitation like any other account.
* **Two-step verification.** An account that uses it must sign in with its password and code (Better Auth's second step follows only password sign-in).
* **The browser chooses nothing.** The request carries only `provider` and `callbackURL`; success always lands on `/workspace`, failure on `/sign-in?source=google&error=<code>`; the start must come from a trusted `Origin`; `link-social` and browser-supplied ID tokens are refused.
* **Failures** show a fixed message chosen by the code (`src/services/google-sign-in-errors.ts`); text from the address is never displayed.
* Refusals are written to the security log as `signin.google_refused` with a short code only; linking is written to the audit trail.

## 3. Tests

`tests/unit/google-oauth.test.ts` (real Better Auth handler, stand-in for Google's token call) and `tests/e2e/google-oauth.spec.ts` (real browser and server; `playwright.google-oauth.config.ts`; the stand-in is `tests/e2e/helpers/google-stand-in.cjs`, loaded into that test server only). Run the browser suite with a QA build as for the other dedicated suites.

## 4. Not covered

Real Google (consent screen, real tokens, Workspace accounts), real devices, a penetration test. Open decisions (two-step users, unverified "squatting" accounts) are in the delivery security report.
