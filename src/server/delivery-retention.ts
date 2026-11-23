import "server-only";
import { randomUUID } from "node:crypto";
import { atomic, audit, database } from "./database";
import { log } from "./log";

/**
 * Delivery-history retention: communication delivery jobs, their provider
 * attempts, and the webhook events that reported on them are kept for 12
 * months and then removed, a bounded batch at a time. docs/DELIVERY_RETENTION.md
 * explains the rules; this file is where they are enforced.
 *
 * What counts as old: the END of a job's lifecycle, in UTC, must be strictly
 * earlier than the cut-off (now minus 12 calendar months). The end of the
 * lifecycle is the latest of its due time, its expiry and its last provider
 * attempt, so a job that was retried or reported late is not removed on the
 * strength of its first date. A record exactly at the cut-off is kept.
 *
 * What is never removed, however old:
 *   - a job that is not in a final state (QUEUED, PROVIDER_ACCEPTED, SENT,
 *     UNKNOWN: still retrying, awaiting a receipt, or awaiting reconciliation);
 *   - a job that is claimed by a sender right now;
 *   - a job with any attempt that is itself unresolved (UNKNOWN) or recent;
 *   - a record whose timestamps are not valid UTC (it is reported, not touched);
 *   - webhook events that were not processed, and the three outcomes staff still
 *     see as an action list (AMBIGUOUS_CHILD, UNKNOWN_CONTACT, UNSUPPORTED_MESSAGE).
 *   - everything else: announcements, conversations, plans, reports, finance
 *     records and every history/audit table are never written by this file.
 */
export const DELIVERY_RETENTION_MONTHS = 12;
export const FINAL_JOB_STATES = [
  "DELIVERED",
  "READ",
  "FAILED",
  "CANCELLED",
] as const;
export const UNRESOLVED_EVENT_OUTCOMES = [
  "AMBIGUOUS_CHILD",
  "UNKNOWN_CONTACT",
  "UNSUPPORTED_MESSAGE",
] as const;
export const DEFAULT_BATCH_SIZE = 500;
export const DEFAULT_MAX_BATCHES = 20;
/** A running cleanup holds this lease; a crashed one is taken over after it. */
export const LEASE_SECONDS = 120;
export const RETENTION_ACTOR = "system:delivery-retention";

export type RetentionMode = "off" | "report" | "on";
/** SPORTOZEN_RETENTION: off (nothing runs), report (default: counts only,
 * nothing is deleted), on (deletes). Anything else is an error, never a guess. */
export function retentionMode(
  env: Record<string, string | undefined> = process.env,
): RetentionMode {
  const value = (env.SPORTOZEN_RETENTION ?? "report").trim().toLowerCase();
  if (value !== "off" && value !== "report" && value !== "on")
    throw new Error('SPORTOZEN_RETENTION must be "off", "report" or "on".');
  return value;
}

/** `now` minus `months` calendar months, in UTC, as an ISO string. A day that
 * does not exist in the earlier month (29 February) is clamped to that month's
 * last day, which is the earlier cut-off, so the record is kept the longer. */
export function retentionCutoff(
  now: Date,
  months = DELIVERY_RETENTION_MONTHS,
): string {
  const y = now.getUTCFullYear(),
    m = now.getUTCMonth() - months,
    lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  ).toISOString();
}

// A timestamp is comparable as text only when it is UTC ISO 8601. Anything else
// is held back and reported.
const UTC = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'";
const FINAL = FINAL_JOB_STATES.map((s) => `'${s}'`).join(",");
const UNRESOLVED = UNRESOLVED_EVENT_OUTCOMES.map((s) => `'${s}'`).join(",");
/** The one definition of a deletable job (aliased `j`); parameter: cut-off. */
const ELIGIBLE_JOB = `
  j.state IN (${FINAL}) AND j.claim IS NULL
  AND j.dueAt GLOB ${UTC} AND j.expiresAt GLOB ${UTC}
  AND j.dueAt < :cutoff AND j.expiresAt < :cutoff
  AND NOT EXISTS (
    SELECT 1 FROM delivery_attempts a
    WHERE a.jobId=j.id AND (a.state='UNKNOWN' OR NOT (a.at GLOB ${UTC}) OR a.at >= :cutoff))`;
/** The one definition of a deletable event (aliased `e`); parameter: cut-off. */
const ELIGIBLE_EVENT = `
  e.processedAt IS NOT NULL AND e.outcome IS NOT NULL
  AND e.outcome NOT IN (${UNRESOLVED})
  AND e.receivedAt GLOB ${UTC} AND e.receivedAt < :cutoff`;

export interface AcademyTotals {
  jobs: number;
  attempts: number;
  events: number;
  oldestDueAt: string | null;
  newestDueAt: string | null;
}
export interface HeldBack {
  /** Older than the cut-off but not in a final state. */
  nonFinalJobs: Record<string, number>;
  /** Final, old, but claimed, or with an unresolved or recent attempt. */
  inFlightJobs: number;
  /** A timestamp that is not valid UTC text; never touched. */
  malformedTimestamps: number;
  /** Old events that are unprocessed or still an action list for staff. */
  openEvents: number;
}
export interface RetentionResult {
  runId: string;
  mode: "REPORT" | "EXECUTE";
  status: "COMPLETED" | "CAPPED" | "FAILED" | "SKIPPED";
  cutoff: string;
  retentionMonths: number;
  batches: number;
  jobs: number;
  attempts: number;
  events: number;
  perAcademy: Record<string, AcademyTotals>;
  heldBack: HeldBack;
  error?: string;
}

const nowIso = (now: Date) => now.toISOString();
const num = (value: unknown) => Number(value ?? 0);
const empty = (): AcademyTotals => ({
  jobs: 0,
  attempts: 0,
  events: 0,
  oldestDueAt: null,
  newestDueAt: null,
});
/** Never store free-form error text with a path, a token or a link. */
function safeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .slice(0, 300);
}

/** What a run would remove, and what it is holding back. Reads only. */
export function previewRetention(now = new Date()) {
  const cutoff = retentionCutoff(now),
    db = database(),
    perAcademy: Record<string, AcademyTotals> = {};
  const at = (id: string) => (perAcademy[id] ??= empty());
  for (const row of db
    .prepare(
      `SELECT j.academyId, COUNT(*) n, MIN(j.dueAt) oldest, MAX(j.dueAt) newest,
              SUM((SELECT COUNT(*) FROM delivery_attempts a WHERE a.jobId=j.id)) attempts
       FROM delivery_jobs j WHERE ${ELIGIBLE_JOB} GROUP BY j.academyId`,
    )
    .all({ cutoff })) {
    const t = at(String(row.academyId));
    t.jobs = num(row.n);
    t.attempts = num(row.attempts);
    t.oldestDueAt = String(row.oldest);
    t.newestDueAt = String(row.newest);
  }
  for (const row of db
    .prepare(
      `SELECT e.academyId, COUNT(*) n FROM communication_events e
       WHERE ${ELIGIBLE_EVENT} GROUP BY e.academyId`,
    )
    .all({ cutoff }))
    at(String(row.academyId)).events = num(row.n);
  const nonFinal: Record<string, number> = {};
  for (const row of db
    .prepare(
      `SELECT j.state, COUNT(*) n FROM delivery_jobs j
       WHERE j.state NOT IN (${FINAL}) AND j.dueAt GLOB ${UTC} AND j.dueAt < :cutoff
       GROUP BY j.state`,
    )
    .all({ cutoff }))
    nonFinal[String(row.state)] = num(row.n);
  const heldBack: HeldBack = {
    nonFinalJobs: nonFinal,
    inFlightJobs: num(
      db
        .prepare(
          `SELECT COUNT(*) n FROM delivery_jobs j
           WHERE j.state IN (${FINAL}) AND j.dueAt GLOB ${UTC} AND j.expiresAt GLOB ${UTC}
             AND j.dueAt < :cutoff AND j.expiresAt < :cutoff
             AND NOT (${ELIGIBLE_JOB})`,
        )
        .get({ cutoff })?.n,
    ),
    malformedTimestamps: num(
      db
        .prepare(
          `SELECT COUNT(*) n FROM delivery_jobs j
           WHERE NOT (j.dueAt GLOB ${UTC} AND j.expiresAt GLOB ${UTC})`,
        )
        .get()?.n,
    ),
    openEvents: num(
      db
        .prepare(
          `SELECT COUNT(*) n FROM communication_events e
           WHERE e.receivedAt GLOB ${UTC} AND e.receivedAt < :cutoff
             AND NOT (${ELIGIBLE_EVENT})`,
        )
        .get({ cutoff })?.n,
    ),
  };
  return { cutoff, perAcademy, heldBack };
}

interface RunOptions {
  /** Delete (true) or only count (false, the default). */
  execute?: boolean;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * One cleanup run. A dry run (execute false) only counts. A real run removes
 * at most batchSize jobs per transaction and maxBatches transactions per run;
 * anything left is removed by the next run, so the work is spread out and the
 * database is never locked for long. Safe to start twice: the second sees the
 * first one's lease and records SKIPPED. A crashed run's lease expires and is
 * recorded FAILED by the next run. Re-running changes nothing once the
 * eligible rows are gone.
 */
export async function runDeliveryRetention(
  options: RunOptions = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date(),
    execute = options.execute === true,
    batchSize = Math.max(
      1,
      Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 5000),
    ),
    maxBatches = Math.max(1, options.maxBatches ?? DEFAULT_MAX_BATCHES),
    cutoff = retentionCutoff(now),
    db = database(),
    runId = randomUUID(),
    started = nowIso(now);
  const base = {
    runId,
    mode: execute ? ("EXECUTE" as const) : ("REPORT" as const),
    cutoff,
    retentionMonths: DELIVERY_RETENTION_MONTHS,
  };
  const record = (
    status: RetentionResult["status"] | "RUNNING",
    fields: Partial<RetentionResult> & { leaseUntil?: string | null } = {},
  ) =>
    db
      .prepare(
        `INSERT INTO delivery_retention_runs(id,mode,status,startedAt,finishedAt,leaseUntil,cutoff,retentionMonths,batches,jobs,attempts,events,summary,error)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,finishedAt=excluded.finishedAt,leaseUntil=excluded.leaseUntil,
           batches=excluded.batches,jobs=excluded.jobs,attempts=excluded.attempts,events=excluded.events,summary=excluded.summary,error=excluded.error`,
      )
      .run(
        runId,
        base.mode,
        status,
        started,
        status === "RUNNING" ? null : nowIso(new Date()),
        fields.leaseUntil ?? null,
        cutoff,
        DELIVERY_RETENTION_MONTHS,
        fields.batches ?? 0,
        fields.jobs ?? 0,
        fields.attempts ?? 0,
        fields.events ?? 0,
        fields.perAcademy || fields.heldBack
          ? JSON.stringify({
              perAcademy: fields.perAcademy,
              heldBack: fields.heldBack,
            })
          : null,
        fields.error ?? null,
      );
  const lease = () => new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();

  // ------------------------------------------------------------- dry run
  if (!execute) {
    const preview = previewRetention(now);
    const sum = (key: "jobs" | "attempts" | "events") =>
      Object.values(preview.perAcademy).reduce((n, a) => n + a[key], 0);
    const result: RetentionResult = {
      ...base,
      status: "COMPLETED",
      batches: 0,
      jobs: sum("jobs"),
      attempts: sum("attempts"),
      events: sum("events"),
      perAcademy: preview.perAcademy,
      heldBack: preview.heldBack,
    };
    record("COMPLETED", result);
    log("info", "retention.report", {
      jobs: result.jobs,
      attempts: result.attempts,
      events: result.events,
    });
    return result;
  }

  // ------------------------------------------------------------ the lease
  const heldBack = previewRetention(now).heldBack;
  const taken = atomic(() => {
    // A run that stopped without finishing (a crash) is recorded as such.
    db.prepare(
      `UPDATE delivery_retention_runs SET status='FAILED', finishedAt=?, error='Lease expired: the run stopped without finishing'
       WHERE status='RUNNING' AND mode='EXECUTE' AND leaseUntil<?`,
    ).run(nowIso(new Date()), nowIso(new Date()));
    const other = db
      .prepare(
        "SELECT 1 FROM delivery_retention_runs WHERE status='RUNNING' AND mode='EXECUTE' AND leaseUntil>=?",
      )
      .get(nowIso(new Date()));
    if (other) return false;
    record("RUNNING", { leaseUntil: lease() });
    return true;
  });
  if (!taken) {
    const result: RetentionResult = {
      ...base,
      status: "SKIPPED",
      batches: 0,
      jobs: 0,
      attempts: 0,
      events: 0,
      perAcademy: {},
      heldBack,
      error: "Another cleanup run is in progress.",
    };
    record("SKIPPED", result);
    return result;
  }

  // ------------------------------------------------------------ the batches
  const perAcademy: Record<string, AcademyTotals> = {};
  const totals = { batches: 0, jobs: 0, attempts: 0, events: 0 };
  let status: RetentionResult["status"] = "COMPLETED",
    error: string | undefined;
  try {
    for (;;) {
      if (totals.batches >= maxBatches) {
        status = "CAPPED";
        break;
      }
      const removed = atomic(() => {
        const jobs = db
          .prepare(
            `SELECT j.id, j.academyId, j.dueAt FROM delivery_jobs j
             WHERE ${ELIGIBLE_JOB} ORDER BY j.dueAt, j.id LIMIT :limit`,
          )
          .all({ cutoff, limit: batchSize }) as {
          id: string;
          academyId: string;
          dueAt: string;
        }[];
        const ids = JSON.stringify(jobs.map((j) => j.id));
        const delta: Record<string, AcademyTotals> = {};
        const at = (academyId: string) => (delta[academyId] ??= empty());
        let attempts = 0;
        if (jobs.length) {
          const owner = new Map(jobs.map((j) => [j.id, j.academyId]));
          for (const row of db
            .prepare(
              "SELECT jobId, COUNT(*) n FROM delivery_attempts WHERE jobId IN (SELECT value FROM json_each(?)) GROUP BY jobId",
            )
            .all(ids))
            at(owner.get(String(row.jobId))!).attempts += num(row.n);
          // Children first: delivery_attempts.jobId references delivery_jobs.
          attempts = num(
            db
              .prepare(
                "DELETE FROM delivery_attempts WHERE jobId IN (SELECT value FROM json_each(?))",
              )
              .run(ids).changes,
          );
          const deleted = num(
            db
              .prepare(
                `DELETE FROM delivery_jobs WHERE id IN (SELECT value FROM json_each(?))
                 AND state IN (${FINAL}) AND claim IS NULL`,
              )
              .run(ids).changes,
          );
          // If anything differs, nothing is removed: the whole batch rolls back.
          if (deleted !== jobs.length)
            throw new Error("A job changed while it was being removed.");
          for (const job of jobs) {
            const t = at(job.academyId);
            t.jobs++;
            if (!t.oldestDueAt || job.dueAt < t.oldestDueAt)
              t.oldestDueAt = job.dueAt;
            if (!t.newestDueAt || job.dueAt > t.newestDueAt)
              t.newestDueAt = job.dueAt;
          }
        }
        const events = db
          .prepare(
            `SELECT e.id, e.academyId FROM communication_events e
             WHERE ${ELIGIBLE_EVENT} ORDER BY e.receivedAt, e.id LIMIT :limit`,
          )
          .all({ cutoff, limit: batchSize }) as {
          id: string;
          academyId: string;
        }[];
        if (events.length) {
          const deleted = num(
            db
              .prepare(
                "DELETE FROM communication_events WHERE id IN (SELECT value FROM json_each(?))",
              )
              .run(JSON.stringify(events.map((e) => e.id))).changes,
          );
          if (deleted !== events.length)
            throw new Error("An event changed while it was being removed.");
          for (const e of events) at(e.academyId).events++;
        }
        // The totals and the lease are written in the same transaction as the
        // deletions they describe.
        record("RUNNING", {
          batches: totals.batches + 1,
          jobs: totals.jobs + jobs.length,
          attempts: totals.attempts + attempts,
          events: totals.events + events.length,
          leaseUntil: lease(),
        });
        return { delta, jobs: jobs.length, attempts, events: events.length };
      });
      // Applied only after the batch committed.
      totals.jobs += removed.jobs;
      totals.attempts += removed.attempts;
      totals.events += removed.events;
      for (const [academyId, d] of Object.entries(removed.delta)) {
        const t = (perAcademy[academyId] ??= empty());
        t.jobs += d.jobs;
        t.attempts += d.attempts;
        t.events += d.events;
        if (d.oldestDueAt && (!t.oldestDueAt || d.oldestDueAt < t.oldestDueAt))
          t.oldestDueAt = d.oldestDueAt;
        if (d.newestDueAt && (!t.newestDueAt || d.newestDueAt > t.newestDueAt))
          t.newestDueAt = d.newestDueAt;
      }
      if (removed.jobs + removed.events > 0) totals.batches++;
      if (removed.jobs + removed.events === 0) break;
      // Let other work on this process run between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (e) {
    status = "FAILED";
    error = safeError(e);
    log("error", "retention.failed", { error });
  }

  const result: RetentionResult = {
    ...base,
    status,
    ...totals,
    perAcademy,
    heldBack,
    ...(error ? { error } : {}),
  };
  // The run record and the academies' audit entries are written together.
  atomic(() => {
    record(status, result);
    for (const [academyId, t] of Object.entries(perAcademy))
      audit(
        academyId,
        RETENTION_ACTOR,
        `Delivery history retention removed ${t.jobs} job(s), ${t.attempts} attempt(s) and ${t.events} webhook event(s) older than ${cutoff}`,
        runId,
      );
  });
  log("info", "retention.run", {
    status,
    batches: totals.batches,
    jobs: totals.jobs,
    attempts: totals.attempts,
    events: totals.events,
  });
  return result;
}

/** What the worker calls once a day, according to SPORTOZEN_RETENTION. */
export async function scheduledRetention(
  env: Record<string, string | undefined> = process.env,
) {
  const mode = retentionMode(env);
  if (mode === "off") return null;
  return runDeliveryRetention({ execute: mode === "on" });
}
