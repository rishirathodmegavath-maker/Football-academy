# Email infrastructure: provider-independent architecture, verification, recovery and notices

Status: **built and tested with mocked delivery. No provider has been selected, no provider account exists, and nothing has been sent to any real mailbox.** Live delivery is **BLOCKED** until the owner selects a provider, creates the account and a verified sending domain (Section 8, Section 12) and the delivery tests in Section 13 have been run. Until then every switch stays off and the application behaves as before: sign-up gives a session, there is no password reset, and invitations are shared manually.

Written for: the application owner (the decisions), and a developer adding a provider.

**The provider is a configuration choice, not a dependency.** The business code, the templates, the outbox, the delivery tracking and the webhook handler never name a provider. One adapter exists today because its contract was checked against the provider's published documentation (Postmark); it is one entry in a registry, no more privileged than one added later. Zoho ZeptoMail, Zoho Mail or another transactional provider are candidates only (Section 16); none is selected and none is implemented.

## 0. Provider-independent architecture

| Concern                                                                  | Where                                                                                                                       | What it knows about providers                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Business logic: which event sends which message to whom                  | `queue...()` in `src/server/email/index.ts`, called by the features (registration, recovery, invitations, academy approval) | nothing                                       |
| Templates: one layout, text and HTML, escaping, header safety            | `templates.ts`                                                                                                              | nothing                                       |
| Queue, retries, expiry, per-address cap, erase-after-send, suppression   | `outbox.ts`, `address.ts`                                                                                                   | nothing; it calls `EmailTransport.send`       |
| Delivery tracking: what the recipient's mail system did                  | `events.ts`, `email_events`, `email_outbox.deliveryStatus`, `email_suppressions`                                            | nothing; it records `DeliveryEvent`s          |
| Provider configuration: which provider, which credentials                | `config.ts` reads `SPORTOZEN_EMAIL_TRANSPORT` and the variables the provider declares                                       | the registry's names and `requiredEnv`        |
| Provider adapter: how to talk to one provider                            | one file per provider (`postmark.ts`), registered in `transport.ts`                                                         | everything about that provider, and only that |
| Delivery reports: how one provider's webhook is authenticated and parsed | the provider's `webhook` adapter, served by the one route `POST /api/email/webhooks/<provider>` (`webhook.ts`)              | in the adapter                                |

### The adapter interface (`src/server/email/types.ts`)

```ts
interface EmailProvider {
  name: string; // the value of SPORTOZEN_EMAIL_TRANSPORT
  kind: "real" | "local" | "test"; // real: allowed in a deployment; local: files, localhost only; test: refused in production
  requiredEnv: { name: string; description: string }[]; // refused at start-up when missing
  create(env): EmailTransport; // { name, send(email) -> { providerMessageId } }
  webhook?: {
    // optional: delivery reports
    requiredEnv: string[]; // the route answers 404 until these are set
    configured?(env): boolean; // extra condition (for example a minimum secret length)
    authenticate(headers, env): boolean; // constant-time check of the provider's credentials or signature
    parse(body, now): DeliveryEvent[]; // DELIVERED | DELAYED | BOUNCED | COMPLAINED, one id per provider event
  };
}
```

`send` throws `EmailSendError(message, permanent, code)`: **permanent** (bad address, rejected content, refused credentials: never retried) or transient (network, timeout, 429, 5xx: retried with back-off). A 2xx answer without a message reference is a failure, not a send. The credentials come from the environment, never from the repository, and never reach a log, an error message or the outbox row (tested with a deliberately leaky provider).

### Local development (no account, no network)

- `file` (the default under `next dev` on a localhost address): each message is written to `.local/mail-preview/<time>-<id>.json` (recipient, subject, text) so a developer can open a reset or invitation link. Refused unless `BETTER_AUTH_URL` is a localhost address.
- `capture` (tests only; refused in production): messages stay in memory and the next outcomes can be scripted (`scriptCapture(["transient", "ok"])`) to test retries and failures.
- **Mocked provider responses**: `registerEmailProvider(...)` registers any provider object, so a test can model a provider's answers (busy, rejected, refused credentials, down) and its webhook without HTTP. `tests/unit/email-providers.test.ts` does exactly that with an invented provider, driving configuration, the outbox, retries, delivery tracking and the webhook route; `tests/unit/email-global.test.ts` tests the Postmark adapter against mocked HTTP.
- `disabled` (the production default): no mail is sent and every flow keeps working as before.

### Selecting a provider (procedure, when the owner decides)

1. Choose the provider and create the account (owner; Section 8). Check its official API and webhook documentation; **do not implement an adapter from memory or from a third party's integration.**
2. Add one file `src/server/email/<provider>.ts` that exports an `EmailProvider`: the transport (response mapping as above) and, if it reports delivery, the webhook adapter. Register it in `transport.ts` and add its name to `EMAIL_TRANSPORTS` in `scripts/lib/preflight.mjs` (a test keeps that list equal to the registered real providers).
3. Test it with mocked HTTP in the style of `email-global.test.ts` and against its real captured payloads.
4. Set `SPORTOZEN_EMAIL_TRANSPORT=<provider>` and its variables in the server environment file; leave verification and recovery `off`; run the delivery tests of Section 13; then switch features on in the order of Section 7.

No other file changes: not the features, the templates, the outbox, the tracking or the route.

### Environment variables

| Variable                       | Meaning                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPORTOZEN_EMAIL_TRANSPORT`    | `disabled` (default), or the name of a registered provider: `postmark` today; `file` and `capture` are local/test only                                                                              |
| `SPORTOZEN_EMAIL_FROM`         | the sender, on the provider's verified domain; required when a provider is on                                                                                                                       |
| `SPORTOZEN_EMAIL_VERIFICATION` | `off` / `required`                                                                                                                                                                                  |
| `SPORTOZEN_PASSWORD_RECOVERY`  | `off` / `on`                                                                                                                                                                                        |
| the provider's own             | declared by the provider (`requiredEnv`); for Postmark `SPORTOZEN_POSTMARK_TOKEN`, `SPORTOZEN_POSTMARK_STREAM` (optional), `SPORTOZEN_POSTMARK_WEBHOOK_USER`, `SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD` |
| `SPORTOZEN_EMAIL_PREVIEW_DIR`  | where the `file` transport writes (local only)                                                                                                                                                      |

### Messages the application can send

Registration verification and password reset (Better Auth hooks), invitations (Owner, Admin, Coach, Parent), **academy approval notices** (to the platform administrators when an academy is submitted or resubmitted; to the owner on approval, rejection with the reviewer's reason, suspension and reactivation; best effort, never delays a decision), **session cancellation notices** (to linked parents when a confirmed session, or a whole weekly series, is cancelled; see below), and, ready but not yet called by any screen because which events send mail is a product decision: payment receipts, "a report is ready", and a generic notification. Every one goes through the same outbox.

#### Session cancellation notices (purpose `SESSION_NOTICE`)

- **Who:** the active parent accounts linked to a player on the cancelled session's roster, at the address on their account. A guardian with two children in one session still gets one message. Staff, other families and other academies get none. The staff cancellation reason is never in the message (it names the place and the time, in the academy's time zone).
- **When:** only for a session a parent could see (it was scheduled or in progress). Cancelling a draft tells nobody. Cancelling one date of a series sends the single notice for that date; cancelling the whole series sends **one summary per guardian** ("Weekly training cancelled: 3 sessions, 2027-01-11 to 2027-01-25"), not one per date, and does not repeat dates already announced.
- **No duplicates:** before queueing, the service looks for an existing outbox row with the same `relatedId` (`session-cancel:<session id>` or `series-cancel:<series id>`) and address. This check and the insert run inside the training write transaction, which holds the database write lock, so two simultaneous cancellations cannot both pass it (proved with separate processes in `tests/unit/notice-concurrency.test.ts`). No extra index or migration is needed.
- **The hourly limit does not drop a notice.** Normal mail is capped at 5 messages of one kind per address per hour and silently refuses the rest. A cancellation notice that would exceed the cap is queued **held back** (`nextAttemptAt` after the oldest message of that hour has aged out) and sent by the worker then. The mail-bombing guard still holds: past 20 messages of this kind to one address in 24 hours the notice is refused. `enqueueEmailChecked` reports why a message was refused (invalid, suppressed or the daily ceiling) instead of returning `null` for all three.
- **Every recipient is accounted for.** The cancelling user sees, for a series, how many e-mails were queued, held back, already sent earlier, had no address or were refused. E-mail being switched off is reported as such. A failure to queue mail never blocks or undoes a cancellation.

### Delivery tracking and retries

`email_outbox.status` is what this application did (QUEUED, SENDING, SENT, FAILED, EXPIRED, CANCELLED); `deliveryStatus` is what the recipient's mail system did, from the provider's webhook. Retries: 1 min, 5 min, 30 min, 2 h, 6 h; the sixth failed attempt ends as FAILED; delivery is at-least-once. Details in Sections 3 and 10.

### Future production configuration

Sections 12 and 13: the provider account, a sending subdomain, the provider's own DNS records (copy only what the account shows), DMARC starting at `p=none`, the webhook with its credentials, the environment file, a data-processing agreement, and the real-mailbox test. **None of it is done; no DNS was changed; no paid service was bought.**

## 1. Switches (all default to off)

| Variable                       | Values                                                                                                                                                                                                                                                                                                | Effect                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SPORTOZEN_EMAIL_TRANSPORT`    | `disabled` (default); `postmark` (the recommended provider, Section 11; needs `SPORTOZEN_POSTMARK_TOKEN`). `capture` (in memory, tests) is refused in production. `file` (writes each message to `.local/mail-preview`, local development) is refused unless `BETTER_AUTH_URL` is a localhost address | Whether any mail can be sent                                                                |
| `SPORTOZEN_EMAIL_FROM`         | `notifications@<sending domain>` or `Name <address>`                                                                                                                                                                                                                                                  | Required when a transport is on                                                             |
| `SPORTOZEN_EMAIL_VERIFICATION` | `off` / `required`                                                                                                                                                                                                                                                                                    | `required`: an unverified address cannot sign in, create an academy or accept an invitation |
| `SPORTOZEN_PASSWORD_RECOVERY`  | `off` / `on`                                                                                                                                                                                                                                                                                          | Shows "Forgot your password?" and enables the emailed reset link                            |

The application **refuses to start** (and preflight fails) if verification or recovery is switched on with no transport: that would lock people out. Links in messages are always built from `BETTER_AUTH_URL`, never from a request header, and a link to another origin is refused.

## 2. Flows

### Email verification (`required`)

1. Sign-up creates the account but **no session**; a verification message is queued. The page says "Check your email".
2. The message contains a signed link valid for 24 hours. It opens the sign-in page with "Your email address is confirmed". Verification does not sign the person in automatically.
3. Signing in before verifying is refused (403) and queues a fresh link (the person who lost the first message is not stranded).
4. Existing accounts keep working while the switch is `off`. When it is switched on, an existing unverified person is asked to confirm on their next sign-in and gets a link then. Plan this as a staged roll-out, and tell existing users in advance (Section 7).
5. Defence in depth: creating an academy and accepting an invitation also check `emailVerified` while the switch is `required`.

### Password recovery (`on`)

1. "Forgot your password?" on the sign-in page asks for the address. The answer is the same whether or not an account exists, and nothing is sent for an unknown address.
2. The message links to a one-time reset valid for 60 minutes. The reset page takes the token from the link, removes it from the address bar, and asks for a new password (12+ characters).
3. A successful reset **ends every existing session** of that account, makes the old password invalid and the link unusable, and writes an audit entry ("Password reset by emailed link").
4. Better Auth limits reset requests to 3 a minute per client address; the outbox adds a per-address cap (below).

### Invitation delivery

1. Inviting (unchanged form) also queues a message to the invited address, in the same database transaction as the invitation and its audit entry: there is no invitation without its message and no message without its invitation.
2. The message links to `/workspace?invitation=<token>`. The page pre-fills the token field and removes it from the address bar. **It never accepts automatically**: the person must be signed in as the invited address and press the existing button.
3. The invitation token still appears in the administrator's screen as before (manual sharing remains the fallback when delivery fails); the form also says when an email has been queued.
4. New server operations for Owner/Admin (no screen yet, see Section 7): `GET /api/workspaces/{academy}/invitations` (state: pending/accepted/expired; delivery: not sent/queued/sent/failed/expired; never a token), `POST .../invitations/{id}` (renew: new token, new 7-day expiry, unsent mail withdrawn, new mail queued; the old token stops working), `DELETE .../invitations/{id}` (end the invitation and withdraw unsent mail). All three are same-origin, rate-limited, tenant-scoped and audited.

## 3. The outbox (reliability and failure handling)

`email_outbox` (migration 009) is a queue processed by the web process right after a message is queued (without making the request wait) and by `sportozen-worker` every ten seconds. Several processes can run at once: a message is claimed atomically.

- **Retries:** transient failures (network, 429, 5xx) retry after 1 min, 5 min, 30 min, 2 h, 6 h; the sixth failed attempt marks the message `FAILED` ("RETRIES_EXHAUSTED"). Permanent failures (bad address, rejection, authentication) fail at once and are not retried.
- **Expiry:** a message whose link has expired is never sent, even if it was waiting for a retry; it is marked `EXPIRED`.
- **Crash safety:** a claim lasts two minutes; a message left "sending" by a crashed process is picked up again. Delivery is therefore at-least-once: in the rare case a provider accepts a message and the process dies before recording it, the recipient may receive it twice.
- **Mail-bombing guard:** at most 5 messages of one kind per address per hour; further requests are dropped silently (an invitation then reports `NOT_SENT` and can still be shared manually).
- **Secrets at rest:** a message that carries a link keeps its text only until it is sent, expires, fails or is cancelled; then the text is erased. Backups taken after that moment hold no usable link. Finished rows are deleted after 90 days.
- **Logs:** only the message id, purpose, attempt number and an error code are logged. Never an address, a link, a token or a message body (tested with log capture across success, retry and failure). Stored error text has URLs and long tokens replaced.
- **Visibility:** the invitation list shows delivery state; failures are also visible as `FAILED` rows and in the service log. Alerting on them belongs to the monitoring work.

## 4. The provider adapter

`src/server/email/postmark.ts` is the only file that knows Postmark, and `src/server/email/transport.ts` registers it with the other providers (Section 0). The Postmark adapter (`postmarkTransport`) posts to `https://api.postmarkapp.com/email` with the server token in the `X-Postmark-Server-Token` header, a 15-second timeout, open and link tracking off (tracking would rewrite the secret links) and the outbox id as metadata. Responses map onto the outbox's retry contract: a network failure, a timeout, HTTP 429 and 5xx are **transient** (retried after 1 min, 5 min, 30 min, 2 h, 6 h); HTTP 401/403 and every other rejection are **permanent** (the message is marked `FAILED` at once); Postmark error code 406 (an inactive, bounced or suppressed recipient) is permanent with the code `INACTIVE_RECIPIENT`. The token is never logged, stored in the outbox or placed in an error message. To change or add a provider follow "Selecting a provider" in Section 0.

## 5. Sender identity and domain authentication

Use a dedicated sending subdomain (for example `mail.<domain>`) so reputation problems cannot affect the application host. The provider will ask for these DNS records; all three are required for good delivery to Gmail and Microsoft:

- **SPF** (TXT) authorising the provider.
- **DKIM** (CNAME/TXT) signing key(s) supplied by the provider.
- **DMARC** (TXT at `_dmarc.<domain>`), start with `p=none` and a report address, move to `quarantine` once reports are clean.
- Optional: custom return-path / bounce domain; BIMI is not needed.

Messages are plain text, carry no tracking pixels or link rewriting (tracking would alter the secret links), and say what to do if the recipient did not ask for them. `Reply-To` is not set; replies are not read.

## 6. Provider options

See Section 11 for the evaluation (no provider is selected) and Section 16 for the candidates the owner named.

## 7. Roll-out plan (after approval)

1. Provision the provider account and sending domain; add the DNS records; send test messages to mailboxes at Gmail, Outlook and a school domain; check spam placement and DMARC alignment.
2. Add the provider adapter and its tests; deploy with `SPORTOZEN_EMAIL_TRANSPORT=<provider>`, verification `off`, recovery `off`. Send invitations by email first (lowest risk, nothing blocks).
3. Switch on recovery. Watch the outbox for failures for a week.
4. Announce to existing users that they will be asked to confirm their email address, then switch verification to `required`. Keep a break-glass procedure for an owner who cannot receive mail (an operator can mark a verified address after confirming identity by another route; there is intentionally no bypass in the product).
5. Add bounce/complaint webhooks and alerts.

User-interface notes (the approved UI is locked, so these need a design decision): the invitation card note still says "no email or message is sent" and must be reworded when delivery is on; a screen for pending invitations (list, renew, end) is not built, only its API; the sign-in and reset screens reuse the existing components and text style.

## 8. Owner decisions and access needed

- Provider and account (billing owner), region, data-processing agreement.
- Sending domain and who controls its DNS; sender address and display name.
- Whether verification is mandatory for everyone, and for existing users from when.
- Whether parents without an email address are possible (today an account needs one).
- Credentials for the adapter, delivered through the environment file only.

## 9. What was verified

`tests/unit/email-outbox.test.ts` (32 tests) and `tests/unit/email-auth-flows.test.ts` (10 tests, through the real Better Auth handler with its origin and redirect checks on): configuration refusals; templates; send once and erase; retry schedule; give up; permanent failure; expiry before and during retry; per-address cap; crash recovery; concurrent runs send each message once; cancel; log hygiene; purge; invitation queued in the same transaction, listed, failed, renewed, ended and tenant-scoped; verification blocks sign-in until the link is followed and re-sends on sign-in; tampered and foreign-origin links refused; reset single-use, expiring, ends sessions, audited, indistinguishable for unknown addresses, rate limited; no token, link, address or password in the logs. Deliberately broken versions (no session revocation, text kept after sending, no cap) fail these tests.

Not verified: any real provider, deliverability to real mailboxes, bounce handling, the browser flow end to end with real mail (the existing browser suite was run with the features off).

## 10. Global e-mail architecture (one service for every country)

```
feature code --> queue...() in email/index.ts --> templates.ts (one layout: text + HTML)
                                   |
                          address.ts (any valid address, IDN-safe) --> outbox.ts (email_outbox)
                                                                            | claimed atomically, retried, expired
                                                                            v
                                  transport.ts registry: <provider> | file | capture | disabled --> provider
                                                                                              | webhook
                          email_events / email_suppressions / deliveryStatus <-- events.ts <--+
```

- **One sender.** Every message (verification, password reset, Owner/Admin/Coach/Parent invitations, session notices, payment receipts, "report ready", any other notice) goes through `queueVerificationEmail`, `queuePasswordResetEmail`, `queueInvitationEmail`, `queueSessionNotice`, `queuePaymentReceipt`, `queueReportReady` or `queueNotification` in `src/server/email/index.ts`. No feature has its own sender, template or provider call. **What is wired today:** verification, password reset, invitations and the academy approval notices. The session, payment, report and generic notice functions exist, are tested and are ready, but no screen calls them yet; wiring them is a product decision about which events send mail and to whom.
- **Recipients.** `address.ts` checks an address by the standard rules, not by country: any domain and top-level domain is accepted. The examples `rishi@gmail.com`, `alex@yahoo.com`, `sarah@outlook.co.uk`, `ahmed@example.ae`, `james@example.com.au` and `anna@example.de` are test data only; nothing is hard-coded. Internationalised domains are sent in their ASCII form. An invalid address is dropped without being logged. Nothing infers a country from an address.
- **Text.** UTF-8 throughout. International names are kept exactly (tested with Latin accents, Chinese, Devanagari and Arabic text). Control characters are stripped from anything placed in a subject or header, and every value is HTML-escaped in the HTML form.
- **Time.** The database and the outbox hold UTC instants (ISO strings). `format.ts` converts an instant only for display: in the recipient's own time zone and language when one is given, otherwise in UTC, and it says "UTC". Amounts are formatted in their own currency for the recipient's language. The time zone and language are never guessed from the address.
- **Status tracking.** `email_outbox.status` is what this application did (QUEUED, SENDING, SENT, FAILED, EXPIRED, CANCELLED). `deliveryStatus` is what the recipient's mail system did, reported by the provider's webhook (DELIVERED, DELAYED, BOUNCED, COMPLAINED). A bounced or complained message shows as failed on the invitation list.
- **Bounces and complaints.** `POST /api/email/webhooks/<provider>` (one route for every provider, `webhook.ts`) answers 404 for a provider that is unknown, has no webhook adapter, or whose variables are not set. For Postmark it is closed until `SPORTOZEN_POSTMARK_WEBHOOK_USER` and a 16+ character `SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD` are set and uses Basic authentication compared in constant time; any other provider declares its own check. The body limit is 100 KB. It records each provider event once (a replay changes nothing), updates the message and, for a hard bounce or a spam complaint, adds the address to `email_suppressions`: nothing more is queued for it until an operator deletes the row. A soft bounce is recorded as a delay and does not suppress. The payload shapes follow Postmark's documentation and are tested with hand-written payloads, **not** with a real Postmark delivery.
- **Retries and failures.** As in Section 3: transient failures retry with back-off, permanent ones fail at once, delivery is at-least-once.
- **Logs.** Only message ids, kinds, attempt numbers and error codes. Never an address, link, token, message body or credential (tested with log capture).
- **Message text is erased** once a message is sent, expires, fails or is cancelled (text and HTML). Finished rows and provider events are deleted after 90 days.

## 11. Provider evaluation (no provider is selected)

Written from general knowledge of these services. **No live research was done for this document; prices, limits and approval rules change, so the owner must confirm them on each provider's current pages before buying.**

| Criterion                    | Postmark                                                                                                                                                                                                              | Amazon SES                                                                                                    | Resend                                 | SendGrid / Mailgun                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| International deliverability | Strong reputation for transactional mail; transactional-only streams keep reputation separate from bulk                                                                                                               | Good when set up well; reputation is managed by the sender (dedicated IPs optional)                           | Good for a young service; shared pools | Established; shared-IP reputation varies by plan |
| API reliability              | Simple HTTP API, clear error codes                                                                                                                                                                                    | Mature; request signing required                                                                              | Simple HTTP API                        | Mature                                           |
| Bounce / complaint handling  | Built-in webhooks (delivery, bounce with type, spam complaint)                                                                                                                                                        | Events through SNS; the application would have to confirm subscriptions and verify SNS signatures (more code) | Signed webhooks                        | Signed webhooks                                  |
| Domain verification          | Domain DKIM plus a custom Return-Path                                                                                                                                                                                 | Domain DKIM, optional custom MAIL FROM                                                                        | Domain DKIM and SPF                    | Domain authentication                            |
| Cost and limits              | Paid from a monthly minimum per volume tier (about USD 15 a month for 10,000 messages at the time of writing, to be confirmed); a new account goes through manual approval before it can send to arbitrary recipients | Lowest per message; a new account starts in a sandbox and needs a production-access request                   | Small free tier, then monthly tiers    | Varies by plan                                   |
| Region                       | United States                                                                                                                                                                                                         | Many, including Mumbai (ap-south-1)                                                                           | Check current regions                  | Check current regions                            |

**No provider has been selected, and this table is not a recommendation.** It was written earlier from general knowledge of these services; prices, limits and approval rules change, so the owner must confirm them on each provider's current pages before choosing. Postmark's adapter exists because its API and webhook contract could be checked against its published documentation; that is a statement about the code, not about which provider is best. Candidates the owner has named, Zoho ZeptoMail and Zoho Mail, are in Section 16. A provider that needs request signing (Amazon SES) or a different event channel would need its own adapter and webhook adapter; neither is written. Nothing has been bought or configured.

## 12. External configuration still required (none of this has been done)

The steps are the same for any provider; the examples name Postmark because it is the adapter that exists. For another provider use the same steps with its own console, records and variable names.

1. **Provider account** (billing owner). Some providers review new accounts: describe the use, give the website and the sending domain.
2. **A sending subdomain** such as `mail.<your domain>`, and DNS control for it.
3. **A server and the "outbound" transactional stream** in the provider. Copy its Server API token into `SPORTOZEN_POSTMARK_TOKEN` in `/etc/sportozen/sportozen.env`.
4. **Domain authentication records** exactly as the provider displays them: the DKIM record(s) and the custom Return-Path record that make SPF align. Do not copy values from this document or from any other source.
5. **DMARC** TXT record at `_dmarc.<sending domain>`. Start with `v=DMARC1; p=none; rua=mailto:<a mailbox that is read>` and move to `quarantine` once the reports are clean.
6. **The webhook.** In the provider's server settings add `https://<host>/api/email/webhooks/postmark` with a Basic-auth user and a 16+ character password, and subscribe to Delivery, Bounce and Spam complaint. Set the same user and password in `SPORTOZEN_POSTMARK_WEBHOOK_USER` and `SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD`.
7. **Environment.** `SPORTOZEN_EMAIL_TRANSPORT=postmark`, `SPORTOZEN_EMAIL_FROM` on the verified domain, verification and recovery left `off` until Section 13 has passed, then switched on in the order of Section 7.
8. A **data-processing agreement** with the provider.

## 13. Delivery tests that must pass before live delivery is called working (all NOT YET RUN)

Send real messages (verification, reset, invitation) from the deployed staging host to mailboxes at: Gmail in India, Outlook or Hotmail in the UK, Yahoo in the USA, a `.ae` mailbox, a `.com.au` mailbox, a `.de` mailbox and an internationalised-domain mailbox. For each, check: arrival and spam-folder placement; message headers show SPF, DKIM and DMARC **pass** and aligned; the link opens and works once; the correct local time is shown; a deliberate bounce (an address that does not exist) is recorded by the webhook and suppresses the address; a complaint is simulated if the provider offers it. Record the results; only then change the status of live delivery from BLOCKED.

## 14. Local development and tests

When the application runs as `next dev` (`NODE_ENV=development`) on a localhost address and the e-mail variables are not set, it defaults to `SPORTOZEN_EMAIL_TRANSPORT=file` and `SPORTOZEN_PASSWORD_RECOVERY=on`, so "Forgot your password?" works with no configuration. Each message is written to `.local/mail-preview/<time>-<id>.json` (recipient, subject, text), so a developer can open a reset or verification link without sending anything. The default never applies to a build, to `next start` or to a real deployment, and `SPORTOZEN_EMAIL_TRANSPORT=disabled` switches it off. The `file` transport is refused unless `BETTER_AUTH_URL` is a localhost address (or, with none set, the server is local). No `.env` file is committed: the repository's secret scan forbids them.

The "Forgot your password?" link on the sign-in page is always visible. Where e-mail delivery is not switched on for the deployment, using it shows an explanation instead of promising a message that cannot arrive.

## 15. What was verified in this round

| Item                                                                                                                                                | Evidence                                                                                                                                                   | Level                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| "Invalid origin" fixed; untrusted origins, other ports and a cookie-carrying forged origin still refused; a wildcard configuration refuses to start | `tests/unit/auth-origin.test.ts` (real handler, origin checks on), `tests/unit/app-origin.test.ts`; live check against the running dev server on port 3005 | Locally verified                   |
| Registration, e-mail confirmation, forgot password, reset, one use, expiry, no account enumeration, sessions ended, rate limit                      | `tests/unit/email-auth-flows.test.ts`, `tests/e2e/email-auth.spec.ts` (browser, production build, file transport)                                          | Locally verified (mocked delivery) |
| Addresses from several countries and an internationalised domain through registration, confirmation, recovery and invitations                       | `email-auth-flows.test.ts`, `email-outbox.test.ts`, `email-global.test.ts`                                                                                 | Locally verified (mocked delivery) |
| Postmark adapter request shape and error mapping; webhook authentication, replay safety, suppression                                                | `tests/unit/email-global.test.ts` (HTTP mocked)                                                                                                            | Locally verified (mocked HTTP)     |
| Delivery to real mailboxes in India or any other country; SPF, DKIM and DMARC alignment; real bounce events                                         | none                                                                                                                                                       | **BLOCKED / NOT TESTED**           |

## 16. Candidate providers: Zoho ZeptoMail and Zoho Mail (not selected)

**Status: neither is selected, implemented, configured or tested.** The owner has said Zoho ZeptoMail, Zoho Mail or another provider may be chosen later. The application is ready to receive an adapter for any of them (Section 0); nothing in this section has been run against Zoho. Nothing was sent, no account, DNS record or credential exists, and no paid service was bought. The facts about Zoho below were read from Zoho's public documentation in November 2026 (links at the end) and **must be re-read from the owner's own ZeptoMail account when the adapter is built**: Zoho's documentation is in transition (it now sits partly under "Zoho CPaaS") and more than one API host appears in it.

### 16.1 Adapter architecture (one email system, one more provider)

Everything the application sends goes through one service (Section 0). Adding ZeptoMail, if it is chosen, is one new file and one registry line, not a second email system:

1. `src/server/email/zeptomail.ts` exporting an `EmailProvider` named `zeptomail`: `requiredEnv` (so a deployment that names it without a token refuses to start, exactly as `postmark` does), a transport that POSTs JSON over HTTPS with a timeout and maps the answers onto the existing classes (network failure, timeout, 429 and 5xx **transient**; 401/403 and every other 4xx **permanent**; a 2xx without a message reference a failure), and a webhook adapter (16.4). Registered in `transport.ts`; its name added to `EMAIL_TRANSPORTS` in `scripts/lib/preflight.mjs`.
2. Tests with a mocked HTTP layer, as for Postmark, **written against the contract in the owner's own account** (16.4). Real delivery stays **blocked until it has been tested from the deployed host** (Section 13).

**Zoho Mail** is a mailbox product. Whether its API or SMTP is suitable for application-generated transactional mail (sending limits per mailbox, whether it reports bounces and complaints, whether it may be used for automated mail at all) has **not been assessed**; the questions to answer from Zoho's current documentation before it is considered are: the sending limit and whether it is enforced per mailbox or per domain; whether a delivery-report channel exists that can be mapped to `DeliveryEvent`; and Zoho's terms for automated sending. An SMTP adapter (the protocol is standard) would need an SMTP client library, which the project does not have and would have to add on purpose.

The local transports are untouched: `file`, `capture`, `disabled`. A developer needs no account with any provider.

### 16.2 Environment variables

Existing, already read by the code and listed in `deploy/sportozen.env.example`: `SPORTOZEN_EMAIL_TRANSPORT` (`disabled` | `file` | `capture` | a registered provider, `postmark` today), `SPORTOZEN_EMAIL_FROM` (the sender, which must be on the verified domain), `SPORTOZEN_EMAIL_VERIFICATION` (`off` | `required`), `BETTER_AUTH_URL` (the public origin used in every link).

Proposed for a ZeptoMail adapter if it is chosen (**names are a proposal; none is read by the code yet**): `SPORTOZEN_ZEPTOMAIL_TOKEN` (the agent's Send Mail token; secret; server environment file only, mode 0600), `SPORTOZEN_ZEPTOMAIL_ENDPOINT` (the full send URL of the owner's data-centre region, so that no host is hard-coded), `SPORTOZEN_ZEPTOMAIL_WEBHOOK_SECRET` and, if the Authorization-header option is used, `SPORTOZEN_ZEPTOMAIL_WEBHOOK_AUTH`. Until they exist keep `SPORTOZEN_EMAIL_TRANSPORT=disabled`: sign-in, the application and its in-app messages work; password recovery and e-mail verification are then off and the sign-in screen says so.

### 16.3 Sender domain, SPF, DKIM, DMARC (all done by the owner, none done)

From Zoho's documentation: create a **Mail Agent**; associate the sending domain with it; Zoho shows the DNS records to publish. Verification currently needs a **DKIM TXT record** and a **CNAME record** (the CNAME creates the bounce / return-path subdomain, and Zoho handles SPF for that subdomain itself); older pages still list an SPF record, so publish exactly what the account shows. DNS can take up to 48 hours; **until the domain is verified, mail cannot be sent**, and the From address must belong to the verified domain. Publish a DMARC record for the domain as well: start with `p=none` and a reporting address (`rua`), read the reports, then move to `quarantine` and `reject` once all legitimate mail passes. Because the return path is a subdomain, SPF alignment may fail under strict alignment (`aspf=s`) while DMARC still passes through DKIM; keep relaxed alignment (the default). Sending from a subdomain such as `notifications@mail.your-domain` keeps the main domain's reputation apart, if the owner wants that. The DNS step is the owner's; it is listed in `docs/DEPLOYMENT.md`.

### 16.4 Delivery status, bounces and complaints

Zoho can post events to a webhook configured on the agent: hard bounce, soft bounce, delivered, feedback-loop (spam complaint), and open and click events (the application does not use opens and clicks, and tracking must stay **off**, because it rewrites the secret links in password-reset and invitation messages). A webhook can carry a fixed Authorization header, and the agent can sign requests (HMAC-SHA256 with a timestamp and a signature header) which the receiver must verify and reject when stale. The payload names the event, the recipient and a reference; to map it to the outbox the sender passes the outbox id as the client reference (the Postmark adapter does the same with its metadata).

Required behaviour, all of it already implemented in the shared webhook handler and the delivery tracking, and reusable by any provider's webhook adapter: verify the credentials before reading the body; limit the body size; record each event once (a replay changes nothing); a **hard bounce or complaint suppresses the address**, a soft bounce or delay does not; a late "delivered" never undoes a bounce; an unknown message creates no suppression; addresses, links and text never reach the log. The webhook route must stay absent until its credentials are configured (as the Postmark route is). Zoho's documentation does not state a retry policy for webhooks and does not list every event name exactly, so the parser must be written against a real captured payload from the owner's account; until then the outbox's own status (`SENT`, `FAILED`) is the only source of truth.

### 16.5 International addresses

Verified by `tests/unit/email-global.test.ts` and `tests/unit/email-international.test.ts`: any top-level domain; internationalised domains (`anna@münchen.de`, `x@例え.jp`, `x@пример.рф`) are converted to their ASCII form (punycode) before sending; domains are case-insensitive; header injection is impossible (control characters and line breaks are refused or removed); names in any script keep their characters in the text and HTML bodies; messages are UTF-8. **Limits that belong to the world, not to this application:** an address with a non-ASCII _local part_ (`josé@example.es`, `名前@example.jp`, SMTPUTF8) passes the check but needs a receiving server and a provider that accept SMTPUTF8; no sign-in account can be _created_ for such an address (accounts need an ASCII form), and a provider that rejects it produces a permanent failure in the outbox, which the administrator sees. Look-alike (homograph) domains are accepted, as any provider accepts them; the application does not judge a domain's trustworthiness.

### 16.6 External requirements (the owner's; none done)

A Zoho ZeptoMail account in the data-centre region the owner chooses (it decides the API host and where message data is processed); a verified sending domain with the records above; a Mail Agent and its token; the sender address and display name; a webhook endpoint reachable from the internet over HTTPS; Zoho's data-processing terms; and **one deliberate real-world test** to addresses at several mailbox providers in several countries (including one internationalised domain), checking inbox placement, the authentication headers (SPF, DKIM and DMARC pass), a forced bounce and the suppression that follows, before anybody says that email works.

Sources read: Zoho ZeptoMail documentation on [webhooks](https://www.zoho.com/zeptomail/help/webhooks.html), [the email API](https://www.zoho.com/zeptomail/help/api/email-sending.html), [domains](https://www.zoho.com/zeptomail/help/domains.html), [DMARC](https://www.zoho.com/zeptomail/help/dmarc-policy.html) and [the SPF change](https://www.zoho.com/blog/cpaas/spf-removal.html). The email API page shows `POST https://cpaas.zoho.com/v1.1/email` with `Authorization: Zoho-enczapikey <token>`, a `from` object, a `to` array of `email_address` objects, `subject`, `htmlbody` / `textbody`, `track_opens`, `track_clicks`, `bounce_address` and `client_reference`, and answers 200 with a `request_id` or 400 with an error code. Third-party integrations use regional hosts such as `api.zeptomail.eu` and `api.zeptomail.in`, which Zoho's page does not list. Choose the host from the account.
