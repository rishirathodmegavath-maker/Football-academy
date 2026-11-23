# Monitoring, logging and operations (WP8)

Status: **implemented and tested locally; nothing is deployed, no alert destination exists, and no external monitoring or log service has been chosen.** Everything here is provider-neutral: logs are JSON lines on the standard streams, checks are scripts, alerts leave through a command or an https webhook that the owner chooses (Section 6). Deployment is in [DEPLOYMENT.md](DEPLOYMENT.md), backups in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md), accounts in [AUTHENTICATION.md](AUTHENTICATION.md), security in [SECURITY_HARDENING.md](SECURITY_HARDENING.md).

## 1. What exists

| Signal | Where it comes from | How you read it |
| --- | --- | --- |
| Liveness | `GET /api/health` → `{"status":"ok"}`; touches nothing else, so a database problem never restarts a healthy process | `curl -s http://127.0.0.1:3000/api/health` |
| Readiness | `GET /api/ready` → 200 or 503 with `{ready, checks:{database,schema,service}}`; reachable from the server only (nginx returns 403 outside); goes 503 while shutting down | `curl -s http://127.0.0.1:3000/api/ready` |
| Structured logs | `src/server/log.ts`: one JSON object per line (`ts`, `level`, `event`, fields); strings are redacted, objects are dropped, the envelope cannot be overridden | `journalctl -u sportozen-web -o cat \| jq -c .` |
| Request correlation | The proxy gives every request an id (nginx's `$request_id`), forwards it, and returns it as `X-Request-Id`; error and security lines carry `requestId`; nginx's access log has `rid=` | `grep rid=<id> /var/log/nginx/access.log`; `journalctl -u sportozen-web -o cat \| jq -c 'select(.requestId=="<id>")'` |
| Error visibility | A failed request logs `request.failed` (reference, requestId, route, error name, redacted message, short stack); the caller sees only `X-Error-Reference`. A crash logs `process.crashed`. The reporter interface is the log (Section 5) | `jq -c 'select(.level=="error")'` |
| Security events | `event":"security"` lines with `type`: `signin.failed`, `signin.locked`, `mfa.*`, `password.changed`, `session.others_revoked`, `access.denied`, `ratelimit.blocked`, `access.mfa_required`, `csp.violation` (allow-listed fields only) | `jq -c 'select(.event=="security")'` |
| Startup diagnostics | `app.started` (release directory, Node version, pid, CSP/MFA/e-mail/session settings as enumerations, `ready`); `app.configuration_invalid`, `app.database_unavailable` on trouble; `app.stopping`, `app.stopped` on shutdown | `jq -c 'select(.event\|startswith("app."))'` |
| Operational checks | `scripts/ops-check.mjs` every minute (and weekly `--deep`): application, database (readable, write lock, log size, integrity), disk, backup age, worker heartbeat, e-mail outbox, paused accounts, latest deployment, certificate expiry | `node scripts/ops-check.mjs` |
| Deployment history | `deploy/release.sh` and `rollback.sh` append JSON lines to `/srv/sportozen/deployments.log` (`deploy.aborted` when preflight or the pre-deploy backup refuses, `deploy.started`, `deploy.succeeded`, `deploy.not_ready`, `deploy.rolled_back`, `deploy.failed`, `rollback.*`). `release` is the release that is live (or meant to be) after the event and `previous` the one it replaced. A failure to write the log is silent (a deployment is never blocked by it) and shows as "no deployment log yet" | `tail -n 20 /srv/sportozen/deployments.log` |
| Backup status | `scripts/backup-status.mjs` (exit 0 within RPO, 1 stale or not off-server, 3 RPO unset) and the `sportozen-backup` unit's exit status | `node scripts/backup-status.mjs` |
| Unit failures | `OnFailure=sportozen-alert@%n.service` on the web, worker and backup units | an alert naming the unit |

Not logged by the application, by design: passwords, tokens, one-time codes, e-mail addresses, telephone numbers, request or response bodies, child or guardian names, link URLs. The nginx access log records the method and **path only** (no query string, which carries one-time tokens in reset, verification and invitation links; no referrer). Quoted text is removed from logged error messages because libraries quote the data they choke on. Evidence: `tests/unit/log-hygiene.test.ts` runs sign-up, failed and blocked sign-ins, password change and reset, an error path (including a library error that quotes a child's name and a telephone number) and startup with planted sensitive values and checks that none appears in any console stream, while the operator-relevant events do; Better Auth's own messages now go through the same logger. **Not covered:** Better Auth prints a few fixed one-line API-error messages in its own format (no request data), Next.js prints its own unhandled-error output, and Node prints an uncaught-exception trace; none of these are redacted by this code, and the tests ran in development mode, not with production log levels. Review the first production logs for anything unexpected.

## 2. Installing the monitoring (after the owner chooses a destination)

1. Install the units: `sportozen-ops-check.{service,timer}`, `sportozen-ops-deep.{service,timer}`, `sportozen-alert@.service` into `/etc/systemd/system/`; `systemctl daemon-reload`.
2. In `/etc/sportozen/sportozen.env` set `SPORTOZEN_ALERT_COMMAND` and/or `SPORTOZEN_ALERT_WEBHOOK_URL` in the environment file (Section 6; **put the command's JSON inside single quotes**), `SPORTOZEN_SERVER_NAME`, and optionally `SPORTOZEN_OPS_CERT_HOST` (the public name) and `SPORTOZEN_OPS_EXPECT_WORKER` (`auto` by default: the heartbeat is checked once the worker has run; `true` makes a missing heartbeat critical; `false` never checks). `node scripts/preflight.mjs` reports a missing or malformed alert destination as a warning (it never blocks the web service from starting).
3. `systemctl enable --now sportozen-ops-check.timer sportozen-ops-deep.timer`.
4. Run `node --env-file=/etc/sportozen/sportozen.env scripts/ops-check.mjs --test-alert`: it sends one TEST message to every destination and says which accepted it (exit 4 if any did not, 3 if none or the configuration is wrong). Then **test each alert once on purpose** (Section 7) before relying on it.
5. Ship the journal and nginx logs off the server with whatever tool the owner approves, and set retention (proposal: 90 days operational, 12 months security and audit; the owner and legal advice decide). Nothing in this package ships logs.

## 3. What alerts, and what deliberately does not

| Check | Warning | Critical |
| --- | --- | --- |
| `app` | – | `/api/ready` not answering, or not 200/ready |
| `database` | – | file missing or unreadable |
| `database-lock` | a writer waited ≥ 300 ms | no write lock within 1 s (database locked or unavailable) |
| `database-wal` | log ≥ 64 MB | ≥ 512 MB (checkpoints not completing) |
| `database-integrity` (weekly run, remembered by the every-minute run) | the weekly check has not run for 8 days | `quick_check` or `foreign_key_check` found problems |
| `disk-data`, `disk-backup` | < 20 % space or inodes free | < 10 % |
| `backup` | RPO not configured | no backup, stale beyond RPO, or not copied off-server |
| `worker` | – | no heartbeat for 180 s (once the worker has run, or if `SPORTOZEN_OPS_EXPECT_WORKER=true`); skipped if it never ran |
| `email-outbox` (only if e-mail is on) | messages waiting > 30 min, or failed in the last 24 h | – |
| `auth-abuse` | ≥ 3 accounts paused by repeated failed sign-ins in the current 15-minute window | – |
| `deployment` | a release was refused, not ready or rolled back in the last 24 h, or a deployment or rollback started and never finished; or the latest deployment failed but the service is ready now | the latest deployment failed or a rollback is not ready **and** the application is not ready |
| `certificate` | < 21 days | < 7 days, or the TLS check fails |

Alerting rules (`decideAlerts`, tested): a problem must be seen on **two consecutive passes** before anyone is told (so a restart that overlaps a pass, or a value that flaps around a threshold, tells nobody; detection time is therefore about two to three minutes); then one alert, another if it gets worse, a reminder after an hour (critical) or a day (warning) while it persists, and one RESOLVED when something that was reported clears. A problem that cleared before it was reported produces nothing. Delivery is per alert: an alert counts as delivered when **any** destination accepted it (a broken second destination shows as exit status 4 of the unit, not as repeated messages); an alert nobody accepted is retried on the next pass; at most three alerts are sent per pass, the state is saved after each one, and only one run at a time handles alerts, so a run that is stopped part-way never repeats what it already sent. **Time limits (independent review fixes):** the alert command has a hard 20-second limit (`SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS`, 1-20, can only shorten it) and a webhook 8 seconds; at the limit the command **and everything it started** is killed with SIGKILL (it does not matter whether it ignores SIGTERM), the alert counts as undelivered and is retried on the next pass, and the other alerts in the same pass are still sent. No new alert is started after 45 seconds into delivery, so a run ends well inside the unit's `TimeoutStartSec=120` (about 97 seconds at worst). **The lock** (`alerts.lock` in the state directory) names its owner (process id and a random token): a run releases only its own lock, a lock whose process no longer exists is taken over at once (a crash never silences alerting), a lock older than five minutes is taken over (a hung holder), and a run that finds its lock gone stops sending and does not write the state. SIGTERM or SIGINT (systemd stopping the unit) kills any alert command still running, releases the lock and ends the run with status 143 (the units list 143 as a success status). **Normal behaviour never alerts:** ordinary 401/403/404/422 answers, a single failed sign-in, a rate-limit 429, a single CSP report, a restart that comes back ready. Messages carry the check name, a short detail (redacted), the server name, the time and a pointer into this document.

Not covered, and said plainly: an outside probe (if the whole server or its network is down, nothing on it can tell you; use an external uptime check that calls the public `/api/health`, owner decision D11); browser-side JavaScript errors (no collector, to avoid a new unauthenticated endpoint and personal-data questions); metrics and dashboards (latency, 5xx rate; the access log has `rt=` and `urt=` per request for a log tool to aggregate); log-based alerts on arbitrary patterns.

## 4. Diagnosing and responding

First, in every case: `node scripts/ops-check.mjs` (run as the `sportozen` user, from `/srv/sportozen/current`, with the environment file loaded: `sudo -u sportozen node --env-file=/etc/sportozen/sportozen.env scripts/ops-check.mjs`).

### Application unavailable
Alert: `app`, or `unit sportozen-web.service failed`.
1. `systemctl status sportozen-web`, then `journalctl -u sportozen-web -n 200 -o cat | jq -c 'select(.level!="info")'`. Look for `app.configuration_invalid`, `app.database_unavailable`, `process.crashed`.
2. `curl -si http://127.0.0.1:3000/api/ready`. 503 with `schema=failed` means the database is not the expected one (wrong file, or a migration did not complete): go to *Failed migration*. 503 with `service=draining` means it is shutting down.
3. If the unit says `start-limit-hit` (`systemctl status` shows it failed after repeated starts), a plain restart is refused: run `systemctl reset-failed sportozen-web` first (`deploy/release.sh` and `rollback.sh` do this for you).
4. If the application is fine on loopback but the site is down: `systemctl status nginx`, `nginx -t`, `journalctl -u nginx`, certificate expiry (`ops-check` `certificate`), DNS, the provider's network status.
5. A crash loop stops after five failures in five minutes (the unit enters *failed* and alerts). Do not restart repeatedly: read the first error. If a release caused it: `deploy/rollback.sh`.
6. Record the time, cause and fix (Section 8).

### Database unavailable or locked
Alert: `database`, `database-lock`, `database-wal`.
1. `database-lock` critical: something holds the write lock. `fuser /var/lib/sportozen/workspaces.sqlite*` and `ps` for long-running processes (a manual script, a backup, the integrity checker opened read-write). The application answers 503 with `Retry-After: 1` meanwhile, and logs `db.refused`.
2. The usual cause is a manual script left open or a stuck deployment step. End the stray process; the lock clears. Do **not** delete the `-wal` or `-shm` files: committed data may still be in the log.
3. `database` critical, file unreadable: stop writes (`systemctl stop sportozen-web sportozen-worker`), check disk (`df -h`, `dmesg`), keep the damaged files, then follow the cut-over in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) section 5. Never overwrite the damaged database.
4. `database-wal` large: a long reader prevents checkpoints. Find and end the long reader; a clean restart of the web service checkpoints the log.
5. `database-integrity` critical (weekly check): copy the database (`VACUUM INTO` via the backup tool), run `node --conditions=react-server --import tsx scripts/check-data-integrity.ts <copy>`, and treat it as a data-loss incident until understood. Restore rehearsal from the latest backup ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).

### Backup failure
Alert: `backup`, or `unit sportozen-backup.service failed`.
1. `journalctl -u sportozen-backup -n 100 -o cat` and `node scripts/backup-status.mjs`. Exit 2 of the unit means the backup is stored here but not copied off the server.
2. Typical causes: the off-server credential expired or was revoked; the target is full; a sandbox path is not writable (see the comment in `sportozen-backup.service`); the encryption key is missing from the environment file; disk full on the staging directory.
3. Fix, then run it by hand: `systemctl start sportozen-backup` and confirm `backup-status` is back within RPO. A backup that cannot be restored is never stored, so a failure never silently replaces a good backup.
4. If the RPO has already been missed, tell the owner exactly what period has no off-server copy.

### Failed migration
Signal: `/api/ready` 503 `schema=failed` or `database=failed` after a deployment; `app.database_unavailable` / `migration.*` lines; `deploy.not_ready` then `deploy.rolled_back` in the deployment log.
1. `release.sh` has already rolled back automatically if the new release never became ready. Confirm with `ops-check` (`deployment`) and `readlink /srv/sportozen/current`.
2. Migrations are additive and run under a write lock; they are not reverted by a rollback, and the pre-deploy backup is not restored automatically. The old release works with the new tables.
3. Read the first error in `journalctl -u sportozen-web` of the failed start. An integrity-guard line (`migration.guard_not_installed`) is a warning about existing data, not a failure: run `scripts/check-data-integrity.ts` on a copy and correct the rows ([DATABASE_OPERATIONS.md](DATABASE_OPERATIONS.md)).
4. Fix forward in a new release; do not edit the live database by hand. Restore from the pre-deploy backup only if data was damaged, using a separate copy first.

### Authentication abuse
Alert: `auth-abuse` (several accounts paused at once), or a spike of `signin.failed` / `signin.locked` / `ratelimit.blocked`.
1. Size it: `journalctl -u sportozen-web -o cat --since "1 hour ago" | jq -c 'select(.event=="security")' | jq -r .type | sort | uniq -c`. Repeated `accountRef` values show one targeted account; many different ones show a spray.
2. At the edge: `awk` the nginx access log for the sources (`grep '/api/auth/' access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head`) and block them (`nft add rule inet sportozen input ip saddr <ip> drop`); the fail2ban jail does this automatically for persistent sources if installed.
3. The accounts are paused for the rest of a 15-minute window and recover by themselves; password reset by e-mail is not blocked. If a real person is locked out, they wait or reset; there is no manual unlock in the product (an operator can delete the `signin-failure:%` rows in `request_rate_limits`).
4. If any targeted account is staff or an owner, contact them: they should have two-step verification on. If a compromise is suspected, have them change the password (that ends every other session). Do **not** use `reset-mfa.mjs` for this: it removes the second step, and is only for a person who lost both the authenticator and the recovery codes.
5. If the attack is volumetric rather than guessing, nothing here stops it: engage the provider's network protection (owner decision D10).

### Unexpected application errors
Signal: `request.failed` lines; a user quotes a reference or an `X-Request-Id`.
1. `journalctl -u sportozen-web -o cat | jq -c 'select(.reference=="<ref>" or .requestId=="<id>")'`, and the nginx line for the same id (`grep rid=<id>`).
2. The line gives route, error name, redacted message and a short stack. Reproduce on a copy of the data, never on the live database.
3. A burst after a deployment: compare `deploy.succeeded` time in `/srv/sportozen/deployments.log`; roll back if needed (`deploy/rollback.sh`).
4. A `db.refused` warning means the database answered busy or a uniqueness rule fired; repeated ones point to contention or a bug that sends duplicates.

### Failed deployment and rollback
Signal: `deploy.not_ready`, `deploy.rolled_back`, `deploy.failed`, `rollback.not_ready` (alert `deployment`).
1. `tail /srv/sportozen/deployments.log`; the release script's own output is in the terminal or CI log that ran it.
2. `deploy.rolled_back`: the previous release is live again and healthy. The new release failed readiness; find out why on a staging copy before retrying.
3. `deploy.failed` / `rollback.not_ready`: **neither release is ready.** Follow the Recovery section of [DEPLOYMENT.md](DEPLOYMENT.md): check configuration (preflight), the database file and the logs of the first failing start. Keep every release directory until resolved.
4. A rollback changes code only. If data was damaged, restore from a verified backup instead ([BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)).

### Disk space
`df -h /var/lib/sportozen /var/backups/sportozen`; the staging directory is pruned by the backup retention; old releases are pruned by the release script; the journal by `journalctl --vacuum-time=30d` (after shipping). Never delete database files.

### Background worker
`worker` critical: `systemctl status sportozen-worker`, `journalctl -u sportozen-worker -o cat`. It writes `/var/lib/sportozen/worker-heartbeat` each pass (every 10 s); `worker.tick_failed` lines name the failing job. Queued e-mail and jobs are retained and retried when it returns.

### Delivery-history retention
Once a day (and once when the worker starts) the worker runs the 12-month delivery-history cleanup according to `SPORTOZEN_RETENTION` (`report`, the default, only counts and records a `REPORT` run; `on` removes; `off` skips). A `worker.tick_failed` line with `job=delivery-retention` means that run removed nothing. Each run, including dry runs, is a row in `delivery_retention_runs` (status `COMPLETED`, `CAPPED` when it stopped at its per-run limit, `FAILED` with a sanitised message, or `SKIPPED` when another run held the lease). To look first: `pnpm retention:run` (dry run) against the real database or a copy. Rules, boundaries and what is never removed: `docs/DELIVERY_RETENTION.md`. This job is not part of the monitoring checks and `scripts/ops-check.mjs` does not read it.

### Academy approval queue
Only when the server runs with `SPORTOZEN_ACADEMY_APPROVAL=required` (the default is that new academies are approved when created) do new academies wait for a platform administrator: the queue is `/platform` (and `GET /api/platform/applications`). The monitoring does not alert on a long queue; someone has to look. A platform administrator is assigned by an operator with `node scripts/platform-admin.mjs <registered-account-email>`. See `docs/ACADEMY_APPROVAL.md`.

### Email delivery
`email-outbox` warning: failed rows are `status='FAILED'` in `email_outbox` (read the `lastError`, which is redacted and carries no address). Invitations can still be shared by hand. Provider outages, bounces and suppression lists are handled in the provider's console once one is chosen.

### Certificate expiry
`certificate` warning/critical: `certbot certificates`, `certbot renew --dry-run`, check port 80 reachability and the renewal timer.

## 5. Error reporting interface

Errors are reported through the structured log: `request.failed`, `process.crashed`, `worker.tick_failed`, `email.outbox_run_failed`, `app.configuration_invalid`, `app.database_unavailable`. When the owner approves an error-tracking service, add a sink that receives `errorFields(error)` and the `requestId` at the single place requests fail (`apiError` in `src/server/http.ts`) and at `process.crashed` (`src/instrumentation.ts`); do not send request bodies or user identifiers beyond the opaque ids already in the line.

## 6. Alert destinations (owner decision D11)

Set either or both in the environment file; nothing is sent otherwise.

- `SPORTOZEN_ALERT_COMMAND` — a JSON array, **in single quotes in the environment file** (`SPORTOZEN_ALERT_COMMAND='["/usr/local/bin/notify","{severity}","{subject}"]'`), run without a shell; `{subject}`, `{body}`, `{severity}` are replaced inside each element. Example: `["/usr/local/bin/notify","{severity}","{subject}"]` where the script sends e-mail, SMS or a chat message. Alert text can never be interpreted as a command (tested with shell metacharacters).
- `SPORTOZEN_ALERT_WEBHOOK_URL` — an `https://` address (a loopback address is allowed for tests) that accepts a JSON POST `{severity, subject, text, server}`; most chat tools, paging services and "dead man's switch" services can receive this.

If no destination accepts an alert it is retried on the next pass; if one accepts it the alert counts as delivered and the failing one shows as exit status 4 of `sportozen-ops-check.service` (look at `journalctl -u sportozen-ops-check`). The destination must be somewhere that survives this server being down, which means it must not be a mailbox on this server. **Nothing on this server can tell you that monitoring itself has stopped**, for example if the check's own configuration is wrong (it exits 3 and logs the reason) or the timer is disabled: an external check that expects a regular message, or an uptime probe on the public name, is the only protection (owner decision D11).

## 7. Verifying the monitoring (do once, record the result)

| Test | How | Expected |
| --- | --- | --- |
| Outage alert | stop the web service, wait three minutes | `CRITICAL app` alert, then `RESOLVED` after starting it |
| Database lock | on **staging only**, open the database in a second process and run `BEGIN IMMEDIATE` without committing, wait three minutes | `CRITICAL database-lock`, then `RESOLVED` after rolling back |
| Backup alert | point `SPORTOZEN_BACKUP_TARGET_COMMAND` at a failing command on staging, run the unit | `unit sportozen-backup.service failed` |
| Failed deployment | deploy a deliberately broken release on staging | `deploy.not_ready`, automatic rollback, `WARNING deployment` |
| Disk | fill a scratch filesystem on staging | `WARNING`/`CRITICAL disk-data` |
| Certificate | point `SPORTOZEN_OPS_CERT_HOST` at a test name with a near-expiry certificate | `WARNING certificate` |
| Log hygiene | `journalctl -u sportozen-web -o cat \| grep -E '@|password'` after a sign-up and sign-in | no addresses or passwords |

The automated tests (`tests/unit/ops.test.ts`, `log-hygiene.test.ts`, `health-and-shutdown.test.ts`, `deploy/tests/test-release.sh`) prove the logic and the interfaces locally; **none of the table above has been run on a real server.**

## 8. Incident response

**Severity.** *Critical*: data of children or guardians may have been exposed, altered or lost; the service is down for everyone; a backup/restore is needed. *High*: a role boundary or authentication control failed; a staff account was compromised; the service is degraded for many. *Medium*: a feature is broken for some users; a warning alert persists. *Low*: cosmetic or single-user.

**Roles (names to be assigned by the owner).** Incident lead (decides and communicates), technical responder (diagnoses and fixes), owner/contact (customer communication and legal decisions), and a recorder (timeline). One person may hold several roles in a small team; the lead must not be the only responder on a Critical incident.

**Steps.** (1) Acknowledge and open a timeline (time, who, what was seen). (2) Contain: stop the damage first (block sources, end sessions, take the service down if data is at risk) and **preserve evidence** before cleaning: copy the logs (`journalctl -u sportozen-* --since ... > file`), the nginx logs and the deployment log, and keep damaged database files untouched. (3) Diagnose with the runbooks above. (4) Fix or roll back; verify with `ops-check` and a real sign-in. (5) Communicate: affected academies, plainly, with what happened, what data, what was done, what to do. (6) Review within a week: cause, detection time, what would have caught it earlier, actions with owners.

**Personal-data breach decision path (needs legal input before first use).** If the audit trail or logs show that guardian or child data may have been read or changed by someone not entitled to it: preserve evidence; establish what and whose; the owner decides, with legal advice, whether and when regulators and the people concerned must be told (the applicable law and deadlines depend on where the academies and children are; India's DPDP Act is likely relevant). The security-event log, `workspace_audit` (append-only) and the request ids are the evidence base. **The notification contacts, the legal owner and the timeline are open owner decisions.**

**Communication templates** and the incident register are the owner's to approve; a minimal register is a table of date, severity, summary, cause, actions, owner.

## 9. Open decisions and limits

1. Who is alerted, how, and 24/7 or working hours (D11); the detection-time objective the one-minute timer implies.
2. Log shipping, retention and a log search tool; off-server copies of the deployment log.
3. An external uptime probe and an error-tracking service (names, regions, data processing agreements).
4. Incident roles, contacts, the breach decision path and notification templates (legal).
5. Nothing here has been run on a real server. The unit files were checked with `systemd-analyze verify` and given an offline exposure score; systemd 259 (in the WSL test distribution) was seen to keep the JSON of an unquoted `SPORTOZEN_ALERT_COMMAND` intact, but older systemd versions may strip the double quotes, which is why single quotes are required.
