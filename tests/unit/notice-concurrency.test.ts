// Cancellation notices under real concurrency: several separate processes act on
// the same database file at the same instant. SQLite serialises the writers, so
// exactly one cancellation wins and every guardian gets exactly one notice.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
vi.mock("@/server/email/outbox", async (original) => ({
  ...(await original<typeof import("@/server/email/outbox")>()),
  kickOutbox: vi.fn(),
}));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { trainingAction } from "@/server/training-service";
import { A, ids, contextFor, seedApiFixture } from "./helpers/api-harness";
import type { FootballSeries } from "@/domain/training";

const filename = join(tmpdir(), `sportozen-race-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const PROCESSES = 4;

type Outcome = { ok: boolean; status?: number; message?: string };
function child(args: string[], startAt: number): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "tests/unit/helpers/cancel-race.ts",
        ...args,
        String(startAt),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SPORTOZEN_DATABASE_PATH: filename,
          SPORTOZEN_EMAIL_TRANSPORT: "capture",
          SPORTOZEN_EMAIL_FROM:
            "Sportozen <notifications@academy.sportozen.app>",
          BETTER_AUTH_URL: "http://127.0.0.1:3000",
          NODE_ENV: "test",
          NODE_NO_WARNINGS: "1",
        },
      },
    );
    let out = "",
      err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", () => {
      const line = out.trim().split("\n").filter(Boolean).at(-1);
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        reject(
          new Error(`child gave no result. stdout: ${out} stderr: ${err}`),
        );
      }
    });
  });
}
/** Starts `PROCESSES` children together; the barrier outlasts their start-up. */
async function race(make: (i: number) => string[]) {
  const startAt = Date.now() + 9000;
  return Promise.all(
    Array.from({ length: PROCESSES }, (_, i) =>
      child([...make(i)], startAt).then((o) => o),
    ),
  );
}
const mail = (related: string) =>
  database()
    .prepare(
      "SELECT toAddress,relatedId FROM email_outbox WHERE relatedId=? ORDER BY toAddress",
    )
    .all(related);

beforeAll(() => {
  process.env.SPORTOZEN_EMAIL_TRANSPORT = "capture";
  process.env.SPORTOZEN_EMAIL_FROM =
    "Sportozen <notifications@academy.sportozen.app>";
  seedApiFixture();
  database().exec('ALTER TABLE "user" ADD COLUMN email TEXT');
  for (const id of [ids.parent1, ids.parent2, ids.ownerA])
    database()
      .prepare('UPDATE "user" SET email=? WHERE id=?')
      .run(`${id}@example.test`, id);
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

/** A Tuesday at least `days` days from now, as YYYY-MM-DD. Relative to the real
 * clock, because the child processes use the real clock too. */
function tuesday(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const plusDays = (date: string, n: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

function makeSeries(startDate: string, endDate: string, id: string) {
  const drillId = repo.list(A, "drill")[0].id;
  return trainingAction(contextFor("ownerA"), {
    requestId: randomUUID(),
    action: "series",
    id,
    data: {
      branchId: ids.branch,
      squadId: ids.squadA,
      venueId: ids.venue,
      location: "Synthetic pitch",
      coachIds: [ids.coachA],
      timezone: "Asia/Kolkata",
      weekdays: [2],
      startDate,
      endDate,
      startTime: "17:00",
      endTime: "18:00",
      theme: "Receiving",
      agenda: [{ drillId, duration: 30 }],
      exclusions: [],
    },
  }) as FootballSeries;
}

describe("simultaneous cancellations from separate processes", () => {
  it("one cancellation of the same session wins and each guardian is told once", async () => {
    const day = tuesday(40);
    const series = makeSeries(day, day, "race-single");
    const session = repo.find(A, "session", `${series.id}:${day}`)!;
    const results = await race(() => [
      A,
      ids.ownerA,
      "status",
      session.id,
      String(session.version),
      JSON.stringify({ status: "CANCELLED", reason: "Pitch flooded" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok))
      expect(loser.status).toBe(409);
    expect(repo.find(A, "session", session.id)?.status).toBe("CANCELLED");
    const rows = mail(`session-cancel:${session.id}`);
    expect(rows.map((r) => r.toAddress)).toEqual([
      `${ids.parent1}@example.test`,
      `${ids.parent2}@example.test`,
    ]);
  }, 120_000);

  it("one cancellation of the same series wins and each guardian gets one summary", async () => {
    const first = tuesday(80);
    const series = makeSeries(first, plusDays(first, 28), "race-series");
    expect(
      repo.list(A, "session").filter((s) => s.seriesId === series.id),
    ).toHaveLength(5);
    const results = await race(() => [
      A,
      ids.ownerA,
      "seriesCancel",
      series.id,
      "1",
      JSON.stringify({ reason: "Term cancelled" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.ok))
      expect(loser.status).toBe(409);
    const sessions = repo
      .list(A, "session")
      .filter((s) => s.seriesId === series.id);
    expect(sessions.every((s) => s.status === "CANCELLED")).toBe(true);
    const rows = mail(`series-cancel:${series.id}`);
    expect(rows).toHaveLength(2); // one per guardian, not per date, not per process
    expect(repo.find(A, "series", series.id)).toMatchObject({
      status: "CANCELLED",
      version: 2,
    });
    // No individual per-date notices were sent for the series cancellation.
    const perDate = database()
      .prepare("SELECT COUNT(*) n FROM email_outbox WHERE relatedId LIKE ?")
      .get(`session-cancel:${series.id}:%`)?.n;
    expect(perDate).toBe(0);
  }, 120_000);

  it("a date cancelled while its series is cancelled is announced exactly once, whichever runs first", async () => {
    const day = tuesday(120);
    const series = makeSeries(day, plusDays(day, 14), "race-mixed");
    const [first] = repo
      .list(A, "session")
      .filter((s) => s.seriesId === series.id)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(
      repo.list(A, "session").filter((s) => s.seriesId === series.id),
    ).toHaveLength(3);
    const startAt = Date.now() + 9000;
    const results = await Promise.all([
      child(
        [
          A,
          ids.ownerA,
          "status",
          first.id,
          String(first.version),
          JSON.stringify({ status: "CANCELLED", reason: "Rain" }),
        ],
        startAt,
      ),
      child(
        [
          A,
          ids.ownerA,
          "seriesCancel",
          series.id,
          "1",
          JSON.stringify({ reason: "Term cancelled" }),
        ],
        startAt,
      ),
      child(
        [
          A,
          ids.adminA,
          "seriesCancel",
          series.id,
          "1",
          JSON.stringify({ reason: "Term cancelled again" }),
        ],
        startAt,
      ),
    ]);
    expect(
      repo
        .list(A, "session")
        .filter((s) => s.seriesId === series.id)
        .every((s) => s.status === "CANCELLED"),
    ).toBe(true);
    expect(repo.find(A, "series", series.id)).toMatchObject({
      status: "CANCELLED",
      version: 2,
    });
    // Exactly one of the two series cancellations won; any losers were refused cleanly.
    expect(results.slice(1).filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) expect(r.status).toBe(409);
    const single = mail(`session-cancel:${first.id}`),
      summary = database()
        .prepare(
          "SELECT toAddress,subject FROM email_outbox WHERE relatedId=? ORDER BY toAddress",
        )
        .all(`series-cancel:${series.id}`);
    expect(summary).toHaveLength(2); // one summary per guardian
    if (single.length) {
      // The single cancellation ran first: its date is not announced again.
      expect(single).toHaveLength(2);
      expect(String(summary[0].subject)).toMatch(/2 sessions/);
    } else {
      // The series ran first and covered all three dates in one summary.
      expect(String(summary[0].subject)).toMatch(/3 sessions/);
    }
  }, 120_000);
});
