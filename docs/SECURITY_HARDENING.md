# Application and infrastructure security (WP7)

Status: **implemented and verified locally. No penetration test has been done, there is no DDoS or edge protection, and nothing here was run on a production host.** Account-level controls are in [AUTHENTICATION.md](AUTHENTICATION.md); deployment, proxy and database in [DEPLOYMENT.md](DEPLOYMENT.md), [SECURITY_AND_DEPLOYMENT.md](SECURITY_AND_DEPLOYMENT.md).

## 1. What changed in this package

| Area | Change | Evidence |
| --- | --- | --- |
| Content Security Policy | Page responses now carry `script-src 'self' 'nonce-…' 'strict-dynamic'` with a fresh nonce per response (previously there was no `script-src`). API responses carry `default-src 'none'`. Both are decided per request by the proxy, so `SPORTOZEN_CSP` takes effect on restart without a rebuild. | `security-policy.test.ts`, `security-headers.test.ts`, `tests/e2e/csp.spec.ts` |
| Headers | Added `Cross-Origin-Resource-Policy: same-origin`. Everything else was already present. | `security-headers.test.ts` |
| Violation reports | `POST /api/csp-report` (unauthenticated by nature) logs allow-listed fields only, drops query strings, is size-limited, and is rate-limited per source address and overall (junk spends no budget). | `csp-report.test.ts`, `csp.spec.ts` |
| Zod in the browser | Zod's JIT probe (`new Function`) was reported as a CSP violation on the academy list page; it is switched off in the browser only. | found by `csp.spec.ts` |
| Dependencies | Vitest 3.2.7 → 4.1.12; advisories on the production tree 5 → 0 (all 6 → 1, development only). | Section 5 |
| Secret scanning | `scripts/secret-scan.mjs` (no dependencies): private keys, provider token formats, JWTs, passwords in URLs, quoted and unquoted secret-looking assignments, environment and key files. Scans the current tree, not history. Run in CI and by a unit test. | `secret-scan.test.ts` |
| CI gates | `pnpm audit --prod --audit-level=high`, secret scan, an account-security browser job; Dependabot weekly version updates (security updates are a repository setting the owner must switch on). | `.github/` |
| Static guards | Tripwire tests for built SQL (exact, counted list), raw-HTML and code-execution sinks, header-based identity claims; a test that calls every API route anonymously and probes the open ones. | `code-inventory.test.ts`, `route-authentication.test.ts` |
| Host hardening | Extra systemd sandboxing; nftables (with a safe apply script), sshd and fail2ban templates under `deploy/host/`. | Section 6 |
| Webhook body | The WhatsApp webhook now reads its body with a streaming size limit (a chunked body had no length check before it was fully read). | `route-authentication.test.ts` |

## 2. Content Security Policy

**Page policy** (`src/config/security-policy.ts`, applied per request by `src/proxy.ts`; `next.config.ts` carries no content policy, so there is exactly one per response; API responses get `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` from the same proxy):

```
default-src 'self'; script-src 'self' 'nonce-<per response>' 'strict-dynamic';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self';
connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:;
frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';
[upgrade-insecure-requests on HTTPS]; report-uri /api/csp-report
```

**Why this shape.** Next.js 16 stamps the nonce on its own inline and bundle scripts only while rendering a request, so every page must render per request. The root layout is `force-dynamic`. Before this change five pages were static (`/`, `/_not-found`, `/account/security`, `/design-preview`, `/design-preview/prototype`); every other page was already dynamic, so the cost is small (a manual `curl` timing on the development machine gave a median first-byte time of 27 ms for `/sign-in` over ten requests; this is an indication, not a benchmark). The proxy matcher covers pages and the API, and skips only `_next/static`, `_next/image`, the favicon and Next.js router prefetches (data for client navigation, not documents). The experimental hash-based alternative (`experimental.sri`) was not adopted: it is documented as experimental and was not verified with Turbopack.

**`style-src 'unsafe-inline'` stays.** React renders `style=""` attributes throughout the application and a nonce cannot cover attributes. Script is the dangerous part; style injection changes appearance, not behaviour. This is a documented residual risk.

**What was tested against the real application (production build, `next start`):**

- `tests/e2e/csp.spec.ts` loads, with the policy **enforced**: `/`, `/sign-in`, `/reset-password`, the three legacy demo areas, a 404 demo route, `/design-preview`, and, signed in, `/workspace`, `/account/security`, `/platform` and the academy portal in five sections. For each: the response carries the policy, every script in the server's HTML carries the nonce, and the browser reported **no** violation and no CSP console error. Hydration is checked by using the sign-in form.
- Enforcement is proven, not assumed: the server HTML is altered in flight to contain an inline script and an inline `onerror` handler without a nonce; neither runs and both violations are reported.
- The first run of this spec found a real violation: Zod's `allowsEval` probe (see Section 1). It was fixed in `src/lib/zod-csp.ts` and the spec now passes.
- The full existing browser suite is run under the enforced policy in WP9 (any inline-script breakage would fail functional tests; any style/font/image violation would appear as `csp.violation` lines in the server log).

**Rollout without risk:** `SPORTOZEN_CSP=report-only` sends the same policy as `Content-Security-Policy-Report-Only`, so a real deployment can watch `csp.violation` log lines (WP8) before enforcing. `off` exists for emergencies and is flagged by preflight.

**Known gap: `/_global-error`.** Next.js prerenders this fallback (used only if the root layout itself throws) as static HTML with inline scripts that cannot carry a per-request nonce, so under the enforced policy that page's scripts are blocked and it stays a static message. It still shows its text; it is not exploitable. Ordinary 404s (`/does-not-exist`, `/apiary`) are rendered per request and tested.

**What is still fixed at build time:** the other headers (`nosniff`, framing, referrer, permissions, COOP/CORP, and HSTS, which depends on `BETTER_AUTH_URL` at build). `preflight --artifact` checks that they are baked into the build; build with the real HTTPS origin.

**Limits of the policy.** `strict-dynamic` trusts scripts that trusted scripts create, so a DOM-based injection inside the application's own code could still run; the inventory test keeps raw-HTML sinks out of the browser code. No Trusted Types. Development builds need `'unsafe-eval'` (React's debugging), production does not. Browsers without CSP level 3 fall back to `'self'` and the nonce.

## 3. Other browser-facing controls (already present, re-verified)

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (and `frame-ancestors 'none'`), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, USB off), `Cross-Origin-Opener-Policy: same-origin`, new `Cross-Origin-Resource-Policy: same-origin`, HSTS (`max-age=31536000`) only for an HTTPS `BETTER_AUTH_URL`, no `X-Powered-By`, private `no-store` on API responses. HSTS `includeSubDomains` and preload are deliberately **not** set: they commit the whole domain and wait for the domain decision (owner decision D3).

## 4. Threat and control map

| Threat | Control | Evidence | Residual risk |
| --- | --- | --- | --- |
| Injected script (XSS) | Nonce CSP; no raw-HTML sinks; React escaping; PDFs/JSON never rendered as pages | `csp.spec.ts`, `code-inventory.test.ts` | DOM XSS via trusted code under `strict-dynamic`; style injection |
| CSRF | Same-origin check on every state-changing route; Better Auth origin check; `SameSite=Lax` cookies | `rate-limit-routes.test.ts` (every mutating route), `email-auth-flows.test.ts` | None known; depends on `BETTER_AUTH_URL` being the exact public origin (preflight) |
| SQL injection | Prepared statements with bound parameters; the few built statements (table names from literal lists, a savepoint counter) were each read and pinned in an exact list | `code-inventory.test.ts` (a tripwire, not a proof) | The test sees `prepare()`/`exec()` calls with template interpolation or a variable argument; SQL assembled elsewhere is caught only by review |
| Cross-academy access, privilege escalation | Membership checked on every request, per-record scope; roles; MFA gate | `security-matrix.test.ts` (99 cases), `invitation-security.test.ts`, `mfa-policy.test.ts` | Not independently penetration-tested |
| Unauthenticated access | Every route authenticates first; 5 reviewed open routes | `route-authentication.test.ts` (calls each handler anonymously) | Webhook relies on its HMAC secret |
| Credential stuffing / guessing | Per-address and per-account limits, lockout, second step | `auth-lifecycle.test.ts` | Distributed attack across many accounts; no CAPTCHA; no edge WAF |
| Session theft | HttpOnly, Secure, SameSite; absolute limit; revoke on password change/enrolment | `auth-lifecycle.test.ts` | Theft from a compromised browser |
| Spoofed client address | Proxy overwrites forwarded headers; trusted-proxy config checked at start | `test-proxy.sh` (real nginx), `proxy-trust.test.ts` | Correct only if the proxy is the sole entry |
| Oversized or malformed input | Body caps (1 MB JSON, 16 KB auth, 8 KB reports, 2 MB edge); zod validation; logo is a validated PNG data URL ≤ 300 KB | `request-errors.test.ts`, `auth-lifecycle.test.ts` | Edge limits unverified on a real host |
| Webhook forgery | HMAC-SHA256, timing-safe compare; edge rate limit | `period-communication.test.ts`, nginx template | IP allow-list not applied |
| File download abuse | PDFs only after the same scope check, `attachment`, `nosniff`, server-generated ids in file names | `api-baseline.test.ts`, `security-matrix.test.ts` | None known; there are no user uploads other than the logo |
| Tampering with history | Append-only triggers on audit and approval tables; integrity checker | `history-protection.test.ts`, `data-integrity.test.ts` | A database administrator with file access can still alter the file; backups are encrypted |
| Secret leakage | Secrets only in environment; preflight; secret scan of the current tree; log allow-lists and redaction; tokens hashed at rest | `secret-scan.test.ts`, `email-outbox.test.ts`, `auth-lifecycle.test.ts`, `log-hygiene.test.ts` | History is not scanned (a secret once committed must be rotated); the scan only protects if CI is a required check; the environment file is readable by root and the service user |
| Vulnerable dependency | `pnpm audit --prod` gate in CI; Dependabot; upgrade done | Section 5 | One development-only moderate (minimatch) |
| Denial of service | Application write/auth limits, request caps, nginx edge limits (WP2), body timeouts | `rate-limit-*.test.ts`, `test-proxy.sh` | **No DDoS protection.** A volumetric attack needs an upstream provider (owner decision D10) |
| Clickjacking, content sniffing, cross-origin embedding | `frame-ancestors`, `X-Frame-Options`, `nosniff`, CORP | `security-headers.test.ts` | None |
| Host/port exposure | App on 127.0.0.1; host firewall template; SSH keys only; fail2ban template | Section 6 | Templates validated for syntax and regex only |

## 5. Dependency audit (`pnpm audit`, 2 Nov 2026)

| Advisory | Package | Severity | Reached through | Exposure | Decision |
| --- | --- | --- | --- | --- | --- |
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | tinypool (prototype pollution → RCE) | critical ×2 | vitest (and Better Auth's optional peer) | A production install (`pnpm install --prod`) **did** install vitest 3.2.7 and tinypool 1.1.1, because Better Auth lists vitest as an optional peer that pnpm resolved from our dev dependency. Not executed by the running application; real on CI and developer machines | **Fixed:** vitest 4.1.12 (no tinypool). The package is still present in a production install as that peer (an attempt to remove it with a pnpm override did not work), but it is now the patched version and the production audit is clean, so the exposure was removed by patching, not by omission |
| GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | vitest, @vitest/mocker | moderate ×3 | vitest | Test tooling | **Fixed** (same upgrade) |
| GHSA-g3hv-75wg-m249 | minimatch <11.0.1 (ReDoS) | moderate | ESLint and tooling (85 paths) | Development only; patterns come from our own configuration | **Accepted.** Forcing minimatch 11 under ESLint 9 would break the linter's own API; revisit with the next ESLint major |

Compatibility check for the upgrade: the whole unit suite (955 tests then) passed under vitest 4.1.12 and ran faster (48 s versus 63 s on the same machine); the only change needed was typing the console spy in one test; `pnpm-lock.yaml` changed only for vitest and its own dependencies. `pnpm audit --prod`: **No known vulnerabilities found**. `pnpm audit`: 1 moderate (minimatch). Versions were not otherwise bumped (Next.js 16.4.1, Better Auth 1.7.7, TypeScript 5.9.3 unchanged; newer majors of some packages exist and were left alone deliberately).

## 6. Host-level protections that need no provider

`deploy/host/` holds templates, checked as far as a workstation allows:

| File | Purpose | Checked how |
| --- | --- | --- |
| `nftables.conf` + `apply-firewall.sh` | Default-deny inbound; 80/443 open; SSH only from the administrators' IPv4 and IPv6 ranges, rate-limited; reloading replaces the table. The apply script refuses the placeholder range, checks syntax, and removes the rules unless you confirm within 60 s | `nft -c -f` and the script's guards, by `deploy/tests/test-host.sh` on Ubuntu under WSL (the rules were not loaded into a live kernel firewall) |
| `sshd_config.d-sportozen.conf` | Keys only, no root, 6 tries, no forwarding (name the allowed users before use) | `sshd -t` |
| `fail2ban/sportozen-auth.conf`, `sportozen.local` | Ban an address after 10 refused auth requests in 10 minutes (everyone behind one shared address shares the ban) | `fail2ban-regex` on sample nginx combined-format lines: the 3 refused auth lines matched, the successful sign-in, a GET and another route's 403 did not. URL-encoded or `//api/auth` forms are not matched |
| `deploy/systemd/*.service` | Sandboxing: private /tmp, strict file system, no capabilities, restricted address families/namespaces, native syscalls, hidden other-user processes | Not run under systemd; run `systemd-analyze security sportozen-web` on first deployment. The backup unit's sandbox can block an upload that needs a mounted directory or a configuration under a home directory (its comments say what to add); run it once by hand after any change |

Run `sudo bash deploy/tests/test-host.sh` to repeat the checks above. Not done, and needing the server: automatic OS security updates (`unattended-upgrades`), kernel/OS patch policy, disk encryption at the provider, an intrusion/file-integrity tool, and verifying all of the above on the real host.

## 7. Secret handling review

Secrets in the design: `BETTER_AUTH_SECRET`, backup encryption key, e-mail provider credentials (future), WhatsApp and Google Places credentials (disabled), the off-server backup credential. All are read from the environment file only (`/etc/sportozen/sportozen.env`, mode 0600, outside the release); `preflight` refuses placeholders, short secrets and a database inside the release directory; `secret-scan` (current tree only, as a required CI check) catches committed credentials; logs use allow-listed fields (tested for e-mail, auth, backup and CSP paths). `.env*` and `.local/` are git-ignored. **Not done:** a rotation drill (note that rotating `BETTER_AUTH_SECRET` invalidates sessions and makes enrolled second steps unreadable, [AUTHENTICATION.md](AUTHENTICATION.md)), a secrets manager (owner decision D11), and a secret inventory with named holders.

## 8. Residual risks (explicit)

1. No independent penetration test (assessment blocker B10). Everything above is the team's own testing.
2. No DDoS/WAF layer; only host and nginx limits.
3. `style-src 'unsafe-inline'`; `strict-dynamic` semantics; no Trusted Types.
4. Host hardening templates not yet applied or measured on a real server; systemd sandbox not run under systemd.
5. One accepted moderate advisory (minimatch, development only).
6. Webhook allow-listing, bot protection on registration, and breach-password checks are not implemented.
7. Legal/consent work for children's data is outside this package.
