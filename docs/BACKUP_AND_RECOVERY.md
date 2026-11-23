# Backup and disaster recovery

Status: **tooling implemented and tested; not scheduled anywhere, no off-server store chosen, recovery objectives not approved.** Do not describe the system as backed up until the "Before relying on backups" list at the end is complete.

## 1. What a backup is

One run of `node scripts/backup-database.mjs` (systemd: `sportozen-backup.service`):

1. Takes a **consistent snapshot** of the live database with `VACUUM INTO` on a read-only connection. It reads one snapshot inside a single read transaction, completes however busy the application is (SQLite's incremental backup API restarts whenever another connection writes), and does not block writers (WAL).
2. Runs `PRAGMA integrity_check` on the snapshot and records the schema version, foreign-key violations and the row count of every table.
3. Compresses (gzip) and **encrypts** (AES-256-GCM, authenticated) it. Backups of children's data are refused unencrypted unless `SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED=1`, a test-only switch.
4. **Restores it again** into a scratch file and checks that the hash matches, the database opens, `integrity_check` passes, the schema version and **every table's row count** equal what was recorded. A backup that cannot be restored is never stored.
5. Stores artifact and manifest in the local staging directory (outside the application and database directories), manifest last.
6. Copies both to the off-server target and verifies the copy (directory targets are compared by hash; command targets by exit status).
7. Applies the retention policy, then records the result in `status.json`.

The manifest holds names, sizes, hashes, timestamps, schema version, table row counts and a short key fingerprint. It holds no record contents and no key.

Exit codes: `0` stored and uploaded (or stored with a warning when no target is configured); `1` failed, nothing stored; `2` stored on this server but **not** copied off it (alert on this).

## 2. Configuration (environment file; see `deploy/sportozen.env.example`)

| Variable                                           | Meaning                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SPORTOZEN_BACKUP_DIR`                             | Local staging directory. Absolute, outside the application and database directories                                                                                                                                                                                      |
| `SPORTOZEN_BACKUP_TARGET_DIR`                      | Off-server store that is mounted as a directory (a mounted object store, an NFS or SFTP mount). Separate from every local directory                                                                                                                                      |
| `SPORTOZEN_BACKUP_TARGET_COMMAND`                  | Alternative: a JSON array run **without a shell**, with `{file}` and `{name}` replaced, e.g. `["rclone","copyto","{file}","remote:bucket/{name}"]`. Run once for the artifact and once for the manifest. Its output is truncated and has secrets redacted before logging |
| `SPORTOZEN_BACKUP_ENCRYPTION_KEY`                  | 32 random bytes, base64 (`openssl rand -base64 32`)                                                                                                                                                                                                                      |
| `SPORTOZEN_BACKUP_KEEP_HOURLY / _DAILY / _MONTHLY` | Retention counts (defaults 24 / 30 / 12)                                                                                                                                                                                                                                 |
| `SPORTOZEN_BACKUP_RPO_MINUTES / _RTO_MINUTES`      | Recovery objectives. Empty until approved                                                                                                                                                                                                                                |

Only one of the two target settings may be set. The tool supports any store reachable as a mounted directory or by a command-line client, so the choice of storage provider is the owner's and no provider-specific code was written.

**The encryption key is the backup.** Keep a copy outside this server (the owner's password manager or vault). A backup without its key cannot be read; a key stored only on the server is lost with the server. Rotating the key does not re-encrypt old backups: keep every key that is still needed for a retained backup (the manifest's `keyFingerprint` says which).

## 3. Schedule (OWNER DECISION: recovery point objective)

`deploy/systemd/sportozen-backup.timer` is **proposed**, not approved: hourly with up to five minutes of random delay, run on boot if missed. The interval is the RPO: the most recent changes that can be lost.

| Option            | Mechanism                                        | Worst-case loss  | Notes                                                                    |
| ----------------- | ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------ |
| 24 hours          | `OnCalendar=daily`                               | a day            | Cheapest; weak for fee and attendance records                            |
| 1 hour (proposed) | `OnCalendar=hourly`                              | about an hour    | Fits the current design; storage grows by a small file per hour (pruned) |
| 15 minutes        | `OnCalendar=*:0/15`                              | about 15 minutes | Same tooling; more files                                                 |
| Under 1 minute    | continuous log shipping (for example Litestream) | seconds          | Not built; extra component and cost; decide only if the owner needs it   |

Set `SPORTOZEN_BACKUP_RPO_MINUTES` once the owner approves; `node scripts/backup-status.mjs` (exit 0 within the RPO, 1 stale/missing/not off-server, 3 no RPO set) is the check for monitoring.

## 4. Retention

Default: keep the newest 24 backups, the newest of each of the latest 30 days, the newest of each of the latest 12 months, anything that is not a scheduled backup (for example `pre-deploy`) for 14 days, and **always the newest**. Pruning runs only after a backup was stored and verified, deletes manifest first then artifact, only touches files whose names match the backup pattern, and never other files. A directory target is pruned the same way. A command target cannot be pruned by the tool: use the store's lifecycle rules. The numbers are an OWNER DECISION and must also satisfy any legal retention duty for financial records (and any duty to delete personal data; backups delaying deletion should be addressed in the retention policy).

## 5. Restoring

A restore never writes over the live database. Restore creates a **new file**, only after every check passes; switching to it is a separate manual step.

```
# 1. Verify and time a restore without writing anything permanent (safe at any time):
node scripts/restore-database.mjs --backup /path/to/sportozen-<stamp>-<label>.sqlite.gz.enc --rehearse
# 2. Restore to a new path:
node scripts/restore-database.mjs --backup <file> --target /var/lib/sportozen/restored-<date>.sqlite
```

The key comes from `SPORTOZEN_BACKUP_ENCRYPTION_KEY` or `--key-file` (never the command line). The command refuses an existing target, a relative path and the live database path, and reports every problem it finds (hash mismatch, wrong key, tampering, truncation, integrity failure, schema version or row-count mismatch). A damaged backup produces no output file.

### Cut-over (disaster recovery)

1. Decide the cause and the restore point (the newest verified backup, or an earlier one if the latest contains the damage). The pre-deploy backup is labelled `pre-deploy`.
2. `systemctl stop sportozen-worker sportozen-web`. **Keep the damaged files**: move `workspaces.sqlite`, `-wal` and `-shm` to `/var/lib/sportozen/damaged-<date>/` (do not delete).
3. Restore to a new path (above), then run the integrity checker on it: `node --conditions=react-server --import tsx scripts/check-data-integrity.ts <restored file>`.
4. Move the restored file to `workspaces.sqlite` (mode 0600, owner `sportozen`).
5. `systemctl start sportozen-web`, wait for `/api/ready`, then `start sportozen-worker`.
6. Check that people can sign in (it needs the same `BETTER_AUTH_SECRET`) and that recent records are present up to the restore point. Tell the owner exactly what period of changes is missing.
7. Keep the damaged copy until the owner agrees it can go.

If the whole server is lost: provision a new one ([DEPLOYMENT.md](DEPLOYMENT.md) Section 8), restore the latest backup from the off-server store with the key and the saved `BETTER_AUTH_SECRET`, then cut over as above.

## 6. Recovery time (OWNER DECISION: RTO)

The tool reports the time a restore takes. On the development machine a restore of a small synthetic database takes well under a second, which says nothing about production: real recovery time is dominated by the steps around it (noticing, deciding, provisioning a server, fetching the backup, DNS). Measure a full drill on the real server with a realistic database and record it; propose the RTO from that. Typical options are 1, 4 or 8 hours; a shorter RTO needs a warm standby server, which is a cost decision.

## 7. Monitoring (hooks for the Phase 2 operations work)

- Alert on exit status 1 or 2 of `sportozen-backup.service` and on `backup-status.mjs` exit 1.
- Alert if the staging directory or the data volume exceeds 80 % full.
- The off-server store should reject deletion with the server's credentials (write-only or object lock) so that a compromised server cannot erase its own backups.

## 8. Before relying on backups (checklist)

- [ ] OWNER: approve the storage provider and account; credentials for the server are write-only.
- [ ] OWNER: approve RPO, RTO and retention; set the three numbers in the environment file and the timer.
- [ ] Generate the encryption key; store a copy outside the server; confirm a second person can find it.
- [ ] Install and enable `sportozen-backup.timer`; run one backup by hand; confirm exit 0 and an off-server copy.
- [ ] Run `--rehearse` against the **off-server** copy on a clean machine using only the saved key.
- [ ] Perform one full cut-over drill on a non-production server and record the time.
- [ ] Repeat the rehearsal on a schedule (quarterly) and after every key or storage change.
- [ ] Add the alerts in Section 7.

## 9. What was verified (development machine, synthetic data)

`tests/unit/backup.test.ts` (34 tests): configuration rules; encrypted storage and no readable data or key in the artifact or manifest; consistency while a separate process keeps writing; restore to a new path with identical data; refusal to restore over the live database, an existing file or a relative path; detection of a flipped byte, truncation, an edited manifest, a missing manifest, a forged manifest hash (caught by the authentication tag), a wrong key and a missing key, with no key in any message; directory and command targets; a failed upload (backup kept locally and flagged "not off-server"); command output redaction; retention policy table tests and on-disk pruning that leaves other files alone; lock handling; and the three command-line tools with their exit codes.

Not verified: a real off-server store, a real scheduled run under systemd, behaviour on a large database, or a full drill on a server.
