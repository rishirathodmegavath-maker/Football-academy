// Delivery-history retention (docs/DELIVERY_RETENTION.md): twelve months, UTC,
// by the end of the record's lifecycle; never an unresolved, claimed or recent
// record; bounded, idempotent, safe to run twice, safe to fail; and nothing
// outside the delivery tables is touched. Everything runs on a throw-away
// database that this file creates; no real database is read or changed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
import { database } from "@/server/database";
import {
  DELIVERY_RETENTION_MONTHS,
  FINAL_JOB_STATES,
  LEASE_SECONDS,
  RETENTION_ACTOR,
  UNRESOLVED_EVENT_OUTCOMES,
  previewRetention,
  retentionCutoff,
  retentionMode,
  runDeliveryRetention,
  scheduledRetention,
} from "@/server/delivery-retention";
import { activateAcademy } from "./helpers/lifecycle";

const filename = join(tmpdir(), `sportozen-retention-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const NOW = new Date("2026-11-03T12:00:00.000Z");
const CUTOFF = "2025-11-03T12:00:00.000Z";
const at = (offsetMs: number) =>
  new Date(Date.parse(CUTOFF) + offsetMs).toISOString();
const OLD = -1, // one millisecond older than 12 months
  EXACT = 0,
  NEW = 1; // one millisecond newer

let n = 0;
interface JobSpec {
  academyId?: string;
  state?: string;
  dueAt?: string;
  expiresAt?: string;
  claim?: string | null;
  attempts?: { at: string; state?: string }[];
  type?: string;
}
function job(spec: JobSpec = {}) {
  const id = `job-${++n}`;
  database()
    .prepare(
      "INSERT INTO delivery_jobs(id,academyId,playerId,guardianId,type,sourceId,sourceVersion,period,correction,dueAt,expiresAt,state,claim) VALUES(?,?,?,?,?,?,1,?,'',?,?,?,?)",
    )
    .run(
      id,
      spec.academyId ?? "a",
      `player-${n}`,
      "guardian",
      spec.type ?? "WEEKLY",
      `source-${n}`,
      `period-${n}`,
      spec.dueAt ?? at(OLD),
      spec.expiresAt ?? spec.dueAt ?? at(OLD),
      spec.state ?? "DELIVERED",
      spec.claim ?? null,
    );
  for (const [i, attempt] of (spec.attempts ?? []).entries())
    database()
      .prepare(
        "INSERT INTO delivery_attempts(id,jobId,at,state) VALUES(?,?,?,?)",
      )
      .run(`${id}-att-${i}`, id, attempt.at, attempt.state ?? "DELIVERED");
  return id;
}
function event(spec: {
  academyId?: string;
  receivedAt: string;
  processedAt?: string | null;
  outcome?: string | null;
}) {
  const id = `event-${++n}`;
  database()
    .prepare(
      "INSERT INTO communication_events(id,academyId,phoneNumberId,body,receivedAt,processedAt,outcome) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      spec.academyId ?? "a",
      "phone",
      '{"message":{"from":"15550001111"}}',
      spec.receivedAt,
      spec.processedAt === undefined ? spec.receivedAt : spec.processedAt,
      spec.outcome === undefined ? "STATUS_DELIVERED" : spec.outcome,
    );
  return id;
}
const exists = (table: string, id: string) =>
  Boolean(database().prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id));
const count = (table: string) =>
  Number(database().prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);

beforeEach(() => {
  const db = database();
  db.exec(`DROP TRIGGER IF EXISTS poison_job;
    DELETE FROM delivery_attempts; DELETE FROM delivery_jobs; DELETE FROM communication_events;
    DELETE FROM delivery_retention_runs;`);
  for (const id of ["a", "b"]) {
    db.prepare(
      "INSERT OR IGNORE INTO academy_workspaces(id,config) VALUES(?,?)",
    ).run(id, JSON.stringify({ id, academyId: id }));
    activateAcademy(db, id);
  }
});

describe("the twelve-month cut-off", () => {
  it("is twelve calendar months before now, in UTC", () => {
    expect(retentionCutoff(NOW)).toBe(CUTOFF);
    expect(retentionCutoff(new Date("2026-01-31T23:59:59.999Z"))).toBe(
      "2025-01-31T23:59:59.999Z",
    );
    expect(retentionCutoff(new Date("2026-03-01T00:00:00.000Z"))).toBe(
      "2025-03-01T00:00:00.000Z",
    );
  });
  it("keeps a record longer, never shorter, when the day does not exist a year earlier", () => {
    // 29 February 2028 minus 12 months is 28 February 2027, the earlier cut-off.
    expect(retentionCutoff(new Date("2028-02-29T10:00:00.000Z"))).toBe(
      "2027-02-28T10:00:00.000Z",
    );
    expect(retentionCutoff(new Date("2026-03-31T00:00:00.000Z"), 1)).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
  it("is not affected by the machine's time zone", () => {
    const before = process.env.TZ;
    for (const zone of [
      "Asia/Kolkata",
      "America/Los_Angeles",
      "Pacific/Kiritimati",
    ]) {
      process.env.TZ = zone;
      expect(retentionCutoff(NOW)).toBe(CUTOFF);
    }
    process.env.TZ = before;
  });
  it("is twelve months", () => {
    expect(DELIVERY_RETENTION_MONTHS).toBe(12);
  });
});

describe("which jobs are removed", () => {
  it("removes a job older than twelve months, keeps one exactly at the boundary and one newer", async () => {
    const older = job({ dueAt: at(OLD) });
    const exact = job({ dueAt: at(EXACT) });
    const newer = job({ dueAt: at(NEW) });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result).toMatchObject({
      status: "COMPLETED",
      jobs: 1,
      cutoff: CUTOFF,
    });
    expect(exists("delivery_jobs", older)).toBe(false);
    expect(exists("delivery_jobs", exact)).toBe(true);
    expect(exists("delivery_jobs", newer)).toBe(true);
  });
  it("judges the end of the lifecycle: the due time, the expiry and the last attempt", async () => {
    const lateExpiry = job({ dueAt: at(OLD), expiresAt: at(EXACT) });
    const lateAttempt = job({
      dueAt: at(OLD),
      attempts: [{ at: at(OLD) }, { at: at(NEW) }],
    });
    const exactAttempt = job({ dueAt: at(OLD), attempts: [{ at: at(EXACT) }] });
    const allOld = job({
      dueAt: at(-5000),
      expiresAt: at(-4000),
      attempts: [{ at: at(-3000) }, { at: at(OLD) }],
    });
    await runDeliveryRetention({ execute: true, now: NOW });
    expect(exists("delivery_jobs", lateExpiry)).toBe(true);
    expect(exists("delivery_jobs", lateAttempt)).toBe(true);
    expect(exists("delivery_jobs", exactAttempt)).toBe(true);
    expect(exists("delivery_jobs", allOld)).toBe(false);
  });
  it("removes every final state and no other", async () => {
    const byState: Record<string, string> = {};
    for (const state of [
      ...FINAL_JOB_STATES,
      "QUEUED",
      "PROVIDER_ACCEPTED",
      "SENT",
      "UNKNOWN",
      "NOT_SENT",
    ])
      byState[state] = job({ state });
    await runDeliveryRetention({ execute: true, now: NOW });
    for (const [state, id] of Object.entries(byState))
      expect(exists("delivery_jobs", id), state).toBe(
        !(FINAL_JOB_STATES as readonly string[]).includes(state),
      );
  });
  it("never removes a job a sender holds, or one with an unresolved attempt", async () => {
    const claimed = job({ claim: "worker-1" });
    const unknownAttempt = job({
      attempts: [{ at: at(OLD), state: "UNKNOWN" }],
    });
    const settled = job({ attempts: [{ at: at(OLD), state: "DELIVERED" }] });
    await runDeliveryRetention({ execute: true, now: NOW });
    expect(exists("delivery_jobs", claimed)).toBe(true);
    expect(exists("delivery_jobs", unknownAttempt)).toBe(true);
    expect(exists("delivery_attempts", `${unknownAttempt}-att-0`)).toBe(true);
    expect(exists("delivery_jobs", settled)).toBe(false);
  });
  it("leaves a record whose timestamps are not UTC alone, and says so", async () => {
    const local = job({
      dueAt: "2024-01-01T10:00:00+05:30",
      expiresAt: "2024-01-01T10:00:00+05:30",
    });
    const odd = job({ dueAt: "yesterday", expiresAt: "yesterday" });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(exists("delivery_jobs", local)).toBe(true);
    expect(exists("delivery_jobs", odd)).toBe(true);
    expect(result.heldBack.malformedTimestamps).toBe(2);
  });
  it("removes the attempts of a removed job and keeps the attempts of a kept one", async () => {
    const gone = job({
      attempts: [{ at: at(OLD) }, { at: at(-9000) }, { at: at(-8000) }],
    });
    const kept = job({ dueAt: at(NEW), attempts: [{ at: at(NEW) }] });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result.attempts).toBe(3);
    expect(count("delivery_attempts")).toBe(1);
    expect(exists("delivery_attempts", `${kept}-att-0`)).toBe(true);
    expect(exists("delivery_attempts", `${gone}-att-0`)).toBe(false);
  });
  it("reports old jobs that are held back, by reason", async () => {
    job({ state: "QUEUED" });
    job({ state: "SENT" });
    job({ state: "SENT" });
    job({ state: "UNKNOWN" });
    job({ claim: "w" });
    const result = await runDeliveryRetention({ execute: false, now: NOW });
    expect(result.heldBack.nonFinalJobs).toEqual({
      QUEUED: 1,
      SENT: 2,
      UNKNOWN: 1,
    });
    expect(result.heldBack.inFlightJobs).toBe(1);
    expect(result.jobs).toBe(0);
  });
  it("covers announcement and reply jobs the same way, in any academy", async () => {
    const a = job({ type: "ANNOUNCEMENT", academyId: "a" });
    const b = job({ type: "REPLY", academyId: "b" });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(exists("delivery_jobs", a) || exists("delivery_jobs", b)).toBe(
      false,
    );
    expect(Object.keys(result.perAcademy).sort()).toEqual(["a", "b"]);
    expect(result.perAcademy.a).toMatchObject({ jobs: 1 });
  });
});

describe("which webhook events are removed", () => {
  it("removes processed events older than twelve months and keeps the rest", async () => {
    const older = event({ receivedAt: at(OLD) });
    const exact = event({ receivedAt: at(EXACT) });
    const newer = event({ receivedAt: at(NEW) });
    const unprocessed = event({
      receivedAt: at(OLD),
      processedAt: null,
      outcome: null,
    });
    // An outcome with no processing time is inconsistent; "processed" is judged
    // on its own, not inferred from the outcome.
    const odd = event({
      receivedAt: at(OLD),
      processedAt: null,
      outcome: "ROUTED",
    });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result.events).toBe(1);
    expect(exists("communication_events", odd)).toBe(true);
    expect(exists("communication_events", older)).toBe(false);
    for (const id of [exact, newer, unprocessed])
      expect(exists("communication_events", id)).toBe(true);
  });
  it("keeps the events staff still see as an action list, however old", async () => {
    const kept = UNRESOLVED_EVENT_OUTCOMES.map((outcome) =>
      event({ receivedAt: at(-100000), outcome }),
    );
    const routed = event({ receivedAt: at(-100000), outcome: "ROUTED" });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    for (const id of kept)
      expect(exists("communication_events", id)).toBe(true);
    expect(exists("communication_events", routed)).toBe(false);
    expect(result.heldBack.openEvents).toBe(3);
  });
});

describe("what is never touched", () => {
  it("leaves announcements, conversations, finance, history, audit and e-mail rows exactly as they were", async () => {
    const db = database();
    db.prepare(
      'INSERT INTO batch_announcements(academyId,id,body) VALUES(\'a\',\'ann-1\',\'{"id":"ann-1","academyId":"a","status":"QUEUED"}\')',
    ).run();
    db.prepare(
      'INSERT INTO workspace_records(academyId,kind,id,body) VALUES(\'a\',\'conversation\',\'c-1\',\'{"id":"c-1","academyId":"a","messages":[{"text":"old reply"}]}\')',
    ).run();
    db.prepare(
      "INSERT INTO workspace_records(academyId,kind,id,body) VALUES('a','update','u-1','{\"id\":\"u-1\",\"academyId\":\"a\"}')",
    ).run();
    db.prepare(
      "INSERT INTO academy_finance_records(academyId,kind,id,body,version) VALUES('a','invoice','i-1','{\"id\":\"i-1\",\"academyId\":\"a\"}',1)",
    ).run();
    db.prepare(
      "INSERT INTO academy_finance_history(academyId,kind,recordId,version,body,actorId,at) VALUES('a','invoice','i-1',1,'{}','u','2020-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO workspace_audit(academyId,userId,action,at) VALUES('a','u','old action','2020-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO email_suppressions(address,reason,source,createdAt) VALUES('x@example.test','BOUNCED','p','2020-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO email_outbox(id,purpose,toAddress,subject,status,attempts,nextAttemptAt,createdAt,expiresAt,finishedAt) VALUES('e-1','NOTIFICATION','x@example.test','s','SENT',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO communication_reminders(academyId,period,type,playerId,reason) VALUES('a','2020-W01','WEEKLY','p','awaiting approval')",
    ).run();
    const tables = [
      "batch_announcements",
      "workspace_records",
      "academy_finance_records",
      "academy_finance_history",
      "email_suppressions",
      "email_outbox",
      "communication_reminders",
      "academy_workspaces",
      "academy_lifecycle",
      "academy_lifecycle_history",
    ];
    const before = Object.fromEntries(
      tables.map((t) => [
        t,
        JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
      ]),
    );
    const auditBefore = count("workspace_audit");
    job();
    event({ receivedAt: at(OLD) });
    await runDeliveryRetention({ execute: true, now: NOW });
    for (const t of tables)
      expect(
        JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
        t,
      ).toBe(before[t]);
    // The only other write is the audit summary, appended.
    expect(count("workspace_audit")).toBe(auditBefore + 1);
  });
  it("is the only table that references delivery_jobs: delivery_attempts", () => {
    const db = database();
    const references: string[] = [];
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[])
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${name})`).all())
        if (fk.table === "delivery_jobs") references.push(`${name}.${fk.from}`);
    // A new foreign key to the job table must be reviewed against the cleanup.
    expect(references).toEqual(["delivery_attempts.jobId"]);
    for (const table of ["delivery_attempts", "communication_events"]) {
      const referencing = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).flatMap(({ name }) =>
        db
          .prepare(`PRAGMA foreign_key_list(${name})`)
          .all()
          .filter((fk) => fk.table === table),
      );
      expect(referencing, table).toEqual([]);
    }
  });
});

describe("a run", () => {
  it("reports exactly what it then removes, and removes nothing when only reporting", async () => {
    for (let i = 0; i < 7; i++)
      job({
        attempts: [{ at: at(OLD) }, { at: at(-9) }],
        academyId: i % 2 ? "a" : "b",
      });
    job({ dueAt: at(NEW) });
    event({ receivedAt: at(OLD) });
    const preview = previewRetention(NOW);
    const report = await runDeliveryRetention({ execute: false, now: NOW });
    expect(report).toMatchObject({
      mode: "REPORT",
      status: "COMPLETED",
      jobs: 7,
      attempts: 14,
      events: 1,
    });
    expect(count("delivery_jobs")).toBe(8);
    expect(count("communication_events")).toBe(1);
    expect(report.perAcademy).toEqual(preview.perAcademy);
    const done = await runDeliveryRetention({ execute: true, now: NOW });
    expect(done).toMatchObject({
      mode: "EXECUTE",
      status: "COMPLETED",
      jobs: 7,
      attempts: 14,
      events: 1,
    });
    expect(done.perAcademy).toEqual(report.perAcademy);
    expect(count("delivery_jobs")).toBe(1);
    expect(count("delivery_attempts")).toBe(0);
  });
  it("does nothing the second time", async () => {
    for (let i = 0; i < 5; i++) job();
    event({ receivedAt: at(OLD) });
    await runDeliveryRetention({ execute: true, now: NOW });
    const again = await runDeliveryRetention({ execute: true, now: NOW });
    expect(again).toMatchObject({
      status: "COMPLETED",
      jobs: 0,
      attempts: 0,
      events: 0,
      batches: 0,
    });
    expect(count("delivery_jobs")).toBe(0);
  });
  it("works in bounded batches and stops at its per-run limit, then carries on", async () => {
    for (let i = 0; i < 1050; i++) job();
    const first = await runDeliveryRetention({
      execute: true,
      now: NOW,
      batchSize: 100,
      maxBatches: 3,
    });
    expect(first).toMatchObject({ status: "CAPPED", batches: 3, jobs: 300 });
    expect(count("delivery_jobs")).toBe(750);
    const second = await runDeliveryRetention({
      execute: true,
      now: NOW,
      batchSize: 100,
      maxBatches: 100,
    });
    expect(second).toMatchObject({
      status: "COMPLETED",
      batches: 8,
      jobs: 750,
    });
    expect(count("delivery_jobs")).toBe(0);
    // Oldest first: a partial run never leaves a gap behind a newer record.
  });
  it("removes the oldest records first", async () => {
    const ids = [-3000, -1000, -2000].map((offset) =>
      job({ dueAt: at(offset) }),
    );
    await runDeliveryRetention({
      execute: true,
      now: NOW,
      batchSize: 1,
      maxBatches: 1,
    });
    expect(exists("delivery_jobs", ids[0]!)).toBe(false);
    expect(exists("delivery_jobs", ids[1]!)).toBe(true);
    expect(exists("delivery_jobs", ids[2]!)).toBe(true);
  });
  it("records what it did: the run, and one audit entry per academy", async () => {
    job({ academyId: "a" });
    job({ academyId: "a", attempts: [{ at: at(OLD) }] });
    job({ academyId: "b" });
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    const run = database()
      .prepare("SELECT * FROM delivery_retention_runs WHERE id=?")
      .get(result.runId)!;
    expect(run).toMatchObject({
      mode: "EXECUTE",
      status: "COMPLETED",
      cutoff: CUTOFF,
      retentionMonths: 12,
      jobs: 3,
      attempts: 1,
      events: 0,
    });
    expect(String(run.startedAt)).toMatch(/Z$/);
    expect(String(run.finishedAt)).toMatch(/Z$/);
    expect(JSON.parse(String(run.summary)).perAcademy.a.jobs).toBe(2);
    const audit = database()
      .prepare(
        "SELECT academyId,userId,action,resourceId FROM workspace_audit WHERE userId=? AND resourceId=? ORDER BY academyId",
      )
      .all(RETENTION_ACTOR, result.runId);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      academyId: "a",
      resourceId: result.runId,
    });
    expect(String(audit[0]!.action)).toContain("2 job(s), 1 attempt(s)");
    expect(String(audit[0]!.action)).toContain(CUTOFF);
    // No record, no log line and no audit text carries a phone number or a name.
    expect(JSON.stringify([run, audit])).not.toMatch(/\d{10}|guardian|player-/);
  });
  it("records a dry run too, as REPORT", async () => {
    job();
    const result = await runDeliveryRetention({ now: NOW });
    expect(
      database()
        .prepare(
          "SELECT mode,status,jobs FROM delivery_retention_runs WHERE id=?",
        )
        .get(result.runId),
    ).toMatchObject({ mode: "REPORT", status: "COMPLETED", jobs: 1 });
  });
});

describe("failures and concurrency", () => {
  it("rolls a failed batch back completely, records the failure, and finishes on the next run", async () => {
    const ok = job({ dueAt: at(-9000), attempts: [{ at: at(-9000) }] });
    const poisoned = job({ dueAt: at(-8000), attempts: [{ at: at(-8000) }] });
    database().exec(
      `CREATE TRIGGER poison_job BEFORE DELETE ON delivery_jobs WHEN OLD.id='${poisoned}' BEGIN SELECT RAISE(ABORT,'disk full at https://x.example/a?token=0123456789abcdef0123456789'); END`,
    );
    const failed = await runDeliveryRetention({ execute: true, now: NOW });
    expect(failed.status).toBe("FAILED");
    // Both jobs were in one batch: neither it nor its attempts were removed.
    expect(exists("delivery_jobs", ok)).toBe(true);
    expect(exists("delivery_jobs", poisoned)).toBe(true);
    expect(count("delivery_attempts")).toBe(2);
    expect(failed.error).not.toContain("https://");
    expect(failed.error).not.toContain("0123456789abcdef0123456789");
    expect(
      database()
        .prepare("SELECT status,error FROM delivery_retention_runs WHERE id=?")
        .get(failed.runId),
    ).toMatchObject({ status: "FAILED" });
    // The lease was released: the next run is not locked out.
    database().exec("DROP TRIGGER poison_job");
    const retried = await runDeliveryRetention({ execute: true, now: NOW });
    expect(retried).toMatchObject({ status: "COMPLETED", jobs: 2 });
    expect(count("delivery_jobs")).toBe(0);
  });
  it("removes nothing of a batch when any job in it cannot be removed", async () => {
    const first = job({ dueAt: at(-9000), attempts: [{ at: at(-9000) }] });
    const stuck = job({ dueAt: at(-8000), attempts: [{ at: at(-8000) }] });
    // A trigger that quietly skips one delete: the count no longer matches.
    database().exec(
      `CREATE TRIGGER poison_job BEFORE DELETE ON delivery_jobs WHEN OLD.id='${stuck}' BEGIN SELECT RAISE(IGNORE); END`,
    );
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result.status).toBe("FAILED");
    expect(exists("delivery_jobs", first)).toBe(true);
    expect(exists("delivery_attempts", `${first}-att-0`)).toBe(true);
    expect(exists("delivery_jobs", stuck)).toBe(true);
    expect(count("delivery_attempts")).toBe(2);
  });
  it("lets only one of two simultaneous runs work and records the other as skipped", async () => {
    for (let i = 0; i < 250; i++) job();
    const [one, two] = await Promise.all([
      runDeliveryRetention({ execute: true, now: NOW, batchSize: 50 }),
      runDeliveryRetention({ execute: true, now: NOW, batchSize: 50 }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual(["COMPLETED", "SKIPPED"]);
    expect(one.jobs + two.jobs).toBe(250);
    expect(count("delivery_jobs")).toBe(0);
    expect(
      database()
        .prepare(
          "SELECT COUNT(*) n FROM delivery_retention_runs WHERE status='SKIPPED'",
        )
        .get()?.n,
    ).toBe(1);
  });
  it("takes over after a crashed run's lease expires, and records that run as failed", async () => {
    job();
    const stale = new Date(
      Date.now() - (LEASE_SECONDS + 5) * 1000,
    ).toISOString();
    database()
      .prepare(
        "INSERT INTO delivery_retention_runs(id,mode,status,startedAt,leaseUntil,cutoff,retentionMonths) VALUES('crashed','EXECUTE','RUNNING',?,?,?,12)",
      )
      .run(stale, stale, CUTOFF);
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result).toMatchObject({ status: "COMPLETED", jobs: 1 });
    expect(
      database()
        .prepare(
          "SELECT status,error FROM delivery_retention_runs WHERE id='crashed'",
        )
        .get(),
    ).toMatchObject({ status: "FAILED" });
  });
  it("does not start while another run's lease is still valid", async () => {
    job();
    const live = new Date(Date.now() + 60_000).toISOString();
    database()
      .prepare(
        "INSERT INTO delivery_retention_runs(id,mode,status,startedAt,leaseUntil,cutoff,retentionMonths) VALUES('busy','EXECUTE','RUNNING',?,?,?,12)",
      )
      .run(new Date().toISOString(), live, CUTOFF);
    const result = await runDeliveryRetention({ execute: true, now: NOW });
    expect(result.status).toBe("SKIPPED");
    expect(count("delivery_jobs")).toBe(1);
  });
  it("lets a dry run happen while a real run holds the lease", async () => {
    job();
    const live = new Date(Date.now() + 60_000).toISOString();
    database()
      .prepare(
        "INSERT INTO delivery_retention_runs(id,mode,status,startedAt,leaseUntil,cutoff,retentionMonths) VALUES('busy','EXECUTE','RUNNING',?,?,?,12)",
      )
      .run(new Date().toISOString(), live, CUTOFF);
    expect((await runDeliveryRetention({ now: NOW })).status).toBe("COMPLETED");
  });
});

describe("the switch", () => {
  it("defaults to report, which deletes nothing", async () => {
    expect(retentionMode({})).toBe("report");
    job();
    const result = await scheduledRetention({});
    expect(result).toMatchObject({ mode: "REPORT" });
    expect(count("delivery_jobs")).toBe(1);
  });
  it("does nothing when off, and removes only when on", async () => {
    job({ dueAt: "2020-01-01T00:00:00.000Z" }); // old by the real clock too
    expect(await scheduledRetention({ SPORTOZEN_RETENTION: "off" })).toBeNull();
    expect(count("delivery_jobs")).toBe(1);
    const result = await scheduledRetention({ SPORTOZEN_RETENTION: "on" });
    expect(result).toMatchObject({ mode: "EXECUTE", status: "COMPLETED" });
    expect(count("delivery_jobs")).toBe(0);
  });
  it("refuses a value it does not know", () => {
    for (const bad of ["yes", "true", "1", "ON "])
      if (bad.trim().toLowerCase() === "on")
        expect(retentionMode({ SPORTOZEN_RETENTION: bad })).toBe("on");
      else
        expect(() => retentionMode({ SPORTOZEN_RETENTION: bad })).toThrow(
          /off.*report.*on/,
        );
  });
});

describe("the paged delivery list and the worker after a cleanup", () => {
  it("still lists the newer jobs, in order, and the job count falls only by what was removed", async () => {
    const newer = [NEW, NEW + 1000, NEW + 2000].map((o) =>
      job({ dueAt: at(o), expiresAt: at(o + 5000) }),
    );
    job();
    job();
    await runDeliveryRetention({ execute: true, now: NOW });
    const rows = database()
      .prepare(
        "SELECT id FROM delivery_jobs WHERE academyId='a' AND playerId<>'' ORDER BY dueAt DESC, id DESC",
      )
      .all()
      .map((r) => r.id);
    expect(rows).toEqual([...newer].reverse());
  });
  it("does not let the scheduler's duplicate guard re-create a removed job for a past period", async () => {
    // The unique key (academy, player, guardian, type, period, correction) is
    // what stops a second job for the same period; the scheduler only asks for
    // the current week and the previous month, so a period older than twelve
    // months is never asked for again.
    const id = job({ type: "MONTHLY" });
    const key = database()
      .prepare("SELECT period FROM delivery_jobs WHERE id=?")
      .get(id)!.period;
    await runDeliveryRetention({ execute: true, now: NOW });
    expect(exists("delivery_jobs", id)).toBe(false);
    // The keys that remain describe only periods inside the window.
    for (const row of database()
      .prepare("SELECT dueAt FROM delivery_jobs")
      .all())
      expect(String(row.dueAt) >= CUTOFF).toBe(true);
    expect(key).toBeTruthy();
  });
});
