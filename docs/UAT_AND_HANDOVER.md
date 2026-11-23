# User acceptance and operational handover (WP9)

Status: **prepared, not executed.** User acceptance needs the people it is for (the owner, a coach, a parent, a platform administrator, a support person) on the approved target environment; none of that exists yet. This document is the script to run and the record to fill in. Until every row below is signed by the named person it must not be described as accepted. The automated tests listed in [RELEASE_ACCEPTANCE.md](RELEASE_ACCEPTANCE.md) are **not** user acceptance.

## 1. How to run it

1. Environment: the approved staging or production-like server with **synthetic data only** (fictional academy, fictional children). Never real children for acceptance.
2. One person per role performs the scenarios below on a real device (phone for Parent, desktop for Owner/Coach), reading the screen as written.
3. Each scenario is Pass, Fail or Not run. A Fail is recorded as a defect with severity (P0 blocks release, P1 blocks release, P2 may be accepted by the owner in writing).
4. The owner signs each role section. Per the audit, completion requires "the agreed acceptance criteria are met and the responsible stakeholder signs it off".

## 2. Scenarios by role

### Owner (academy owner)
| # | Scenario | Expected | Result | Date / initials |
| --- | --- | --- | --- | --- |
| O1 | Sign up, create an academy, set region and branch | Academy appears under "Your academy workspaces" | | |
| O2 | Invite a coach by e-mail (when e-mail is on) or by shared token | The coach receives it / can accept; invitation shows pending, then accepted | | |
| O3 | Invite a parent, linking one child; revoke a second invitation | Parent sees only that child; revoked token no longer works | | |
| O4 | Add players, a session, mark attendance, write an observation | Records persist after signing out and in again | | |
| O5 | Create a fee, record a payment, open the receipt PDF | Totals match; the PDF opens as a download | | |
| O6 | Turn on two-step verification, sign out and in | A code is requested; a recovery code works once | | |
| O7 | Sign in on two devices, change the password on one | The other device is signed out | | |
| O8 | Pause the academy through the platform administrator (O9 first) | The owner is refused with the "suspended" message; data intact after re-enabling | | |

### Admin / Coach
| # | Scenario | Expected | Result | Date / initials |
| --- | --- | --- | --- | --- |
| C1 | Coach opens the academy | Sees only own players and sessions | | |
| C2 | Coach asks for an unassigned player (by URL or search) | Refused / not shown | | |
| C3 | Coach tries to open fees, invite staff, or another academy | Refused | | |
| C4 | Coach submits attendance twice (double click, flaky network) | One record, no duplicate | | |

### Parent
| # | Scenario | Expected | Result | Date / initials |
| --- | --- | --- | --- | --- |
| P1 | Parent signs in after accepting an invitation | Sees own child only: schedule, approved reports, fees | | |
| P2 | Parent tries a sibling's or another child's record | Refused / not shown | | |
| P3 | Parent downloads an approved report PDF and an invoice | Own child's documents only | | |
| P4 | Parent with a lost password uses "Forgot your password?" (when recovery is on) | Link arrives, works once, old sessions end | | |

### Platform administrator and Support
| # | Scenario | Expected | Result | Date / initials |
| --- | --- | --- | --- | --- |
| A1 | Platform administrator lists customer accounts and pauses one | Metadata only; no child records visible | | |
| A2 | Platform administrator opens an academy's children | Refused | | |
| S1 | Owner grants Support access to named children for an hour, with a reason | Support sees only those children, read-only; access ends after an hour; the grant is in the audit trail | | |
| S2 | Support tries to write, or open messages and fees | Refused | | |

### Cross-cutting (the audit's acceptance scenarios that apply to this release)
| # | Scenario | Expected | Result | Date / initials |
| --- | --- | --- | --- | --- |
| X1 | Academy A user requests Academy B data | Access denied | | |
| X2 | E-mail provider unavailable while inviting | The invitation is still created; delivery is retried; the token can be shared by hand | | |
| X3 | A deployment fails readiness | The previous release returns automatically; data and sign-ins intact | | |
| X4 | Restore the latest backup onto a separate machine | Sign in works; recent records present up to the restore point | | |

## 3. Sign-off

| Role | Person | Date | Signature / written confirmation |
| --- | --- | --- | --- |
| Owner | | | |
| Coach / Admin | | | |
| Parent | | | |
| Platform administrator | | | |
| Support | | | |

## 4. Operational ownership and handover

**Owner decisions needed first** (nothing below can be assigned until they are made): hosting provider and region, domain and DNS ownership, e-mail provider, off-server backup store, RPO/RTO, MFA policy, who is paged and when ([PHASE2_REPORT.md](PHASE2_REPORT.md) section "Owner decisions").

| Responsibility | Owner (name) | Backup (name) | Where it is documented |
| --- | --- | --- | --- |
| Releases and rollback | | | [DEPLOYMENT.md](DEPLOYMENT.md) section 5 |
| Backups and restore drills | | | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) |
| Alerts (receiving and responding) | | | [OPERATIONS.md](OPERATIONS.md) |
| Security incidents and breach decisions | | | [OPERATIONS.md](OPERATIONS.md) section 8 |
| Platform administrator accounts (who holds them) | | | [AUTHENTICATION.md](AUTHENTICATION.md) |
| Account recovery (lost authenticator) | | | [AUTHENTICATION.md](AUTHENTICATION.md) section 3 |
| Dependency and security updates | | | [SECURITY_HARDENING.md](SECURITY_HARDENING.md) section 5 |
| Domain, DNS and certificates | | | [DEPLOYMENT.md](DEPLOYMENT.md) section 6 |
| E-mail provider and sending domain | | | [EMAIL.md](EMAIL.md) |

**Access and secrets inventory to hand over** (the values themselves are never written in this repository): server administrator access (SSH keys, named people); the cloud account owner; DNS control; `BETTER_AUTH_SECRET` (and where its offline copy is); the backup encryption key (and a second custodian); the off-server store credential (write-only for the server, separate admin credential held by the owner); the e-mail provider credentials; the alert destination account; the repository and CI administrators.

**Recurring tasks**

| Task | Frequency | Evidence to keep |
| --- | --- | --- |
| Restore rehearsal from the off-server copy on a clean machine | Quarterly, and after any key or storage change | Date, backup used, time taken, result |
| Alert test (`scripts/ops-check.mjs --test-alert`) and one forced outage | After any change to alert destinations; quarterly | Date, who received it |
| Dependency audit and updates | Weekly review of proposals; monthly merge window | Audit output |
| Operating-system security updates and reboot window | Monthly or as advised | Date, packages |
| Certificate renewal check | Automatic; verify monthly | `certbot certificates` output |
| Secret rotation drill | Yearly, and on any suspected exposure | Date, what was rotated |
| Access review (who has server, cloud, DNS, platform-administrator access) | Quarterly | Signed list |
| Log retention and shipping check | Quarterly | Oldest retained entry |
| Review of open P2 defects and accepted risks | Each release | Updated register |

**Handover meeting checklist**: walk the owner through the deployment of a release and a rollback on staging; trigger and receive one alert; perform one restore; show where each secret lives and who can retrieve it; agree the incident roles; sign the table above.
