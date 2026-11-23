# Deployment: server, proxy, HTTPS and releases

Status: **prepared, not deployed.** Nothing here has been run on a real server. Everything marked OWNER DECISION is deliberately left open; do not fill it in by guessing. Pre-production verification that did run is listed in [PHASE2_REPORT.md](PHASE2_REPORT.md).

## 1. Shape of the production system

```
Internet ──443──▶ nginx (TLS, edge limits, header hygiene)
                      │  127.0.0.1:3000 only
                      ▼
               sportozen-web   (next start, Node 24)  ──┐
               sportozen-worker (optional, same host)  ─┼─▶ one SQLite file on local disk
               sportozen-backup (timer, oneshot)       ──┘      /var/lib/sportozen/workspaces.sqlite
                                                         backups ─▶ /var/backups/sportozen ─▶ off-server store
```

One Linux server. SQLite is a single-host design: the web process, the worker and the backup job all open the same local file, so they must run on the same machine, on a local disk (never a network share). A second web instance is not supported (see [DATABASE_OPERATIONS.md](DATABASE_OPERATIONS.md)).

### Requirements (proposal, not load-tested)

| Item             | Starting point                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS               | A current Ubuntu LTS or Debian stable, automatic security updates on                                                                                                                               |
| CPU / RAM / disk | 2 vCPU, 4 GB RAM, 40 GB SSD. PDF export is the CPU-heavy path (about 0.5 s of CPU each when idle). Measure before launch (see Section 9)                                                           |
| Node.js          | **24.13.0 or newer 24.x** (`.node-version`, `engines` in `package.json`). `node:sqlite` is still marked experimental by Node, so upgrade Node only after running the test suite on the new version |
| Disk             | Local, encrypted at rest (provider volume encryption), separate data volume recommended                                                                                                            |
| Network          | Inbound 80/443 (and SSH from known addresses). Outbound HTTPS for certificates, the email provider and the backup store                                                                            |
| Region           | OWNER DECISION. The academies are Indian; choose the region with the owner's legal advice on children's data                                                                                       |

## 2. Directory layout, users and permissions

| Path                            | Contents                                               | Owner / mode                      |
| ------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `/srv/sportozen/releases/<id>/` | One built release (`.next`, `node_modules`, `scripts`) | root, read-only to the service    |
| `/srv/sportozen/current`        | Symlink to the live release                            | root                              |
| `/srv/sportozen/previous`       | Symlink to the release before it (for rollback)        | root                              |
| `/etc/sportozen/sportozen.env`  | Configuration and secrets                              | root:root **0600**                |
| `/var/lib/sportozen/`           | The database and its `-wal`/`-shm` files               | `sportozen`, **0700**; files 0600 |
| `/var/backups/sportozen/`       | Local backup staging                                   | `sportozen`, **0700**             |

Create the service user without a login shell: `useradd --system --home /var/lib/sportozen --shell /usr/sbin/nologin sportozen`. The database path must be **absolute and outside the release directory**, otherwise a deployment would replace the data. `node scripts/preflight.mjs` refuses to start the service if it is not (Section 5).

The application creates the database directory with mode 0700 and the file with mode 0600; systemd units use `UMask=0077`.

## 3. Configuration and secrets

`deploy/sportozen.env.example` is the template for `/etc/sportozen/sportozen.env`. Rules:

- Never commit the filled-in file; never paste values into tickets or chat. `.env*` is already git-ignored.
- `BETTER_AUTH_SECRET`: 32 or more random characters (`openssl rand -base64 48`), generated once, kept in the owner's secret store. **Changing it signs every user out.** It is needed after a restore.
- `BETTER_AUTH_URL`: the public origin, HTTPS, no path. It must also be set **when the application is built**: Next.js bakes the response headers, including HSTS, into the build. `scripts/preflight.mjs --build` and `--artifact` check this.
- `SPORTOZEN_DATABASE_PATH`, `SPORTOZEN_TRUSTED_PROXIES`, `SPORTOZEN_CLIENT_IP_HEADER`: see Sections 4 and 6.
- Secret rotation: change the value in the env file, `systemctl restart sportozen-web`. For `BETTER_AUTH_SECRET` expect everyone to sign in again. For the backup encryption key see [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) (old backups need the old key).
- Keep an offline copy of `BETTER_AUTH_SECRET` and the backup key with the owner. The server holding the only copy is a single point of failure.

`node scripts/preflight.mjs` (or `pnpm preflight`) checks Node version, URL, secret strength, storage location and permissions, QA flags, proxy settings, email consistency and backup settings. It prints verdicts only, never a secret value, and exits 1 on any FAIL. Warnings (for example "no off-server target", "RPO not approved") do not block a start but must be cleared before real children's data.

## 4. Build and start

Build once per release, on a build machine or in CI, with the production URL:

```
export BETTER_AUTH_URL=https://<approved-domain>
# The build loads the authentication module, which refuses an HTTPS origin without
# a secret and opens a database. Give it a throw-away secret and a throw-away
# database path: the REAL secret and database are never needed (or wanted) on the
# build machine, and neither value is embedded in the output.
export BETTER_AUTH_SECRET="$(openssl rand -base64 48)"
export SPORTOZEN_DATABASE_PATH="$(mktemp -d)/build.sqlite"
node scripts/preflight.mjs --build
pnpm build
pnpm install --frozen-lockfile --prod   # in the release directory
```

The start-time check of the finished build (`scripts/preflight.mjs --artifact`) runs on the server with the real environment file; `release.sh` and the systemd unit run it for you.

- Never set a `SPORTOZEN_*_QA` variable for a production build. QA builds write to a different directory and expose demonstration routes; preflight rejects them.
- `tsx` is a runtime dependency because the background worker is a TypeScript script.
- `pnpm start` binds to 127.0.0.1 only. The proxy is the single public entry point.
- Known build warning: a "dynamic SQLite filesystem tracing" notice is documented in `docs/EXTERNAL_INTEGRATION_STATUS.md`. Run the service from the full release directory with its own `node_modules`; do not use a standalone/trimmed output until that has been tested.

Services: `deploy/systemd/sportozen-web.service` runs `ExecStartPre=node scripts/preflight.mjs --artifact`, so a misconfigured release never starts. `KillSignal=SIGTERM` with `TimeoutStopSec=30`: on shutdown the process marks itself "draining" (`/api/ready` answers 503), then folds the SQLite write-ahead log into the database file on exit. A hard kill is also safe: SQLite recovers committed data from the log (tested, `tests/unit/database-persistence.test.ts`).

Endpoints for supervisors and monitors (no authentication, no data):

| Path          | Meaning                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health` | The process is serving requests. Touches nothing else                                                                                    |
| `/api/ready`  | The database opens, the schema is present, the service is not shutting down. Reachable from the server itself only (the proxy blocks it) |

Start order: web first, worker after it (the worker unit does this). The first process to open an older database applies the additive migrations; running two first-time starters at once is safe (tested) but one is cleaner.

## 5. Releases and rollback

```
# On the server, as root, with the new build unpacked into /srv/sportozen/releases/<id>:
deploy/release.sh /srv/sportozen/releases/<id>
```

`release.sh`: (1) runs the preflight against the new release and the env file; (2) takes a **pre-deploy database backup** (verified by restoring it, see the backup guide) and aborts if that fails; (3) switches the `current` symlink atomically; (4) restarts the web service, and the worker if it is enabled; (5) waits up to 60 s for `/api/ready`; **if it does not become ready it switches back and restarts the previous release automatically**; (6) prunes old releases (only ones older than the live one; always keeps the previous one).

`deploy/rollback.sh [release-dir]` switches code back to the previous (or a named) release without touching data.

What rollback does **not** do: migrations are additive and are not reverted. The previous release runs against the newer schema because new tables and columns are unused by it. If a release damaged data, restore from the pre-deploy backup ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)); do not delete the database as a troubleshooting step.

Recovery from a failed rollback: `journalctl -u sportozen-web -n 200` (logs contain no tokens, links, passwords or message text), fix the cause or select a known-good release with `rollback.sh <dir>`, and see the restore procedure for data problems.

## 6. Domain, DNS and HTTPS (OWNER DECISION: domain and DNS ownership)

Prepare, do not buy or change anything yet. When the owner approves a domain:

1. DNS `A` (and `AAAA` if the server has IPv6) record for the application host name pointing at the server. Keep TTL low (300 s) during launch.
2. Optional `CAA` record restricting certificate issuance to the chosen CA (for example `0 issue "letsencrypt.org"`).
3. Email records (SPF, DKIM, DMARC) belong to the email provider and are listed in [EMAIL.md](EMAIL.md). Use a sending subdomain so that email problems cannot affect the application host.
4. Certificate: Let's Encrypt via `certbot certonly --webroot -w /var/www/certbot -d <domain>` (the supplied nginx server answers `/.well-known/acme-challenge/`), with the packaged systemd timer renewing it. Reload nginx after renewal (`--deploy-hook "systemctl reload nginx"`). Alert on certificates expiring within 14 days (see monitoring work in Phase 2 WP6). Caddy is an alternative that handles certificates itself (`deploy/caddy/Caddyfile.template`) but has no built-in rate limiting.
5. HSTS is sent by the application when built for an HTTPS origin (`max-age=31536000`). It is deliberately **not** `includeSubDomains` or `preload`; changing that is hard to undo and is an owner decision.

## 7. Reverse proxy and forwarded headers

`deploy/nginx/sportozen.conf.template` and `sportozen-proxy.conf` (render with the real domain: `sed 's/__DOMAIN__/<domain>/g'`). Verified against a real nginx in Docker by `deploy/tests/test-proxy.sh` (16 checks):

- The application listens on loopback only; unknown host names (including bare IP requests) are dropped.
- HTTP redirects to HTTPS; the ACME challenge path is served for certificates.
- `X-Forwarded-For` and `X-Real-IP` are **overwritten** with the TCP peer address and `Forwarded` is stripped. A client-supplied value never reaches the application. This is what makes Better Auth's per-address sign-in limiter trustworthy: it accepts a single-valued `X-Forwarded-For` (tested in `tests/unit/proxy-trust.test.ts`). If the proxy instead appended to the header, a client could rotate fake addresses and defeat the limiter, which is why the configuration must not be changed to `$proxy_add_x_forwarded_for`.
- If a CDN or second proxy sits in front of nginx and appends, list its address ranges in `SPORTOZEN_TRUSTED_PROXIES`; Better Auth then takes the first untrusted address from the right. If the front proxy sets its own header (for example `CF-Connecting-IP`) and the origin accepts connections only from it, set `SPORTOZEN_CLIENT_IP_HEADER`. Invalid values stop the application at start.
- Edge request limits: 20/min per address with burst for `/api/auth/` (sign-in, sign-up, reset), 120/min for the WhatsApp webhook, 600/min elsewhere; 2 MB request cap (the application caps JSON at 1 MB); 40 concurrent connections per address. These are starting values to tune against real traffic.
- `/api/ready` answers 403 from outside the server; `/api/health` is public (for an external uptime monitor).
- The application's own mutation check requires the browser `Origin` header to equal `BETTER_AUTH_URL` exactly, independently of the `Host` header, so a proxy that rewrites `Host` cannot weaken it.

`nginx -t` and the header tests ran against `nginx:stable` (Docker) with a throw-away certificate. Not yet verified: a real certificate issuance, OCSP stapling and behaviour on the real server.

## 8. First-time provisioning checklist (when the owner has approved the provider, region and domain)

1. Create the server; enable volume encryption, automatic updates, firewall (80, 443, SSH).
2. Install Node 24.13+ (from the vendor repository, not an unpinned snapshot), nginx, certbot.
3. Create the user, directories and modes in Section 2.
4. Create `/etc/sportozen/sportozen.env` (0600) from the template. Generate and store the two secrets.
5. Create DNS records; obtain the certificate; install the nginx files; `nginx -t && systemctl reload nginx`.
6. Unpack the first release; run `deploy/release.sh`.
7. Install the backup service and timer; run one backup by hand; run a restore rehearsal ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).
8. Choose how new academies are approved. By default a new academy is approved when it is created (no review step). To require a platform review instead, set `SPORTOZEN_ACADEMY_APPROVAL=required` in the server's environment and create the first platform administrator explicitly: `node scripts/platform-admin.mjs <registered-account-email>` (no default administrator exists); see `docs/ACADEMY_APPROVAL.md`, rule 6. A platform administrator is still needed to suspend an academy.
9. Verify from outside: `curl -sI https://<domain>/` shows HSTS, CSP, `nosniff`, `frame-ancestors`; HTTP redirects; `https://<domain>/api/ready` is 403; `/api/health` is 200.
10. Do **not** admit real children's records until the remaining production blockers in [PHASE2_REPORT.md](PHASE2_REPORT.md) are closed.

## 9. Load and capacity (not yet done)

The sizing above is a starting point. Before launch, measure on the real server: concurrent parents and staff, PDF exports in parallel, backup running during traffic, and the rate of `503` busy responses (SQLite write contention). The measured figures from the development machine are in `docs/WP3_WP6_REPORT.md` and `docs/WP2_*` and are not a substitute.

## Monitoring, alerts and runbooks (WP8)

Installing the operational check, the weekly deep check and the failure alert units, choosing an alert destination, the list of what alerts, and the diagnose-and-respond runbooks (application unavailable, database locked, backup failure, failed migration, authentication abuse, unexpected errors, failed deployment and rollback) are in [OPERATIONS.md](OPERATIONS.md). Every release and rollback also appends a JSON line to `/srv/sportozen/deployments.log`; nginx forwards a per-request id (`X-Request-ID`) and logs it with timings; host firewall, SSH and fail2ban templates are in `deploy/host/` ([SECURITY_HARDENING.md](SECURITY_HARDENING.md)).
