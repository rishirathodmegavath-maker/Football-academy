// Phase 5: migration 011 adds indexes for the communication tables that only
// grow. These tests prove the queries use them, that the migration is
// idempotent and reversible without touching a row, and that the announcement
// job read returns exactly what the old "load every job, then filter" did.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
import { database } from "@/server/database";
import { migrateCommunicationIndexes } from "@/server/migrations/011-communication-indexes";
import { communicationRepository as comm } from "@/server/communication-repository";

const filename = join(
  tmpdir(),
  `sportozen-comm-indexes-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const INDEXES = [
  "delivery_jobs_due",
  "delivery_jobs_announcements",
  "delivery_attempts_job",
  "communication_events_pending",
  "communication_events_academy",
];
const plan = (sql: string, ...args: string[]) =>
  database()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String(row.detail))
    .join(" | ");
const present = () =>
  database()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?",
    )
    .all("%")
    .map((row) => String(row.name));
const counts = () =>
  Object.fromEntries(
    ["delivery_jobs", "delivery_attempts", "communication_events"].map((t) => [
      t,
      Number(database().prepare(`SELECT COUNT(*) n FROM ${t}`).get()!.n),
    ]),
  );

beforeAll(() => {
  const db = database();
  db.prepare("INSERT INTO academy_workspaces VALUES('a','{}')").run();
  db.prepare("INSERT INTO academy_workspaces VALUES('b','{}')").run();
  const job = db.prepare(
    "INSERT INTO delivery_jobs(id,academyId,playerId,guardianId,type,sourceId,sourceVersion,period,correction,dueAt,expiresAt,state,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)",
  );
  for (let i = 0; i < 200; i++)
    job.run(
      `j${i}`,
      i % 5 === 0 ? "b" : "a",
      i % 7 === 0 ? "" : `p${i}`,
      `g${i}`,
      i % 4 === 0 ? "ANNOUNCEMENT" : i % 2 ? "WEEKLY" : "MONTHLY",
      i % 4 === 0 ? `ann${i % 8}` : `s${i}`,
      1,
      `period${i}`,
      "",
      `2026-01-${String((i % 27) + 1).padStart(2, "0")}T08:00:00.000Z`,
      "2027-01-01T00:00:00.000Z",
      i < 150 ? "SENT" : "QUEUED",
    );
  const attempt = db.prepare(
    "INSERT INTO delivery_attempts(id,jobId,at,state) VALUES(?,?,?,?)",
  );
  for (let i = 0; i < 200; i++)
    attempt.run(`at${i}`, `j${i}`, "2026-01-01T00:00:00.000Z", "SENT");
  const event = db.prepare(
    "INSERT INTO communication_events(id,academyId,phoneNumberId,body,receivedAt,processedAt,outcome) VALUES(?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 50; i++)
    event.run(
      `e${i}`,
      "a",
      "n",
      "{}",
      `2026-02-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
      i < 40 ? "2026-02-28T00:00:00.000Z" : null,
      i < 40 ? "OK" : "AMBIGUOUS_CHILD",
    );
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

describe("migration 011: communication indexes", () => {
  it("creates every index when the database is opened", () => {
    for (const name of INDEXES) expect(present(), name).toContain(name);
  });
  it("lets the worker poll, the weekly-queue read and the attempt lookup use an index instead of scanning", () => {
    expect(
      plan(
        "SELECT * FROM delivery_jobs WHERE state='QUEUED' AND claim IS NULL AND dueAt<=? AND expiresAt>? ORDER BY dueAt LIMIT 1",
        "2030",
        "2020",
      ),
    ).toMatch(/USING INDEX delivery_jobs_due/);
    expect(
      plan(
        "SELECT * FROM delivery_jobs WHERE type='WEEKLY' AND state='QUEUED' AND claim IS NULL",
      ),
    ).toMatch(/USING INDEX delivery_jobs_due/);
    expect(
      plan(
        "SELECT metadata FROM delivery_attempts WHERE jobId=? AND (providerId=? OR state='UNKNOWN') ORDER BY at DESC LIMIT 1",
        "j1",
        "x",
      ),
    ).toMatch(/USING INDEX delivery_attempts_job/);
    expect(
      plan(
        "SELECT * FROM communication_events WHERE processedAt IS NULL ORDER BY receivedAt LIMIT 100",
      ),
    ).toMatch(/USING INDEX communication_events_pending/);
    expect(
      plan(
        "SELECT id FROM communication_events WHERE academyId=? AND outcome IN ('AMBIGUOUS_CHILD','UNKNOWN_CONTACT')",
        "a",
      ),
    ).toMatch(/USING INDEX communication_events_academy/);
    expect(
      plan(
        "SELECT * FROM delivery_jobs WHERE academyId=? AND type='ANNOUNCEMENT' ORDER BY dueAt DESC",
        "a",
      ),
    ).toMatch(/USING INDEX delivery_jobs_announcements/);
    // The sort is served by the index too: no temporary b-tree for ORDER BY.
    expect(
      plan(
        "SELECT * FROM delivery_jobs WHERE academyId=? AND type='ANNOUNCEMENT' ORDER BY dueAt DESC",
        "a",
      ),
    ).not.toMatch(/TEMP B-TREE/);
  });
  it("is idempotent and reversible, and never changes a row", () => {
    const before = counts();
    migrateCommunicationIndexes(database());
    migrateCommunicationIndexes(database());
    expect(counts()).toEqual(before);
    // Reverse it as documented, then bring it forward again.
    for (const name of INDEXES) database().exec(`DROP INDEX ${name}`);
    for (const name of INDEXES) expect(present()).not.toContain(name);
    expect(counts()).toEqual(before);
    migrateCommunicationIndexes(database());
    for (const name of INDEXES) expect(present()).toContain(name);
    expect(counts()).toEqual(before);
    expect(
      database().prepare("PRAGMA integrity_check").get()!.integrity_check,
    ).toBe("ok");
  });
  it("announcementJobs returns exactly the jobs that loading every job and filtering did, newest due first", () => {
    const byId = <T extends { id: string }>(jobs: T[]) =>
      [...jobs].sort((a, b) => a.id.localeCompare(b.id));
    const newestFirst = (jobs: { dueAt: string }[]) =>
      jobs.every((job, i) => i === 0 || jobs[i - 1].dueAt >= job.dueAt);
    for (const academy of ["a", "b"]) {
      const old = comm.jobs(academy).filter((j) => j.type === "ANNOUNCEMENT");
      expect(old.length).toBeGreaterThan(0);
      const now = comm.announcementJobs(academy);
      expect(byId(now)).toEqual(byId(old));
      expect(newestFirst(now)).toBe(true);
      for (const source of new Set(old.map((j) => j.sourceId))) {
        const one = comm.announcementJobs(academy, source);
        expect(byId(one)).toEqual(
          byId(old.filter((j) => j.sourceId === source)),
        );
        expect(newestFirst(one)).toBe(true);
      }
    }
    expect(comm.announcementJobs("a", "no-such-announcement")).toEqual([]);
    // Another academy's announcement jobs never appear.
    expect(
      comm.announcementJobs("a").every((job) => job.academyId === "a"),
    ).toBe(true);
  });
});
