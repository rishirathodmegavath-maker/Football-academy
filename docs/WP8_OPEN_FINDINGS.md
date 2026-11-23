# WP8 operational findings still open: assessment and recommended fixes

Status: **assessment only; the owner has decided (Phase 8) not to implement any of these fixes now. All five findings stay open exactly as assessed below, and the operational scripts are unchanged.**

Original status: **assessment only. `scripts/ops-check.mjs`, `scripts/ops-alert.mjs`, `scripts/lib/ops.mjs` and `deploy/*.sh` were not modified**, as instructed; the WP8 scope was not widened. Each finding was reproduced with a read-only harness (it imports the existing code and changes nothing) where it could be.

Written for: the application owner and whoever approves changes to the operational scripts.

Method and evidence: `evidence/p7-wp8-repro.txt` (alert logic, replayed with the real `decideAlerts`), `evidence/p7-wp8-rollback-repro.txt` (the real `deploy/rollback.sh`, copied, run in WSL Ubuntu against a throw-away tree with a stubbed `systemctl` and `curl`).

## Summary

| #   | Finding                                                                          | Reproduced                                                                    | Severity (operational)                                           | Blocks release?                                                        | Recommended fix size           |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| 1a  | A condition that alternates between warning and critical never produces an alert | **Yes**                                                                       | Medium (monitoring quality)                                      | No for a pilot with someone watching; fix before unattended production | small (about 10 lines) + tests |
| 1b  | A check that stops being reported never produces "resolved" and stays in state   | **Yes**                                                                       | Low-Medium                                                       | No                                                                     | small + tests                  |
| 2   | The weekly deep run and the minute run each count as a confirmation pass         | **Yes**                                                                       | Low                                                              | No                                                                     | small + test                   |
| 3   | `deploy/rollback.sh` reports success when the worker fails to restart            | **Yes**                                                                       | Medium (a rollback that leaves the worker down looks successful) | No for a pilot; fix before production                                  | small (a few lines) + test     |
| 4   | Stale-lock takeover has a check-then-delete window                               | **No** (reasoned from the code; not reachable without hooking the filesystem) | Low, accepted                                                    | No                                                                     | small, optional                |

None of the five is a Critical or High defect, none touches data or security, and none blocks the local release. Items 1a and 3 are worth fixing before the system runs unattended, because they are the ones where the monitoring says "fine" and is wrong. **The one thing that does block production is not in this list: the alert destination is not configured** (`docs/OPERATIONS.md`); without it every alert is computed and none is delivered.

## 1a. Warning/critical oscillation never confirms

- **What happens.** In `decideAlerts`, `seen` counts consecutive passes **at the same level**; any change of level resets it to 1 (`const seen = same ? before.seen + 1 : 1`), and an alert needs `seen >= confirmPasses` (2). A disk that is at 18 % free one minute (warning) and 9 % the next (critical), alternating, is a real problem present on every pass, but it is never "seen twice at one level".
- **Reproduction.** Eight alternating passes: **0 alerts**; control, two critical passes in a row: 1 alert (`p7-wp8-repro.txt`, 1a).
- **Severity.** Medium for monitoring quality: values hovering around a boundary are exactly what flaps. Not a data or security risk. Mitigated by the external uptime probe (not yet set up) and by the next steady pass.
- **Root cause.** One counter serves two purposes: "confirmed as a problem" and "confirmed at this level".
- **Targeted fix.** Keep `seen` as it is for same-level repetition and add `unhealthy`: consecutive passes at **either** non-OK level (`before ? before.unhealthy + 1 : 1`). A problem not yet reported is confirmed when `unhealthy >= confirmPasses`, and is reported at the **current** level; once reported, a change of level still needs `seen >= confirmPasses` at the new level before "CHANGED" is sent, so escalation does not become more trigger-happy. State written by the old code has no `unhealthy`; treat a missing value as `seen`.
- **Regression tests.** Alternating warning/critical sends one NEW after two passes; alternating then steady critical sends NEW then CHANGED only after two critical passes; a single blip to warning and back to OK sends nothing; the existing `ops-*.test.ts` table of cases unchanged; a replay of a recorded 24-hour state file.

## 1b. A check that disappears never resolves

- **What happens.** In the loop over earlier state, an entry whose check is **absent from this pass's results** (or `SKIP`) is kept as it was (`next[name] = before`), with the intent of keeping deep-run-only checks across the minute runs. If a check is removed or renamed, or its subject disappears (a mounted volume, a configured host), a reported problem stays "open" forever and no "resolved" is ever sent.
- **Reproduction.** A critical check reported once, then absent for 397 passes: messages `["NEW"]` only; the entry is still in the state (`p7-wp8-repro.txt`, 1b).
- **Severity.** Low-Medium: it affects an operator's picture after a configuration change, not the detection of problems.
- **Root cause.** The state has no notion of when a check was last evaluated, so "not evaluated by this kind of run" and "gone" look the same.
- **Targeted fix.** Store `lastEvaluatedAt` per entry. When a pass evaluates a name, update it. An entry not evaluated for longer than `2 x deepCheckStaleDays` (16 days, longer than any scheduled deep run) is resolved with an explicit message ("this check is no longer reported") and dropped. No change to what the minute run evaluates.
- **Regression tests.** Absent for less than the limit: kept, no message; absent beyond it: one RESOLVED with the "no longer reported" text; a deep-only check evaluated weekly is never dropped; entries without the new field are stamped on first sight.

## 2. Deep and minute runs count as two passes

- **What happens.** Both run `runAlertPass`, which calls `decideAlerts` and counts a pass each time. When the weekly deep run starts in the same minute as a minute run, one observation counts as two confirmation passes, and a problem is announced one minute early.
- **Reproduction.** Two passes four seconds apart: 1 alert after one real minute of observation (`p7-wp8-repro.txt`, 2).
- **Severity.** Low: it can only confirm a minute early; nothing is missed. The two-pass rule exists to avoid alerting on a single failed probe, which a deep run seconds after a minute run does not provide, so a one-off failure of a shared check (the app health probe) can be announced from one blip.
- **Root cause.** The pass counter does not know that the two passes are the same observation window.
- **Targeted fix.** Store `lastPassAt` per entry; a pass less than half the minute interval (30 s) after the previous one does not increment `seen`/`unhealthy`. (Alternative: the deep run does not call the alert decision for checks the minute run also evaluates.)
- **Regression test.** Two passes 4 s apart count as one; two passes 60 s apart count as two.

## 3. Rollback can report success when the worker fails to restart

- **What happens.** `deploy/rollback.sh` restarts each service and, if a restart fails, only logs `WARNING: ... did not restart cleanly; checking readiness`. The readiness check then asks only the **web** service's URL. A worker that cannot start is therefore not noticed, and `rollback.succeeded` is logged and the exit code is 0. (`release.sh` handles a failed restart by rolling back; the rollback itself has nowhere further to go.)
- **Reproduction.** Real script, stubbed `systemctl restart sportozen-worker` exiting 1: exit code **0**, event `rollback.succeeded`, "ready: ... is live" (`p7-wp8-rollback-repro.txt`).
- **Severity.** Medium: a rollback is done under stress and a "success" that leaves the background worker (sending email, WhatsApp, processing the outbox) down is easy to believe. Mitigations: the worker heartbeat check raises a warning within minutes (`workerStaleSeconds` 180), and the web service, the thing users see, is back.
- **Root cause.** Failure of a non-web service is downgraded to a warning for the right reason (do not abort a rollback half-way) but the outcome is never reported.
- **Targeted fix.** Record which services failed to restart; after the readiness check, if any did, log `rollback.succeeded_with_failures` listing them, print the failed units and the command to retry, and **exit non-zero** (2), without undoing the rollback. The web readiness check and the order of operations are unchanged.
- **Regression tests** (in `deploy/tests/test-release.sh`): worker restart fails, web ready: rollback is applied, exit code 2, the event names the worker; web restart fails and is not ready: the existing "not ready" path unchanged; all restarts succeed: exit 0 and `rollback.succeeded` unchanged.

## 4. Stale-lock takeover race

- **What happens.** `acquireAlertLock` decides a lock is stale, then checks `readLockFile(file) === raw` and unlinks. Between the check and the `unlink`, another process could replace the stale file with its own fresh lock, and the first process would delete the new one and proceed. The window is the time between two system calls (microseconds).
- **Reproduction.** Not reproduced: it needs a precisely timed interleaving of two processes. The code was read for it; the normal paths (a dead holder's lock is taken, a live lock is refused) work (`p7-wp8-repro.txt`, 4).
- **Severity.** Low, accepted earlier: the consequence is two runs handling alerts at once; ownership checks (`release.owned()`) stop the loser from overwriting the winner's state or deleting its lock, so the worst case is one duplicate or one delayed alert.
- **Targeted fix (optional).** Take over by atomically renaming the stale file to a unique name (`rename` is atomic), then verify that the renamed content equals the judged-stale content; if it does not (we moved someone's fresh lock), put it back with an exclusive create and report "locked". This removes the window without a new dependency.
- **Regression test.** Deterministic with an injectable file-system layer: a fresh lock appearing between the staleness judgement and the takeover must be left intact.

## Recommendation

Do not hold the release for any of these. Fix 3 and 1a in one small, separately reviewed change before the system is left unattended in production, with 1b and 2 in the same change if the reviewer agrees, and 4 only if the reviewer wants it. **Approval is needed** because these are changes to the operational scripts, which the earlier WP8 approval fixed. The alert destination and the external uptime probe (neither configured) matter more than all five.
