# Release acceptance checklist (WP9)

Measured against Section 20 ("What QA must prove before release"), Section 4.4 ("Academy sign-off conditions") and "Other release acceptance criteria" of `Sportozen_Complete_Product_Engineering_Audit.pdf` (23 October 2026), for the **Academy release** (Football academy software). The audit's other releases (venue operations, marketplace, sports engagement, advanced platform) concern products that are not in this repository and are out of scope here.

**Verdict: NO-GO for production use with real children's data.** Nothing has been deployed, no production environment exists, and no production validation has been performed. Every row that needs the real environment or an owner decision is **BLOCKED — external dependency**, not passed. No Critical or High finding has been waived.

## Status vocabulary (used exactly)

- **IMPLEMENTED**: the code or document exists.
- **VERIFIED LOCALLY**: tested by automated tests, a local production build, or the isolated Linux test host described in section 3. *Not* the target environment.
- **INDEPENDENTLY REVIEWED**: a separate reviewer inspected it (section 4).
- **BLOCKED — external dependency**: cannot be done without something only the owner or a third party can provide.
- **PRODUCTION VALIDATED**: proven on the approved target environment. **Nothing is in this state.**

## 1. Audit scenarios (Section 20)

| Audit scenario | Applies to Academy release? | Evidence | Status |
| --- | --- | --- | --- |
| Academy coach requests unassigned player → access denied | Yes | `security-matrix.test.ts` (99 cases), `access-scope.test.ts`, `football-scope.test.ts`, browser `training.spec`, `workspaces.spec` | VERIFIED LOCALLY |
| Academy A requests Academy B data → access denied | Yes | `security-matrix.test.ts`, `tenant isolation` cases, `invitation-security.test.ts`, browser `workspaces.spec` | VERIFIED LOCALLY |
| System deployment rolls back; existing data and consistency maintained | Yes | `deploy/tests/test-release.sh` (31 cases) and the Linux rehearsal: a release with its readiness route removed was refused at readiness, the previous release came back automatically in 3 s after the 25 s wait, 3 of 3 players and the signed-in session were intact | VERIFIED LOCALLY (Linux test host); target environment BLOCKED |
| Notification provider is unavailable → core transaction remains valid | Yes (invitations, verification, reset) | `email-outbox.test.ts`, `email-auth-flows.test.ts`: the invitation exists and can be shared by hand while delivery retries or fails; no provider exists yet | VERIFIED LOCALLY (test transport only); real provider BLOCKED |
| Two users choose the same court/time; staff and consumer reserve simultaneously; hold expiry; payment success/callback/late payment; booking cancel/reschedule; staff blocks court | No | Booking, CBMS and payment gateway are not part of this repository | NOT APPLICABLE to this release |
| Event reaches capacity; provider corrects a result; prediction edited after lock; chat reconnect | No | Events, live sports, predictions and chat are not in this repository | NOT APPLICABLE |
| Venue A staff requests Venue B bookings; MCP attempts unauthorised write | No | No venue or MCP product here | NOT APPLICABLE |

## 2. Other release acceptance criteria

| Criterion | Evidence | Status |
| --- | --- | --- |
| **Functional and integration testing** | Unit and API suite: 1,058 tests pass and 2 (POSIX-only) are skipped, in 73 files (Vitest 4.1.12). Browser suite (69 specs): main suite 68 of 69 passed in 12.8 minutes; the 69th (`academy-portal`) failed only on its final evidence step, `git rev-parse HEAD`, because the frozen copy has no git metadata, and passed when re-run with read-only access to the repository's metadata; `account-security` 2 of 2; `simple-session` 1 of 1; monthly report review 12 of 12 on rerun (its first run had 1 failure, case 05, which did not repeat). An earlier full run on the shared folder had `training.spec` fail once (a known timing-sensitive spec; it passed in the clean run) | VERIFIED LOCALLY |
| **Regression testing** | Same suites on the integrated tree; the Phase 1 patches and the Phase 2 and WP6–9 changes reproduce byte-for-byte from the main checkout (section 5) | VERIFIED LOCALLY |
| **Security testing** | Account lifecycle, MFA, content-policy, route authentication, log hygiene, secret scan, dependency audit, host templates; threat map in `SECURITY_HARDENING.md`. **No independent penetration test.** | VERIFIED LOCALLY; penetration test BLOCKED — external dependency |
| **Performance testing** | `scripts/load-check.mjs` on the production build running as a systemd service (12 CPUs, 3.7 GB, load generator on the same machine), section 6. Target server and expected traffic unknown | VERIFIED LOCALLY (indicative only); target BLOCKED |
| **Browser regression** | Section 2 line 1; mobile 320/390/768 px routes in `mobile.spec` | VERIFIED LOCALLY |
| **User acceptance** | Script and sign-off table prepared (`UAT_AND_HANDOVER.md`); **not executed** | BLOCKED — external dependency (people and environment) |
| **Tested backup restoration** | Linux test host: encrypted backup taken by the systemd unit, copied to a second directory, **restored from that copy on a separate file** with the key only; restore refuses to overwrite the live database; tamper, wrong key and truncation tests in `backup.test.ts` (34). Real off-server store, key custody and timed drill on the target: not done | VERIFIED LOCALLY; real store and drill BLOCKED — external dependency |
| **Controlled database migrations** | Migrations are additive and run under `BEGIN IMMEDIATE`; a deterministic test reproduces and proves the old race fix; pre-deploy backup is mandatory in `release.sh`; migrations are not reverted by rollback (documented) | VERIFIED LOCALLY |
| **Meaningful monitoring** | `ops-check` (13 checks), alert rules with confirmation and de-duplication, unit-failure alerts. Linux test host: stopping the service produced a CRITICAL alert at the receiver after 80 s and a RESOLVED message after recovery; a failing backup unit produced an alert naming it. **No real alert destination exists.** | VERIFIED LOCALLY; real destination BLOCKED — external dependency |
| **Deployment rollback** | Section 1 (rollback row) and `rollback.sh` manual rollback and forward on the test host | VERIFIED LOCALLY (Linux test host) |
| **Operational ownership** | Responsibility table, secrets inventory and recurring tasks prepared; **no names assigned** | BLOCKED — external dependency (owner decisions) |
| **Stakeholder sign-off** | None obtained | BLOCKED — external dependency |

## 3. What the Linux test host was (and was not)

An Ubuntu 26.04 distribution under WSL2 on the developer's machine with real systemd 259, nginx 1.28 with the repository's template (self-signed certificate for `academy.rehearsal.internal`), Node 24.13.0, a `sportozen` service user, the repository's unit files and `deploy/release.sh`/`rollback.sh`, and a local directory standing in for the off-server store and a local process standing in for the alert destination. Releases were built exactly as `DEPLOYMENT.md` section 4 describes. It proves the **mechanics** of deployment, rollback, backup, restore, monitoring and alerting on a Linux/systemd/nginx stack. It does **not** prove: the target provider's behaviour, DNS, real certificates (Let's Encrypt), the network firewall (templates were syntax-checked, not loaded), a real off-server store, a real alert channel, real e-mail, or behaviour under production traffic and data volumes.

Linux rehearsal results (final pass: 32 checks, 0 failed; the exit-code-143 fix was then verified separately on the same host: a deliberate restart and stop raised 0 alerts, `SIGKILL` still restarted the unit):
first deployment as the unprivileged user; data created through nginx and TLS (Secure, HttpOnly cookie; HSTS; content policy; request id header); healthy upgrade with pre-deploy backup copied off-server and the session surviving the restart; failed release rolled back automatically and logged; manual rollback and forward; clean stop with the database folded into one file and a logged clean close; recovery after `SIGKILL` with the last write intact; backup unit success, off-server copy, rehearsal restore and a real restore to a separate file with identical data; `/api/ready` allowed on loopback and refused from a non-loopback address; outage and recovery alerts; failing backup alert; `systemd-analyze security` exposure 3.1 ("OK") for the web unit.

### Defects found by this rehearsal and the browser suite (all fixed, each with a regression test or a rehearsal check)

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| 1 | `preflight --artifact` still required a build-time Content-Security-Policy header after the policy moved to the proxy: **every real deployment would have been refused** | Linux rehearsal | Removed from the baked list; test now compares the preflight list with `next.config.ts` |
| 2 | After an automatic rollback, `previous` pointed at the live release, so `rollback.sh` with no argument refused | Linux rehearsal | `release.sh` restores the earlier link; case added to `test-release.sh` |
| 3 | A deliberate `systemctl stop` or restart raised a "unit failed" alert (Next.js exits 143 on SIGTERM) | Linux rehearsal | `SuccessExitStatus=143`; verified: restart+stop caused 0 alerts, SIGKILL still restarts the unit |
| 4 | Client-side PDF downloads (legacy demo and design-preview routes) were blocked by the content policy (WebAssembly compile and `data:` fetch); 7 browser specs failed | Browser suite under the enforced policy | `'wasm-unsafe-eval'` and `connect-src data:` added with reasons; specs pass |
| 5 | The backup unit's sandbox blocks a directory used as the off-server target unless it is added to `ReadWritePaths` | Linux rehearsal | Already documented in the unit; the rehearsal applies the documented drop-in |
| 6 | Redaction turned ISO dates in alert text into `[number]` | Linux rehearsal | Time stamps are preserved; test added |

## 4. Independent reviews

| Work package | Reviewer finding | Resolution |
| --- | --- | --- |
| WP6 accounts | No Critical or High; 3 Medium (parallel burst could bypass the account pause; absolute session limit applied only to application routes; enrolling did not end other sessions) | All fixed with tests and mutation checks |
| WP7 security | No Critical or High; 6 Medium (secret-scan gaps; API policy fixed at build time; firewall template could lock out admins or leave old rules; unnonced static error page; weak SQL inventory test; systemd sandbox vs backup upload) | All fixed or documented, tests added |
| WP8 monitoring | 2 High (alert command mangled by systemd's env-file parsing; start limit blocked rollback) and 10 Medium | All fixed; **re-review** of the fixes: no Critical or High remain; 4 further Medium (restart failure aborting rollback, lost RESOLVED after a level blip, delivery outlasting the unit limit, overlapping runs) fixed afterwards, **not re-reviewed** |
| WP9 | Not reviewed by a separate reviewer: the checklist, the rehearsal harness and this document were written by the same author as the work they assess | Open |

## 5. Integration of Phase 1 and Phase 2

- The main checkout (`D:\Sportozen\sportozen-academy`, branch `codex/day1-integration` at `6837e84`) still contains **only the WP1/WP2 uncommitted work**; WP3–WP6 hardening, Phase 2 WP1–5 and WP6–8 are not in it. Nothing was merged, committed or pushed.
- Applying the delivered patches **in order** to a copy of the main checkout: `wp3-wp6-full.patch` and `wp3-wp6-flake-fix.patch` apply cleanly with `patch -p1`. The earlier `phase2.patch` has 7 rejects there because those files have different line endings in the main checkout. For this reason the final deliverable includes an **integration patch cut against the main checkout's actual bytes** that was verified to reproduce the final tree byte-for-byte (`phase2-wp69-delivery/`).
- The final integrated tree is also delivered whole, with a SHA-256 manifest, so integration does not depend on patch mechanics.

## 6. Performance indication

Production build running under systemd on the test host (12 CPUs, 3.7 GB RAM; load generator on the same machine), 20 concurrent clients, 12 s per scenario, 10 accounts × 60 players: health 807 requests/s (p95 45 ms); server-rendered sign-in page 308/s (p95 85 ms); academy payload 262/s (p95 96 ms); player list 330/s (p95 75 ms); player create 77/s (p50 208 ms, p95 597 ms, max 1.2 s); sign-up 11/s (p50 1.7 s, p95 1.8 s). No 5xx, no 429 and no error log line occurred. Sign-up is the slowest operation (password hashing, a single database connection shared with Better Auth). This is a smoke-level capacity indication on unrepresentative hardware, not a capacity plan. Expected users, venues and traffic are an unresolved owner question (audit Section 21).

## 7. Open defects, risks and accepted limitations

| ID | Severity | Item | Status |
| --- | --- | --- | --- |
| R1 | **High (blocker)** | No hosting, domain/DNS, TLS certificates or deployment target exist; nothing has run on a production host | BLOCKED — external dependency |
| R2 | **High (blocker)** | No e-mail provider: verification, password recovery and invitation delivery are off; a user who forgets their password cannot recover the account | BLOCKED — external dependency |
| R3 | **High (blocker)** | No off-server backup store, no approved RPO/RTO, no key custody, no timed restore drill on the target | BLOCKED — external dependency |
| R4 | **High (blocker)** | No alert destination, no external uptime probe, no log shipping or retention, no incident roles | BLOCKED — external dependency |
| R5 | **High (blocker)** | No independent penetration test; no DDoS/edge protection | BLOCKED — external dependency |
| R6 | **High (blocker)** | No retention, deletion or consent process for children's data; no legal review | BLOCKED — external dependency |
| R7 | **High** | MFA policy not decided (`SPORTOZEN_MFA=off` by default); registration policy and e-mail verification policy undecided | Owner decision |
| R8 | High | No user acceptance has been run; no stakeholder sign-off | BLOCKED — external dependency |
| R9 | Medium | Phase 1 integration is not merged; release branch undefined | Owner decision |
| R10 | Medium | New screens (sign-in second step, account security) are outside the approved UI boards | Needs the owner's visual approval |
| R11 | Medium | `style-src 'unsafe-inline'`, `/_global-error` static page without nonce, `strict-dynamic` trust | Accepted; documented in `SECURITY_HARDENING.md` |
| R12 | Medium | One browser spec (`training.spec`) is timing-sensitive on this machine; it passed when run alone | See browser result |
| R13 | Low | Dev-only moderate advisory (minimatch) | Accepted |
| R14 | Process | A second AI agent was writing UI changes into the same working folder during this work; see `PHASE2_REPORT.md` | Reported to the owner |

## 8. Final recommendation

**NO-GO** for production release with real children's data. **GO** (recommended next steps) for: owner decisions D1–D13 (see `PHASE2A_ASSESSMENT.md` section 11), then provisioning a staging environment on the approved provider and repeating section 3 there, then executing `UAT_AND_HANDOVER.md`, then an independent penetration test and a timed restore drill. Production deployment requires the owner's explicit approval at each of those points.
