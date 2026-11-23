# Authentication and account security

Status: **implemented and tested locally (Vitest through the real Better Auth handler, and a browser spec). No external service is needed; nothing here was run against a production host.** Everything uses the existing Better Auth setup (`src/server/auth.ts`); there is no second authentication system. E-mail verification and password recovery are described in [EMAIL.md](EMAIL.md) and are unchanged.

## 1. Account lifecycle

| Stage | What happens | Where |
| --- | --- | --- |
| Sign-up | E-mail + password (12+ characters) creates the account and, unless verification is required, a session. Profile `name` is limited to 100 characters; profile images are refused. Written to the audit trail ("Account created"). | `auth.ts` hooks, `databaseHooks` |
| E-mail verification | Off by default (owner decision, [EMAIL.md](EMAIL.md)). When `required`, sign-in, academy creation and invitation acceptance need a verified address. **Existing users are never forced**: the switch is a deployment decision. | `verified-email.ts` |
| Sign-in | Same answer for an unknown address and a wrong password. Per client address: Better Auth's limiter. Per account: each attempt is counted **before** the password is checked (so a burst of parallel guesses cannot slip past), and after 10 attempts in a 15-minute window the account is paused for the rest of it (answer 429, identical for accounts that do not exist; one log line per pause). A correct password clears the count. The window is fixed, so up to twice the limit can fall around a window boundary. | `account-security.ts` |
| Second step (optional or required) | Authenticator app (TOTP) or a one-time recovery code. A password alone gives **no session** for an account with it turned on. Wrong codes: 5 per challenge, then 10 per account in 15 minutes lock it (Better Auth's built-in limits). "Trust this device" is stripped on the server: the second step is asked every sign-in. | Better Auth `twoFactor` plugin |
| Session | Cookie `HttpOnly; Secure; SameSite=Lax`, 8 hours absolute (default). Optional idle timeout. A session older than the absolute limit is ended before any Better Auth endpoint or application route sees it, even if it was renewed (a hook for Better Auth's own endpoints, `currentSession()` for the application). | `auth.ts`, `account-security.ts` |
| Password change | Needs the current password. **Always ends every other session** (the server forces it; a crafted request cannot opt out). Audited. | `auth.ts` before hook |
| Password reset | One-time, 60-minute e-mailed link; ends every session; audited ([EMAIL.md](EMAIL.md)). | Better Auth |
| Sign out other devices | Account page or `revoke-other-sessions`. Audited. | `/account/security` |
| Turning on the second step | Ends every other session of the account (a password-only session opened earlier must not satisfy the policy). Audited. | `auth.ts` after hook |
| Invitation | See Section 4. | `membership-service.ts` |

## 2. Settings (all optional; defaults keep today's behaviour)

| Variable | Values | Meaning |
| --- | --- | --- |
| `SPORTOZEN_MFA` | `off` (default), `staff`, `all` | Who **must** use the second step. `staff` = Owner, Admin, Coach, Support, platform administrators, and anyone creating an academy (they become its Owner). `all` adds Parents. **Anyone can enrol whatever this says.** Enforced where access is decided: a person without it receives 403 `MFA_REQUIRED` from every academy route, the platform routes and academy creation. Until a required second step is set up, `GET /api/workspaces` lists no academies (only the account status). Invitation acceptance is not gated: it exposes no academy data. A non-member hears the ordinary membership refusal, never the policy. |
| `SPORTOZEN_SESSION_MAX_HOURS` | 1–72, default 8 | Absolute session life. |
| `SPORTOZEN_SESSION_PERSISTENT` | `1` to switch on, default off | "Stay signed in until I sign out": a session lasts a year and renews while it is used; **Sign out** always ends it. Takes the place of the two limits above. A shared or lost device stays signed in until its owner signs out, so choose it knowingly. |
| `SPORTOZEN_SESSION_IDLE_MINUTES` | 5 up to the absolute limit, default unset | When set, a session also ends after this long without a request. |
| `SPORTOZEN_SIGNIN_FAILURE_LIMIT` | 1–100000, default 10 | Failed sign-ins per account per 15 minutes before it is paused. |

`npm run preflight` (WP1) validates all four and reports `SPORTOZEN_MFA=off` as a warning.

## 3. Two-step verification in practice

- **Enrol**: *Account security* (`/account/security`, linked from the academy list) → password → add the key to an authenticator app (setup link or the typed key; no QR dependency was added) → enter a code. Ten recovery codes are shown once.
- **Sign in**: password, then a 6-digit code; or "Use a recovery code" (each works once).
- **Lost phone, has recovery codes**: sign in with a code, then make new codes or turn it off.
- **Lost phone and codes (break-glass)**: there is deliberately no way to bypass this in the product. An operator, after confirming the person's identity by another route (a call to a known number; an Owner vouching for a staff member), runs on the server:
  `node scripts/reset-mfa.mjs <account-email> --identity-verified`
  It removes the second step, ends all of the account's sessions, writes an audit entry and a security log line, and prints nothing sensitive. The person signs in with the password and enrols again. Record who verified whom and how, outside the application.
- **Storage**: the authenticator secret and recovery codes are encrypted with `BETTER_AUTH_SECRET`; rotating that secret makes them unreadable (everyone would have to be reset), so treat the secret as a key you cannot rotate casually (see the rotation notes in [SECURITY_AND_DEPLOYMENT.md](SECURITY_AND_DEPLOYMENT.md)).
- **Limits**: a TOTP code is not tracked as used, so one observed in real time can be replayed inside its 30-second window (true of every TOTP system without phishing-resistant keys); WebAuthn/passkeys would remove that and are a possible later step. SMS codes are not offered (SIM-swap risk, cost, no provider).

## 4. Invitations as an authorization boundary

- Only an Owner or Admin of the academy can issue, list, renew or end an invitation; Coach, Parent and Support cannot (403). The role set is `ADMIN`, `COACH`, `PARENT`; an Owner cannot be created by invitation, and staff invitations cannot carry guardian links.
- Token: 32 random bytes (64 hex), stored only as a SHA-256 hash, valid 7 days, single use, never returned by a list. Renewing replaces the hash (the old token stops); ending sets the expiry to now.
- Acceptance requires the signed-in account's address to equal the invited address (and a verified address when verification is required). A wrong, expired, used, replaced, ended or someone else's token all produce **one** response, so nothing says which case applied. Accepting is rate-limited to 10 a minute per person, and an existing active role cannot be replaced.
- A guardian invitation can name only players of the inviting academy; one academy's invitation, list or renewal is invisible to another academy (404).
- Every transition (issue, renew, end, accept) is in the audit trail without the token.

## 5. Audit trail and security log

Sensitive account operations are written to the append-only `workspace_audit` (`academyId` empty for account-level events): account created, password changed, other sessions signed out, two-step verification turned on/off, recovery codes regenerated, e-mail verified, password reset by link, operator reset. The same events (and failed/blocked sign-ins) are emitted as one JSON line each on the warning stream by `security-events.ts` with an allow-list of fields: ids and a keyed hash of the account address (`accountRef`), **never** an address, password, token, code or request body (tested).

## 6. Where tokens and secrets are held

- Sessions: random token in the `session` table (standard Better Auth), cookie signed with `BETTER_AUTH_SECRET`.
- E-mail verification, password-reset and second-step challenge identifiers: **stored as hashes** (`verification.storeIdentifier: hashed`), so a copy of the database or a backup holds nothing replayable. Tokens already issued in plain form are still honoured (Better Auth tries both).
- Invitation tokens: hashed (above). Authenticator secrets, recovery codes: encrypted. Passwords: scrypt (Better Auth).

## 7. Request hardening in this package

- `/api/auth/*` rejects a request body over 16 KB with 413 before reading it all.
- `update-user` and sign-up refuse profile images and names over 100 characters. **Found by the baseline probe:** Better Auth accepted a 2 MB `image` string (HTTP 200) and stored it in the user row, which every later session lookup would then load.
- Sign-in, sign-up and the second step are also limited per client address by Better Auth (3 attempts per 10 seconds on sign-in and sign-up, 3 per 10 seconds on the second step); the address comes from the trusted-proxy settings of [DEPLOYMENT.md](DEPLOYMENT.md).

## 8. Known limitations and decisions that need the owner

| # | Item | Why it matters |
| --- | --- | --- |
| A1 | **MFA policy (`SPORTOZEN_MFA`) is unset.** Recommended `staff`; the owner decides and announces it. Existing staff are locked out of their academy until they enrol, so enrol them first (set `off`, ask staff to enrol, then switch). | Assessment decision D7 |
| A2 | With verification off, a duplicate sign-up reveals that an address has an account (HTTP 422). Open registration without a mailbox check cannot hide this; with verification `required` the responses are indistinguishable (tested). | Decision on e-mail verification |
| A3 | Account pausing can be used to keep a known address's owner from signing in for one 15-minute window at a time. Reset by e-mailed link is not blocked. The limit is configurable. | Trade-off accepted for resisting distributed password guessing |
| A4 | No breach-password (known-leaked) check; it needs an outbound call to an external service. | Optional later hardening |
| A5 | No passkeys/WebAuthn, no SMS. | Possible later step |
| A6 | Idle timeout is off by default. | Owner decision on session policy (recommend 30–60 minutes for staff) |
| A7 | The account page and the sign-in second step are new screens built from existing components, outside the approved Coach/Player/Parent boards; they need the owner's visual review. | UI lock |
| A9 | Re-authentication endpoints (`change-password`, `two-factor/enable|disable|generate-backup-codes`) check the password but are limited only per client address, not per account. They need a live session, so the realistic abuser is someone holding a stolen session; the second step and session revocation are the defence. | Possible later hardening |
| A8 | Verification of the unverified-invitee risk: with verification off, a leaked invitation token plus an account registered with the invited address is enough to join. Mitigation: switch verification on, or deliver invitations by e-mail (the token then proves mailbox control). | Assessment finding A3 |

## 9. What was verified

`tests/unit/auth-lifecycle.test.ts` (32 tests, real handler, origin checks on), `tests/unit/mfa-policy.test.ts` (8, real routes for Owner, Admin, Coach, Parent, Platform Administrator, Support, an outsider and another academy's owner), `tests/unit/invitation-security.test.ts` (7), preflight additions, and `tests/e2e/account-security.spec.ts` (browser: turn on, sign in with code, recovery code once, staff policy). Safeguards were removed one at a time and the matching test failed each time (password-change revocation, profile guard, account pause, count-before-check, absolute limit on Better Auth's own endpoints, other sessions ended on enrolment, hashed identifiers, trust-device strip). The application-level absolute-limit check in `currentSession()` is a second layer behind the hook, so removing only that one is not detected by a test. Not verified: a real authenticator app on a phone, deliverability of the e-mails (no provider), behaviour behind the production proxy.

## 10. Trusted origins ("Invalid origin")

**Cause of the sign-in error "Invalid origin" on a local server.** Better Auth accepts a browser request only from its own configured origin. That origin came from `BETTER_AUTH_URL`, and when the variable was not set it defaulted to `http://127.0.0.1:3000`. A server started on another port (`next dev --port 3005`) therefore refused every browser origin (`http://localhost:3005` and `http://127.0.0.1:3005`) with 403 `INVALID_ORIGIN`, while an origin of `http://127.0.0.1:3000` was accepted. The same default also decided the "same-origin" check of every write route and the link origin in e-mail, so a page that could be signed in on the wrong port would still have failed to save.

**The rule now** (`src/server/app-origin.ts`, one list used by sign-in, the same-origin check of write routes and e-mail links):

| Situation | Trusted origins (exact, never a wildcard) |
|---|---|
| Real deployment (`BETTER_AUTH_URL` is an https address) | That origin only |
| Local development, `BETTER_AUTH_URL` not set | The port the server is really listening on (Next.js exports it as `PORT`): `http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>` |
| Local development with `BETTER_AUTH_URL=http://127.0.0.1:3001` set | The same host names on port 3001 |
| Production mode on a loopback address (the browser test suites) | The configured origin only: the other host names are not added |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Extra origins you list, comma separated. Each must be an exact origin (scheme, host, port, no path); plain `http` only for localhost. A wildcard (`*`, `?`) or a malformed entry stops the application at start-up |

Better Auth reads `BETTER_AUTH_TRUSTED_ORIGINS` itself without validating it (and allows wildcards in it), so the application validates the same variable first and refuses to start on anything it would not accept.

**What stays strict:** CSRF protection and callback/redirect validation are unchanged. Better Auth checks the `Origin` header of requests that carry a session cookie (and of sign-in and sign-up); a cookie-less request is protected through the `callbackURL` / `redirectTo` check instead, so a reset request cannot be pointed at another site. Untested paths are named in the test file `tests/unit/auth-origin.test.ts`.

**Addresses.** An internationalised domain (for example `anna@münchen.de`) is converted to ASCII (`xn--mnchen-3ya.de`) before it reaches Better Auth, which accepts ASCII only; sign-in, sign-up and password recovery all use that form, so typing the address either way finds the same account. An address with a non-ASCII part before the `@` (SMTPUTF8) cannot register: Better Auth refuses it and mainstream providers, including Postmark, do not deliver to it. The refusal is a clear 400, not a silent failure.

## 11. "Continue with Google"

Google sign-in is Better Auth's own Google provider, **implemented and tested against a stand-in for Google; not tested with real Google, and switched off until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.** Without them the sign-in screen shows the button disabled and nothing else changes. The rules (linking only to accounts whose address is already verified, no role or academy from Google, two-step accounts use their password, fixed destinations) and the callback URL (`<BETTER_AUTH_URL>/api/auth/callback/google`) are in [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md).

## Signed out when switching between servers on one machine

Browsers share cookies between ports of one host. Two Sportozen servers on `127.0.0.1` (for example a test copy beside the real app) use the same cookie name, `better-auth.session_token`, so each one overwrites the other's cookie, rejects its signature and the person is signed out every time they switch. Set `SPORTOZEN_COOKIE_PREFIX` (1 to 32 letters, digits or hyphens, for example `sz-fb-3340`) on each server to give it its own cookie name. Unset keeps the default name. A real deployment on its own domain does not need it. Separately, a session ends 8 hours after sign-in by default (`SPORTOZEN_SESSION_MAX_HOURS`, 1 to 72); `SPORTOZEN_SESSION_PERSISTENT=1` keeps a session for a year while it is used.
