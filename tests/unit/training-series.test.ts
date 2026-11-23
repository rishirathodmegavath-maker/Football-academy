// Phase 9: recurring sessions, cancellation notices and the parent schedule.
// Real services against the two-academy fixture; only the session lookup is
// replaced. Time is pinned (Date only) so the dates stay valid whenever this runs.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
// Deliveries are driven by hand so a test can read a message before it is sent.
vi.mock("@/server/email/outbox", async (original) => ({
  ...(await original<typeof import("@/server/email/outbox")>()),
  kickOutbox: vi.fn(),
}));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { trainingAction } from "@/server/training-service";
import { parentSchedule } from "@/server/parent-schedule-service";
import { visibleRecords } from "@/server/workspace-access";
import { notifySessionCancelled } from "@/server/session-notices";
import { enqueueEmail, processOutbox } from "@/server/email/outbox";
import { captured, resetCapture } from "@/server/email/transport";
import { workspace } from "@/server/workspace-service";
import { checkDataIntegrity } from "@/server/data-integrity";
import * as trainingRoute from "@/app/api/workspaces/[academyId]/training/route";
import type {
  FootballSeries,
  FootballSession,
  SeriesPreview,
} from "@/domain/training";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  countQueries,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-series-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const NOW = "2026-12-20T00:00:00.000Z";
const MAIL = {
  SPORTOZEN_EMAIL_TRANSPORT: "capture",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
};
let drillId = "";
let extraBranch = "";

beforeAll(() => {
  Object.assign(process.env, MAIL);
  seedApiFixture();
  const db = database();
  db.exec('ALTER TABLE "user" ADD COLUMN email TEXT');
  for (const persona of Object.keys(ids) as Persona[])
    if (typeof ids[persona as keyof typeof ids] === "string")
      db.prepare('UPDATE "user" SET email=? WHERE id=?').run(
        `${ids[persona as keyof typeof ids]}@example.test`,
        ids[persona as keyof typeof ids],
      );
  drillId = repo.list(A, "drill")[0].id;
  // A second branch in a zone with clock changes, with its own venue and squad.
  extraBranch = "branch-london";
  const stamp = { version: 1, updatedAt: NOW, updatedBy: ids.ownerA };
  repo.save(A, "branch", {
    id: extraBranch,
    academyId: A,
    name: "London ground",
    timezone: "Europe/London",
  } as never);
  repo.save(A, "venue", {
    id: "venue-london",
    academyId: A,
    sportId: "football",
    ...stamp,
    name: "London pitch",
    branchId: extraBranch,
    location: "London",
  });
  repo.save(A, "squad", {
    id: "squad-london",
    academyId: A,
    sportId: "football",
    ...stamp,
    name: "London batch",
    branchId: extraBranch,
    playerIds: [ids.p1, ids.p2],
  });
});
afterAll(() => {
  vi.useRealTimers();
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  Object.assign(process.env, MAIL);
  resetCapture();
  const db = database();
  // Each test starts from "no series, no outbox" over the same fixture.
  db.exec("DELETE FROM email_outbox");
  const mine =
    "kind='session' AND (json_extract(body,'$.seriesId') IS NOT NULL OR id LIKE 'extra-%')";
  db.prepare(
    `DELETE FROM workspace_records WHERE academyId=? AND kind='attendance' AND json_extract(body,'$.sessionId') IN (SELECT id FROM workspace_records WHERE academyId=? AND ${mine})`,
  ).run(A, A);
  db.prepare(
    `DELETE FROM workspace_records WHERE academyId=? AND (kind IN ('series','wrapup') OR (${mine}))`,
  ).run(A);
  db.exec("DELETE FROM training_submissions");
  // training_history is append-only by design; every test uses fresh ids.
  db.prepare("UPDATE academy_memberships SET active=1 WHERE academyId=?").run(
    A,
  );
  db.prepare(
    "DELETE FROM guardian_relationships WHERE academyId=? AND userId=? AND playerId=?",
  ).run(A, ids.parent1, ids.p2);
});

const act = (
  who: Persona,
  action: string,
  data: unknown = {},
  extra: { id?: string; expectedVersion?: number; requestId?: string } = {},
) =>
  trainingAction(contextFor(who), {
    requestId: extra.requestId ?? randomUUID(),
    action,
    data,
    ...(extra.id ? { id: extra.id } : {}),
    ...(extra.expectedVersion !== undefined
      ? { expectedVersion: extra.expectedVersion }
      : {}),
  });
const seriesData = (over: Record<string, unknown> = {}) => ({
  branchId: ids.branch,
  squadId: ids.squadA,
  venueId: ids.venue,
  location: "Synthetic pitch",
  coachIds: [ids.coachA],
  timezone: "Asia/Kolkata",
  weekdays: [1, 3],
  startDate: "2027-01-04",
  endDate: "2027-01-17",
  startTime: "17:00",
  endTime: "18:00",
  theme: "Receiving",
  agenda: [{ drillId, duration: 30 }],
  exclusions: [],
  ...over,
});
const create = (
  who: Persona,
  over: Record<string, unknown> = {},
  id: string = randomUUID(),
) => act(who, "series", seriesData(over), { id }) as FootballSeries;
const occurrences = (seriesId: string) =>
  repo
    .list(A, "session")
    .filter((s) => s.seriesId === seriesId)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
const seriesRows = () => repo.list(A, "series");
/** Input the schema itself refuses (before any business rule runs). */
const invalid = async (fn: () => unknown) => {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect((error as { name?: string } | undefined)?.name).toBe("ZodError");
};
const rejects = async (fn: () => unknown, status: number, message?: RegExp) => {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error, "expected a refusal").toBeDefined();
  expect((error as { status?: number }).status).toBe(status);
  if (message) expect((error as Error).message).toMatch(message);
};
const mailTo = (address: string, related = "%") =>
  database()
    .prepare(
      "SELECT toAddress,status,nextAttemptAt,subject,textBody,relatedId FROM email_outbox WHERE toAddress=? AND relatedId LIKE ? ORDER BY rowid",
    )
    .all(address, related);
const addr = (id: string) => `${id}@example.test`;
const linkParent1ToBoth = () =>
  database()
    .prepare(
      "INSERT OR IGNORE INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)",
    )
    .run(A, ids.parent1, ids.p2);

describe("creating a series", () => {
  it("makes one scheduled session per matching date, with the roster and attendance", () => {
    const series = create("ownerA");
    expect(series).toMatchObject({
      status: "ACTIVE",
      version: 1,
      weekdays: [1, 3],
      skipped: [],
    });
    const sessions = occurrences(series.id);
    expect(sessions.map((s) => s.id)).toEqual([
      `${series.id}:2027-01-04`,
      `${series.id}:2027-01-06`,
      `${series.id}:2027-01-11`,
      `${series.id}:2027-01-13`,
    ]);
    expect(sessions[0]).toMatchObject({
      status: "SCHEDULED",
      seriesId: series.id,
      occurrenceDate: "2027-01-04",
      startLocal: "2027-01-04T17:00",
      startAt: "2027-01-04T11:30:00.000Z",
      endAt: "2027-01-04T12:30:00.000Z",
      squadId: ids.squadA,
      coachIds: [ids.coachA],
    });
    expect(sessions[0].roster.map((p) => p.playerId)).toEqual([ids.p1, ids.p2]);
    expect(sessions[0].agenda).toHaveLength(1);
    const marks = repo
      .list(A, "attendance")
      .filter((m) => m.sessionId === sessions[0].id);
    expect(marks.map((m) => m.status)).toEqual(["UNMARKED", "UNMARKED"]);
  });

  it("is safe to submit twice with the same request key", () => {
    const requestId = randomUUID(),
      id = randomUUID();
    const first = act("ownerA", "series", seriesData(), { id, requestId }),
      again = act("ownerA", "series", seriesData(), { id, requestId });
    expect(again).toEqual(first);
    expect(occurrences(id)).toHaveLength(4);
    expect(seriesRows()).toHaveLength(1);
  });

  it("refuses a second series with the same id instead of duplicating sessions", async () => {
    const series = create("ownerA");
    await rejects(() => create("ownerA", {}, series.id), 409, /already exists/);
    expect(occurrences(series.id)).toHaveLength(4);
  });

  it("processing the series again adds nothing, however many times", () => {
    const series = create("ownerA");
    const before = repo.list(A, "session").length;
    const one = act(
      "ownerA",
      "seriesSync",
      {},
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    const two = act(
      "ownerA",
      "seriesSync",
      {},
      { id: series.id, expectedVersion: one.version },
    ) as FootballSeries;
    expect(repo.list(A, "session")).toHaveLength(before);
    expect(occurrences(series.id)).toHaveLength(4);
    expect(two.version).toBe(3);
  });

  it("does not let two stale processors both write", async () => {
    const series = create("ownerA");
    act("ownerA", "seriesSync", {}, { id: series.id, expectedVersion: 1 });
    await rejects(
      () =>
        act("ownerA", "seriesSync", {}, { id: series.id, expectedVersion: 1 }),
      409,
    );
    expect(occurrences(series.id)).toHaveLength(4);
  });

  it("skips holidays and reports them", () => {
    const series = create("ownerA", {
      exclusions: [{ date: "2027-01-06", label: "Republic Day week" }],
    });
    expect(occurrences(series.id).map((s) => s.occurrenceDate)).toEqual([
      "2027-01-04",
      "2027-01-11",
      "2027-01-13",
    ]);
    expect(series.skipped).toEqual([
      { date: "2027-01-06", reason: "EXCLUDED", detail: "Republic Day week" },
    ]);
  });

  it("skips dates that have already started", () => {
    vi.setSystemTime(new Date("2027-01-06T12:00:00Z")); // after 17:00 IST on the 6th
    const series = create("ownerA");
    expect(occurrences(series.id).map((s) => s.occurrenceDate)).toEqual([
      "2027-01-11",
      "2027-01-13",
    ]);
    expect(series.skipped.map((s) => [s.date, s.reason])).toEqual([
      ["2027-01-04", "PAST"],
      ["2027-01-06", "PAST"],
    ]);
  });

  it("skips a conflicting date, shows why, and creates it once the clash clears", () => {
    // A coach clash on Wednesday the 6th.
    const clash = repo.list(A, "session")[0];
    const blocker: FootballSession = {
      ...clash,
      id: "extra-blocker",
      status: "SCHEDULED",
      coachIds: [ids.coachA],
      roster: [{ playerId: ids.p3, name: "x" }],
      squadId: ids.squadB,
      venueId: undefined,
      location: "Elsewhere",
      startLocal: "2027-01-06T17:30",
      endLocal: "2027-01-06T18:30",
      startAt: "2027-01-06T12:00:00.000Z",
      endAt: "2027-01-06T13:00:00.000Z",
    };
    repo.save(A, "session", blocker);
    const series = create("ownerA");
    expect(occurrences(series.id).map((s) => s.occurrenceDate)).toEqual([
      "2027-01-04",
      "2027-01-11",
      "2027-01-13",
    ]);
    expect(series.skipped).toHaveLength(1);
    expect(series.skipped[0]).toMatchObject({
      date: "2027-01-06",
      reason: "CONFLICT",
    });
    expect(series.skipped[0].detail).toMatch(/coach/);
    // Clear the clash; processing again creates exactly the missing date.
    repo.save(A, "session", { ...blocker, status: "CANCELLED" });
    const synced = act(
      "ownerA",
      "seriesSync",
      {},
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(occurrences(series.id)).toHaveLength(4);
    expect(synced.skipped).toEqual([]);
  });

  it("creates nothing, and says why, when no date can be scheduled", async () => {
    await rejects(
      () =>
        create("ownerA", {
          startDate: "2027-01-04",
          endDate: "2027-01-04",
          exclusions: [{ date: "2027-01-04", label: "Holiday" }],
        }),
      409,
      /No session can be scheduled.*1 holiday/,
    );
    expect(seriesRows()).toHaveLength(0);
  });

  it("enforces the 26-week and 60-session limits and unusable rules", async () => {
    await rejects(
      () => create("ownerA", { weekdays: [1], endDate: "2027-07-05" }),
      400,
      /26 weeks/,
    );
    await rejects(
      () =>
        create("ownerA", {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startDate: "2027-01-01",
          endDate: "2027-03-02",
        }),
      400,
      /at most 60/,
    );
    await rejects(
      () => create("ownerA", { endDate: "2027-01-03" }),
      400,
      /before the start/,
    );
    await rejects(
      () => create("ownerA", { startTime: "18:00", endTime: "17:00" }),
      400,
      /end after it starts/,
    );
    await invalid(() => create("ownerA", { weekdays: [] }));
    expect(seriesRows()).toHaveLength(0);
  });

  it("applies the existing booking rules: coach, location and drill length", async () => {
    await rejects(() => create("ownerA", { coachIds: [] }), 400, /coach/i);
    await rejects(
      () => create("ownerA", { venueId: undefined, location: "" }),
      400,
      /venue or record a training location/,
    );
    await rejects(
      () => create("ownerA", { agenda: [{ drillId, duration: 90 }] }),
      400,
      /Drill durations exceed/,
    );
    await rejects(
      () => create("ownerA", { timezone: "Europe/London" }),
      400,
      /branch time zone/,
    );
    expect(seriesRows()).toHaveLength(0);
  });

  it("a second series cannot double-book the coach, squad and pitch of the first", async () => {
    const first = create("ownerA");
    await rejects(
      () => create("ownerA", { weekdays: [1] }),
      409,
      /No session can be scheduled.*2 conflicting/,
    );
    expect(occurrences(first.id)).toHaveLength(4);
    expect(seriesRows()).toHaveLength(1);
  });
  it("books around a clash: the free weekday is created, the clashing one is skipped", () => {
    const first = create("ownerA", { weekdays: [1] });
    const second = create("ownerA", { weekdays: [1, 2] });
    expect(occurrences(first.id)).toHaveLength(2);
    expect(occurrences(second.id).map((s) => s.occurrenceDate)).toEqual([
      "2027-01-05",
      "2027-01-12",
    ]);
    expect(
      second.skipped.filter((s) => s.reason === "CONFLICT").map((s) => s.date),
    ).toEqual(["2027-01-04", "2027-01-11"]);
  });
});

describe("a full-size series", () => {
  it("previews and creates 60 sessions quickly, in one transaction, with a bounded number of statements", async () => {
    const data = seriesData({
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startDate: "2027-01-01",
      endDate: "2027-03-01",
    });
    const owner = contextFor("ownerA");
    const t0 = performance.now();
    const preview = trainingAction(owner, {
      requestId: randomUUID(),
      action: "seriesPreview",
      data,
    }) as unknown as SeriesPreview;
    expect(preview.occurrences).toHaveLength(60);
    const { result, queries } = await countQueries(() =>
      trainingAction(owner, {
        requestId: randomUUID(),
        action: "series",
        id: "full-size",
        data,
      }),
    );
    const elapsed = performance.now() - t0;
    expect((result as FootballSeries).skipped).toEqual([]);
    expect(occurrences("full-size")).toHaveLength(60);
    // 60 sessions + 120 attendance records, each with its history row: linear in the series.
    expect(queries).toBeLessThan(1500);
    // Was several seconds when each date resolved its time by trying every offset.
    expect(elapsed).toBeLessThan(2500);
  });
});

describe("clock changes (Europe/London)", () => {
  const london = (over: Record<string, unknown> = {}) =>
    seriesData({
      branchId: extraBranch,
      squadId: "squad-london",
      venueId: "venue-london",
      location: "London",
      timezone: "Europe/London",
      ...over,
    });
  it("keeps the wall time across the spring change and never shifts a missing time", () => {
    vi.setSystemTime(new Date("2027-03-01T00:00:00Z"));
    // Sundays at 01:30 include 28 March, when 01:00-02:00 does not exist.
    const series = act(
      "ownerA",
      "series",
      london({
        weekdays: [7],
        startDate: "2027-03-21",
        endDate: "2027-04-04",
        startTime: "01:30",
        endTime: "02:30",
        agenda: [],
      }),
      { id: randomUUID() },
    ) as FootballSeries;
    expect(series.skipped).toHaveLength(1);
    expect(series.skipped[0]).toMatchObject({
      date: "2027-03-28",
      reason: "TIME_INVALID",
    });
    expect(series.skipped[0].detail).toMatch(/Europe\/London/);
    expect(
      occurrences(series.id).map((s) => [s.occurrenceDate, s.startAt]),
    ).toEqual([
      ["2027-03-21", "2027-03-21T01:30:00.000Z"],
      ["2027-04-04", "2027-04-04T00:30:00.000Z"], // BST: 01:30 local is 00:30 UTC
    ]);
  });
  it("keeps 18:00 local on both sides of the change", () => {
    vi.setSystemTime(new Date("2027-03-01T00:00:00Z"));
    const series = act(
      "ownerA",
      "series",
      london({
        weekdays: [1],
        startDate: "2027-03-22",
        endDate: "2027-04-05",
        startTime: "18:00",
        endTime: "19:00",
        agenda: [],
      }),
      { id: randomUUID() },
    ) as FootballSeries;
    expect(occurrences(series.id).map((s) => s.startAt)).toEqual([
      "2027-03-22T18:00:00.000Z",
      "2027-03-29T17:00:00.000Z",
      "2027-04-05T17:00:00.000Z",
    ]);
    expect(
      occurrences(series.id).every((s) => s.startLocal.endsWith("T18:00")),
    ).toBe(true);
  });
  it("skips an ambiguous time in the autumn (the repeated hour)", () => {
    vi.setSystemTime(new Date("2027-10-01T00:00:00Z"));
    const series = act(
      "ownerA",
      "series",
      london({
        weekdays: [7],
        startDate: "2027-10-24",
        endDate: "2027-11-07",
        startTime: "01:15",
        endTime: "01:45",
        agenda: [],
      }),
      { id: randomUUID() },
    ) as FootballSeries;
    expect(series.skipped.map((s) => [s.date, s.reason])).toEqual([
      ["2027-10-31", "TIME_INVALID"],
    ]);
    expect(occurrences(series.id)).toHaveLength(2);
  });
});

describe("preview", () => {
  it("shows what would happen and writes nothing", () => {
    const before = database()
      .prepare("SELECT COUNT(*) n FROM workspace_records")
      .get()?.n;
    const preview = act(
      "ownerA",
      "seriesPreview",
      seriesData({ exclusions: [{ date: "2027-01-06", label: "Break" }] }),
    ) as unknown as SeriesPreview;
    expect(preview.occurrences.map((o) => o.date)).toEqual([
      "2027-01-04",
      "2027-01-11",
      "2027-01-13",
    ]);
    expect(preview.skipped).toEqual([
      { date: "2027-01-06", reason: "EXCLUDED", detail: "Break" },
    ]);
    expect(preview.existing).toBe(0);
    expect(
      database().prepare("SELECT COUNT(*) n FROM workspace_records").get()?.n,
    ).toBe(before);
    expect(
      database().prepare("SELECT COUNT(*) n FROM training_submissions").get()
        ?.n,
    ).toBe(0);
  });
  it("reports clock-change skips and conflicts before anything is created", () => {
    vi.setSystemTime(new Date("2027-03-01T00:00:00Z"));
    const preview = act(
      "ownerA",
      "seriesPreview",
      seriesData({
        branchId: extraBranch,
        squadId: "squad-london",
        venueId: "venue-london",
        location: "London",
        timezone: "Europe/London",
        weekdays: [7],
        startDate: "2027-03-21",
        endDate: "2027-04-04",
        startTime: "01:30",
        endTime: "02:30",
        agenda: [],
      }),
    ) as unknown as SeriesPreview;
    expect(preview.skipped.map((s) => s.reason)).toEqual(["TIME_INVALID"]);
    expect(preview.occurrences).toHaveLength(2);
  });
  it("validates exactly like a real create", async () => {
    await invalid(() =>
      act("ownerA", "seriesPreview", seriesData({ weekdays: [] })),
    );
    await rejects(
      () =>
        act("ownerA", "seriesPreview", seriesData({ endDate: "2027-01-03" })),
      400,
      /before the start/,
    );
    await rejects(
      () => act("parent1" as Persona, "seriesPreview", seriesData()),
      403,
    );
  });
});

describe("who can create, process and cancel a series", () => {
  it("lets owners and admins schedule any squad", () => {
    expect(create("ownerA").status).toBe("ACTIVE");
    expect(
      create("adminA", {
        squadId: ids.squadB,
        coachIds: [ids.coachB],
        weekdays: [2],
        startTime: "09:00",
        endTime: "10:00",
      }).status,
    ).toBe("ACTIVE");
  });
  it("lets a coach schedule only a squad they cover, and only with themselves assigned", async () => {
    expect(create("coachA").status).toBe("ACTIVE");
    await rejects(
      () => create("coachA", { weekdays: [2], coachIds: [ids.coachB] }),
      403,
      /Assign yourself/,
    );
    await rejects(
      () =>
        create("coachA", {
          squadId: ids.squadB,
          coachIds: [ids.coachA],
          weekdays: [2],
        }),
      404,
    );
    await rejects(() => create("coachB", { weekdays: [2] }), 404); // squad A is coach A's
  });
  it("hides a series from other coaches, parents and other academies", async () => {
    const series = create("coachA");
    expect(
      visibleRecords(contextFor("coachA"), "series").map((s) => s.id),
    ).toEqual([series.id]);
    expect(visibleRecords(contextFor("coachB"), "series")).toEqual([]);
    expect(visibleRecords(contextFor("ownerA"), "series")).toHaveLength(1);
    expect(visibleRecords(contextFor("parent1"), "series")).toEqual([]);
    await rejects(
      () =>
        act("coachB", "seriesSync", {}, { id: series.id, expectedVersion: 1 }),
      404,
    );
    await rejects(
      () =>
        act(
          "coachB",
          "seriesCancel",
          { reason: "no reason" },
          { id: series.id, expectedVersion: 1 },
        ),
      404,
    );
    // Another academy's owner finds nothing at all under that id.
    await rejects(
      () =>
        act(
          "ownerB",
          "seriesCancel",
          { reason: "no reason" },
          { id: series.id, expectedVersion: 1 },
        ),
      404,
    );
    expect(occurrences(series.id).every((s) => s.status === "SCHEDULED")).toBe(
      true,
    );
  });
  it("hides a series from a coach who covers the squad but is not assigned to it", () => {
    // Coach A covers every player of the squad, yet the series is assigned to the owner only.
    const series = create("ownerA", { coachIds: [ids.ownerA] });
    expect(
      visibleRecords(contextFor("ownerA"), "series").map((s) => s.id),
    ).toEqual([series.id]);
    expect(visibleRecords(contextFor("coachA"), "series")).toEqual([]);
  });
  it("refuses parents on every series action", async () => {
    const series = create("ownerA");
    for (const action of [
      "series",
      "seriesPreview",
      "seriesSync",
      "seriesCancel",
      "wrapup",
    ])
      await rejects(
        () =>
          act(
            "parent1",
            action,
            action === "series" || action === "seriesPreview"
              ? seriesData()
              : { reason: "nope nope" },
            { id: series.id, expectedVersion: 1 },
          ),
        403,
      );
  });
  it("refuses a parent through the route as well", async () => {
    const response = await callRoute(trainingRoute.POST, {
      path: `/api/workspaces/${A}/training`,
      method: "POST",
      as: "parent1",
      params: { academyId: A },
      json: { requestId: randomUUID(), action: "series", data: seriesData() },
    });
    expect(response.status).toBe(403);
    expect(seriesRows()).toHaveLength(0);
  });
  it("never lets a coach reach another coach's series through the generic records route", async () => {
    create("coachA");
    expect(visibleRecords(contextFor("coachB"), "series")).toHaveLength(0);
  });
});

describe("cancelling one occurrence", () => {
  it("cancels only that date and leaves the series and siblings alone", () => {
    const series = create("ownerA");
    const target = occurrences(series.id)[1];
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: target.id, expectedVersion: target.version },
    );
    const after = occurrences(series.id);
    expect(after.map((s) => s.status)).toEqual([
      "SCHEDULED",
      "CANCELLED",
      "SCHEDULED",
      "SCHEDULED",
    ]);
    expect(after[1]).toMatchObject({
      cancelledFrom: "SCHEDULED",
      seriesId: series.id,
    });
    expect(repo.find(A, "series", series.id)).toMatchObject({
      status: "ACTIVE",
      version: 1,
    });
  });
  it("keeps the cancelled date cancelled when the series is processed again", () => {
    const series = create("ownerA");
    const target = occurrences(series.id)[0];
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: target.id, expectedVersion: target.version },
    );
    act("ownerA", "seriesSync", {}, { id: series.id, expectedVersion: 1 });
    const after = occurrences(series.id);
    expect(after).toHaveLength(4);
    expect(after[0].status).toBe("CANCELLED");
  });
  it("keeps the existing status rules: a reason is required and transitions are enforced", async () => {
    const series = create("ownerA");
    const [first] = occurrences(series.id);
    await rejects(
      () =>
        act(
          "ownerA",
          "status",
          { status: "CANCELLED", reason: "" },
          { id: first.id, expectedVersion: first.version },
        ),
      400,
      /cancellation reason/,
    );
    await rejects(
      () =>
        act(
          "ownerA",
          "status",
          { status: "COMPLETED", reason: "" },
          { id: first.id, expectedVersion: first.version },
        ),
      409,
      /Invalid session status transition/,
    );
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: first.id, expectedVersion: first.version },
    );
    const cancelled = repo.find(A, "session", first.id)!;
    await rejects(
      () =>
        act(
          "ownerA",
          "status",
          { status: "SCHEDULED", reason: "" },
          { id: first.id, expectedVersion: cancelled.version },
        ),
      409,
      /Invalid session status transition/,
    );
  });
  it("lets a rescheduled occurrence keep its place in the series", () => {
    const series = create("ownerA");
    const target = occurrences(series.id)[0];
    act(
      "ownerA",
      "reschedule",
      {
        startLocal: "2027-01-05T17:00",
        endLocal: "2027-01-05T18:00",
        timezone: "Asia/Kolkata",
        location: "Synthetic pitch",
        venueId: ids.venue,
        coachIds: [ids.coachA],
        reason: "Pitch unavailable",
      },
      { id: target.id, expectedVersion: target.version },
    );
    act("ownerA", "seriesSync", {}, { id: series.id, expectedVersion: 1 });
    const after = occurrences(series.id);
    expect(after).toHaveLength(4); // not 5: the moved date is not regenerated
    expect(after.find((s) => s.id === target.id)).toMatchObject({
      occurrenceDate: "2027-01-04",
      startLocal: "2027-01-05T17:00",
    });
  });
});

describe("cancelling the whole series", () => {
  it("cancels future sessions, leaves started and finished ones, and records the outcome", () => {
    const series = create("ownerA");
    const [a, b, c, d] = occurrences(series.id);
    repo.save(A, "session", { ...a, status: "COMPLETED" });
    act(
      "ownerA",
      "status",
      { status: "IN_PROGRESS", reason: "" },
      { id: b.id, expectedVersion: b.version },
    );
    const other = create("ownerA", {
      weekdays: [5],
      startTime: "07:00",
      endTime: "08:00",
    });
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Coach unavailable for the term" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    const after = occurrences(series.id);
    expect(after.map((s) => s.status)).toEqual([
      "COMPLETED",
      "IN_PROGRESS",
      "CANCELLED",
      "CANCELLED",
    ]);
    expect(result).toMatchObject({
      status: "CANCELLED",
      cancelReason: "Coach unavailable for the term",
      version: 2,
    });
    expect(result.cancelOutcome?.cancelled).toBe(2);
    expect(result.cancelOutcome?.left).toEqual([
      {
        sessionId: b.id,
        date: "2027-01-06",
        reason: "Training has already started.",
      },
    ]);
    // Another series is untouched.
    expect(occurrences(other.id).every((s) => s.status === "SCHEDULED")).toBe(
      true,
    );
    void c;
    void d;
  });
  it("cannot be repeated or reopened", async () => {
    const series = create("ownerA");
    act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    );
    await rejects(
      () =>
        act(
          "ownerA",
          "seriesCancel",
          { reason: "Term cancelled" },
          { id: series.id, expectedVersion: 2 },
        ),
      409,
      /already cancelled/,
    );
    await rejects(
      () =>
        act("ownerA", "seriesSync", {}, { id: series.id, expectedVersion: 2 }),
      409,
      /cancelled series/,
    );
  });
  it("needs a reason and the current version", async () => {
    const series = create("ownerA");
    await invalid(() =>
      act(
        "ownerA",
        "seriesCancel",
        { reason: "" },
        { id: series.id, expectedVersion: 1 },
      ),
    );
    await rejects(
      () =>
        act(
          "ownerA",
          "seriesCancel",
          { reason: "Term cancelled" },
          { id: series.id, expectedVersion: 7 },
        ),
      409,
      /newer version/,
    );
    expect(occurrences(series.id).every((s) => s.status === "SCHEDULED")).toBe(
      true,
    );
  });
  it("is replay-safe: the same request again changes and notifies nothing more", () => {
    linkParent1ToBoth();
    const series = create("ownerA");
    const requestId = randomUUID();
    const first = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1, requestId },
    );
    const rows = database()
      .prepare("SELECT COUNT(*) n FROM email_outbox")
      .get()?.n;
    const again = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1, requestId },
    );
    expect(again).toEqual(first);
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_outbox").get()?.n,
    ).toBe(rows);
  });
  it("leaves alone, and reports, an occurrence a coach is no longer assigned to", () => {
    const series = create("coachA");
    const [a] = occurrences(series.id);
    repo.save(A, "session", { ...a, coachIds: [ids.coachB] });
    const result = act(
      "coachA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(result.cancelOutcome?.cancelled).toBe(3);
    expect(result.cancelOutcome?.left).toEqual([
      { sessionId: a.id, date: "2027-01-04", reason: "Not assigned to you." },
    ]);
    expect(repo.find(A, "session", a.id)?.status).toBe("SCHEDULED");
  });
});

describe("cancellation notices", () => {
  it("emails each guardian once for a cancelled session, however many children they have in it", () => {
    linkParent1ToBoth(); // parent1 has both children in the session
    const series = create("ownerA");
    const target = occurrences(series.id)[0];
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "INTERNAL: coach unwell" },
      { id: target.id, expectedVersion: target.version },
    );
    const one = mailTo(addr(ids.parent1), `session-cancel:${target.id}`),
      two = mailTo(addr(ids.parent2), `session-cancel:${target.id}`);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
    expect(one[0].subject).toMatch(/Training session cancelled/);
    // The staff-only reason never reaches a parent.
    expect(String(one[0].textBody)).not.toMatch(/INTERNAL|coach unwell/);
    expect(String(one[0].textBody)).toMatch(/Synthetic pitch/);
    expect(mailTo(addr(ids.coachA))).toHaveLength(0);
    expect(mailTo(addr(ids.outsider))).toHaveLength(0);
  });
  it("never sends the same notice twice", () => {
    const series = create("ownerA");
    const target = occurrences(series.id)[0];
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: target.id, expectedVersion: target.version },
    );
    const cancelled = repo.find(A, "session", target.id)!;
    const again = notifySessionCancelled(cancelled)!;
    expect(again).toMatchObject({
      queued: 0,
      alreadyNotified: 2,
      guardians: 2,
    });
    expect(
      database()
        .prepare("SELECT COUNT(*) n FROM email_outbox WHERE relatedId=?")
        .get(`session-cancel:${target.id}`)?.n,
    ).toBe(2);
  });
  it("tells nobody about a draft that was cancelled", () => {
    const series = create("ownerA");
    const [first] = occurrences(series.id);
    repo.save(A, "session", { ...first, status: "DRAFT" });
    const draft = repo.find(A, "session", first.id)!;
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Not needed" },
      { id: first.id, expectedVersion: draft.version },
    );
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_outbox").get()?.n,
    ).toBe(0);
    expect(repo.find(A, "session", first.id)?.cancelledFrom).toBe("DRAFT");
  });
  it("sends one summary per guardian for a series, not one per date", () => {
    linkParent1ToBoth();
    const series = create("ownerA");
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(result.cancelOutcome?.notices).toMatchObject({
      emailEnabled: true,
      guardians: 2,
      queued: 2,
      deferred: 0,
      alreadyNotified: 0,
      refused: 0,
    });
    const rows = database()
      .prepare(
        "SELECT toAddress,subject,relatedId FROM email_outbox ORDER BY toAddress",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.relatedId)).toEqual([
      `series-cancel:${series.id}`,
      `series-cancel:${series.id}`,
    ]);
    expect(rows[0].subject).toMatch(
      /Weekly training cancelled: 4 sessions, 2027-01-04 to 2027-01-13/,
    );
  });
  it("does not email about sessions that were already cancelled one by one", () => {
    const series = create("ownerA");
    const [a, b] = occurrences(series.id);
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: a.id, expectedVersion: a.version },
    );
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(result.cancelOutcome?.cancelled).toBe(3);
    const summary = database()
      .prepare("SELECT subject FROM email_outbox WHERE relatedId=? LIMIT 1")
      .get(`series-cancel:${series.id}`);
    expect(summary?.subject).toMatch(/3 sessions, 2027-01-06 to 2027-01-13/);
    void b;
  });
  it("holds a notice back, and reports it, instead of dropping it at the hourly limit", async () => {
    const series = create("ownerA");
    const now = Date.now();
    // Five messages of this kind to parent1 in the last hour: the hourly limit.
    // (Oldest first, as real traffic arrives.)
    for (let i = 0; i < 5; i++)
      expect(
        enqueueEmail({
          purpose: "SESSION_NOTICE",
          to: addr(ids.parent1),
          subject: "earlier",
          text: "earlier",
          expiresAt: new Date(now + 864e5).toISOString(),
          now: now - (50 - i) * 60_000,
        }),
      ).not.toBeNull();
    // They count toward the limit but are no longer waiting to be sent.
    database()
      .prepare(
        "UPDATE email_outbox SET status='SENT',textBody=NULL WHERE subject='earlier'",
      )
      .run();
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(result.cancelOutcome?.notices).toMatchObject({
      guardians: 2,
      queued: 1,
      deferred: 1,
      refused: 0,
    });
    const held = mailTo(addr(ids.parent1), `series-cancel:${series.id}`);
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe("QUEUED");
    // Due after the oldest of the five has aged out of the hour (10 minutes from now).
    expect(Date.parse(String(held[0].nextAttemptAt))).toBeGreaterThan(now);
    expect(Date.parse(String(held[0].nextAttemptAt))).toBeLessThanOrEqual(
      now + 3600_000 + 1000,
    );
    // The other guardian's notice is not delayed.
    expect(
      Date.parse(
        String(
          mailTo(addr(ids.parent2), `series-cancel:${series.id}`)[0]
            .nextAttemptAt,
        ),
      ),
    ).toBeLessThanOrEqual(now);
    // The worker sends the held message once it is due, and not before.
    resetCapture();
    const early = await processOutbox({ now: () => now + 60_000 });
    expect(early.sent).toBe(1); // parent2's; parent1's is not due yet
    expect(captured.map((m) => m.to)).toEqual([addr(ids.parent2)]);
    const later = await processOutbox({ now: () => now + 3600_000 + 5000 });
    expect(later.sent).toBe(1);
    expect(captured.map((m) => m.to)).toEqual([
      addr(ids.parent2),
      addr(ids.parent1),
    ]);
    expect(captured[1].subject).toMatch(/Weekly training cancelled/);
  });
  it("stops at the daily ceiling and says so", () => {
    const series = create("ownerA");
    const now = Date.now();
    // 20 messages over the last day (an hour apart, oldest first), then 5 in the last hour.
    for (let i = 19; i >= 0; i--)
      expect(
        enqueueEmail({
          purpose: "SESSION_NOTICE",
          to: addr(ids.parent1),
          subject: "earlier",
          text: "earlier",
          expiresAt: new Date(now + 864e5).toISOString(),
          now: now - 3 * 3600_000 - i * 61 * 60_000,
        }),
      ).not.toBeNull();
    for (let i = 0; i < 5; i++)
      expect(
        enqueueEmail({
          purpose: "SESSION_NOTICE",
          to: addr(ids.parent1),
          subject: "recent",
          text: "recent",
          expiresAt: new Date(now + 864e5).toISOString(),
          now: now - (40 - i) * 60_000,
        }),
      ).not.toBeNull();
    database()
      .prepare(
        "UPDATE email_outbox SET status='SENT',textBody=NULL WHERE subject IN ('earlier','recent')",
      )
      .run();
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(result.cancelOutcome?.notices).toMatchObject({
      queued: 1,
      deferred: 0,
      refused: 1,
    });
    expect(
      mailTo(addr(ids.parent1), `series-cancel:${series.id}`),
    ).toHaveLength(0);
    expect(result.status).toBe("CANCELLED"); // the cancellation itself stands
  });
  it("accounts for guardians without an address and for e-mail being off", () => {
    database()
      .prepare('UPDATE "user" SET email=NULL WHERE id=?')
      .run(ids.parent2);
    const series = create("ownerA");
    const result = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    ) as FootballSeries;
    database()
      .prepare('UPDATE "user" SET email=? WHERE id=?')
      .run(addr(ids.parent2), ids.parent2);
    expect(result.cancelOutcome?.notices).toMatchObject({
      guardians: 2,
      queued: 1,
      noAddress: 1,
    });

    process.env.SPORTOZEN_EMAIL_TRANSPORT = "disabled";
    const off = create("ownerA", {
      weekdays: [5],
      startTime: "07:00",
      endTime: "08:00",
    });
    const offResult = act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: off.id, expectedVersion: 1 },
    ) as FootballSeries;
    expect(offResult.cancelOutcome?.notices).toMatchObject({
      emailEnabled: false,
      queued: 0,
    });
    expect(offResult.status).toBe("CANCELLED");
    expect(mailTo(addr(ids.parent1), `series-cancel:${off.id}`)).toHaveLength(
      0,
    );
  });
  it("does not notify a guardian whose access has ended, or other academies' families", () => {
    database()
      .prepare(
        "UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?",
      )
      .run(A, ids.parent2);
    const series = create("ownerA");
    act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    );
    expect(mailTo(addr(ids.parent2))).toHaveLength(0);
    expect(mailTo(addr(ids.parent1))).toHaveLength(1);
    expect(mailTo(addr(ids.ownerB))).toHaveLength(0);
  });
});

describe("what a parent sees of a cancelled session", () => {
  it("shows the cancelled session to the linked parent only, without the reason", () => {
    const series = create("ownerA");
    const target = occurrences(series.id)[0];
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "STAFF ONLY: referee shortage" },
      { id: target.id, expectedVersion: target.version },
    );
    const one = parentSchedule(contextFor("parent1")),
      two = parentSchedule(contextFor("parent2"));
    expect(one.filter((s) => s.id === target.id)).toEqual([
      expect.objectContaining({ status: "CANCELLED", childId: ids.p1 }),
    ]);
    expect(one.every((s) => s.childId === ids.p1)).toBe(true);
    expect(two.every((s) => s.childId === ids.p2)).toBe(true);
    expect(one).toHaveLength(4); // 3 scheduled + the cancelled one
    expect(JSON.stringify(one)).not.toMatch(/STAFF ONLY|referee/);
    expect(
      parentSchedule(contextFor("parent1")).map((s) => s.childId),
    ).not.toContain(ids.p2);
  });
  it("hides a cancelled draft, and a cancellation once a day has passed", () => {
    const series = create("ownerA");
    const [first, second] = occurrences(series.id);
    repo.save(A, "session", { ...first, status: "DRAFT" });
    const draft = repo.find(A, "session", first.id)!;
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Not needed" },
      { id: first.id, expectedVersion: draft.version },
    );
    expect(
      parentSchedule(contextFor("parent1")).map((s) => s.id),
    ).not.toContain(first.id);
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: second.id, expectedVersion: second.version },
    );
    expect(parentSchedule(contextFor("parent1")).map((s) => s.id)).toContain(
      second.id,
    );
    vi.setSystemTime(new Date("2027-01-08T00:00:00Z")); // > 24h after the 6th ended
    expect(
      parentSchedule(contextFor("parent1")).map((s) => s.id),
    ).not.toContain(second.id);
  });
  it("cancelling the series shows the cancelled dates, not a silent gap", () => {
    const series = create("ownerA");
    act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    );
    expect(
      parentSchedule(contextFor("parent1")).filter(
        (s) => s.status === "CANCELLED",
      ),
    ).toHaveLength(4);
  });
});

describe("session wrap-up", () => {
  /** A running session with one planned 30 minute drill. */
  function running(who: Persona = "ownerA") {
    const series = create(who);
    const [s] = occurrences(series.id);
    act(
      who,
      "status",
      { status: "IN_PROGRESS", reason: "" },
      { id: s.id, expectedVersion: s.version },
    );
    return { series, session: repo.find(A, "session", s.id)! };
  }
  const wrap = (over: Record<string, unknown> = {}) => ({
    drills: [
      {
        drillId,
        outcome: "PARTIAL",
        actualMinutes: 20,
        note: "Ran short on time",
      },
    ],
    observations: "Good intensity",
    achievements: "Everyone completed the circuit",
    improvements: "Weaker foot passing",
    ...over,
  });
  const save = (who: Persona, id: string, data: unknown, expectedVersion = 0) =>
    act(who, "wrapup", data, { id, expectedVersion }) as unknown as {
      id: string;
      version: number;
      drills: Array<Record<string, unknown>>;
      observations: string;
    };

  it("records planned versus completed per drill, taking the plan from the saved agenda", () => {
    const { session } = running();
    const record = save(
      "ownerA",
      session.id,
      wrap({
        drills: [
          {
            drillId,
            outcome: "PARTIAL",
            actualMinutes: 20,
            note: "x",
            plannedMinutes: 999,
            drillName: "Tampered",
          },
        ],
      }),
    );
    expect(record).toMatchObject({ id: session.id, version: 1 });
    expect(record.drills).toEqual([
      {
        drillId,
        drillName: "Synthetic receiving drill",
        plannedMinutes: 30,
        outcome: "PARTIAL",
        actualMinutes: 20,
        note: "x",
      },
    ]);
  });
  it("is allowed while in progress and after completion, and keeps every version", () => {
    const { session } = running();
    const first = save("ownerA", session.id, wrap());
    for (const p of [ids.p1, ids.p2]) {
      const mark = repo.find(A, "attendance", `${session.id}:${p}`)!;
      act(
        "ownerA",
        "attendance",
        {
          entries: [
            { playerId: p, status: "PRESENT", expectedVersion: mark.version },
          ],
        },
        { id: session.id },
      );
    }
    const live = repo.find(A, "session", session.id)!;
    act(
      "ownerA",
      "status",
      { status: "COMPLETED", reason: "" },
      { id: session.id, expectedVersion: live.version },
    );
    const edited = save(
      "ownerA",
      session.id,
      wrap({ improvements: "Weaker foot passing and scanning" }),
      first.version,
    );
    expect(edited.version).toBe(2);
    const history = database()
      .prepare(
        "SELECT version FROM training_history WHERE academyId=? AND kind='wrapup' AND recordId=? ORDER BY version",
      )
      .all(A, session.id);
    expect(history.map((r) => r.version)).toEqual([1, 2]);
  });
  it("is not required to complete a session, and does not change the completion rules", async () => {
    const { session } = running();
    const live = repo.find(A, "session", session.id)!;
    await rejects(
      () =>
        act(
          "ownerA",
          "status",
          { status: "COMPLETED", reason: "" },
          { id: session.id, expectedVersion: live.version },
        ),
      400,
      /Mark attendance before completing/,
    );
    for (const p of [ids.p1, ids.p2]) {
      const mark = repo.find(A, "attendance", `${session.id}:${p}`)!;
      act(
        "ownerA",
        "attendance",
        {
          entries: [
            { playerId: p, status: "PRESENT", expectedVersion: mark.version },
          ],
        },
        { id: session.id },
      );
    }
    act(
      "ownerA",
      "status",
      { status: "COMPLETED", reason: "" },
      { id: session.id, expectedVersion: live.version },
    );
    expect(repo.find(A, "session", session.id)?.status).toBe("COMPLETED");
    expect(repo.find(A, "wrapup", session.id)).toBeUndefined();
  });
  it("keeps the attendance correction rule", async () => {
    const { session } = running();
    const mark = repo.find(A, "attendance", `${session.id}:${ids.p1}`)!;
    act(
      "ownerA",
      "attendance",
      {
        entries: [
          {
            playerId: ids.p1,
            status: "PRESENT",
            expectedVersion: mark.version,
          },
        ],
      },
      { id: session.id },
    );
    const marked = repo.find(A, "attendance", `${session.id}:${ids.p1}`)!;
    await rejects(
      () =>
        act(
          "ownerA",
          "attendance",
          {
            entries: [
              {
                playerId: ids.p1,
                status: "ABSENT",
                expectedVersion: marked.version,
              },
            ],
          },
          { id: session.id },
        ),
      400,
      /Explain the attendance correction/,
    );
    act(
      "ownerA",
      "attendance",
      {
        entries: [
          {
            playerId: ids.p1,
            status: "ABSENT",
            expectedVersion: marked.version,
          },
        ],
        correctionReason: "Marked the wrong child",
      },
      { id: session.id },
    );
    expect(repo.find(A, "attendance", `${session.id}:${ids.p1}`)).toMatchObject(
      { status: "ABSENT", correctionReason: "Marked the wrong child" },
    );
  });
  it("is refused before training starts", async () => {
    const series = create("ownerA");
    const [s] = occurrences(series.id);
    await rejects(
      () => save("ownerA", s.id, wrap()),
      409,
      /once training has started/,
    );
  });
  it("validates the drills against the saved agenda", async () => {
    const { session } = running();
    await rejects(
      () => save("ownerA", session.id, wrap({ drills: [] })),
      400,
      /every planned drill/,
    );
    await rejects(
      () =>
        save(
          "ownerA",
          session.id,
          wrap({ drills: [{ drillId: "nope", outcome: "COMPLETED" }] }),
        ),
      400,
      /only the drills planned/,
    );
    await rejects(
      () =>
        save(
          "ownerA",
          session.id,
          wrap({
            drills: [
              { drillId, outcome: "COMPLETED" },
              { drillId, outcome: "SKIPPED" },
            ],
          }),
        ),
      400,
      /once in a wrap-up/,
    );
    await rejects(
      () =>
        save(
          "ownerA",
          session.id,
          wrap({
            drills: [{ drillId, outcome: "SKIPPED", actualMinutes: 10 }],
          }),
        ),
      400,
      /skipped drill has no minutes/,
    );
    await invalid(() =>
      save(
        "ownerA",
        session.id,
        wrap({ drills: [{ drillId, outcome: "MAYBE" }] }),
      ),
    );
    await invalid(() =>
      save("ownerA", session.id, wrap({ observations: "x".repeat(4001) })),
    );
  });
  it("uses optimistic versions and is replay-safe", async () => {
    const { session } = running();
    const requestId = randomUUID();
    const first = act("ownerA", "wrapup", wrap(), {
      id: session.id,
      expectedVersion: 0,
      requestId,
    });
    expect(
      act("ownerA", "wrapup", wrap(), {
        id: session.id,
        expectedVersion: 0,
        requestId,
      }),
    ).toEqual(first);
    await rejects(
      () => save("ownerA", session.id, wrap(), 0),
      409,
      /newer version/,
    );
    expect(
      database()
        .prepare(
          "SELECT COUNT(*) n FROM training_history WHERE kind='wrapup' AND recordId=?",
        )
        .get(session.id)?.n,
    ).toBe(1);
  });
  it("is staff-only: only assigned staff can write or read it", async () => {
    const { session } = running("coachA");
    save("coachA", session.id, wrap());
    expect(visibleRecords(contextFor("coachA"), "wrapup")).toHaveLength(1);
    expect(visibleRecords(contextFor("ownerA"), "wrapup")).toHaveLength(1);
    expect(visibleRecords(contextFor("adminA"), "wrapup")).toHaveLength(1);
    expect(visibleRecords(contextFor("coachB"), "wrapup")).toEqual([]);
    expect(visibleRecords(contextFor("parent1"), "wrapup")).toEqual([]);
    expect(visibleRecords(contextFor("parent2"), "wrapup")).toEqual([]);
    await rejects(() => save("coachB", session.id, wrap(), 1), 404);
    await rejects(() => save("parent1", session.id, wrap(), 1), 403);
    await rejects(() => save("ownerB", session.id, wrap(), 1), 404);
  });
  it("is hidden from a coach who covers the roster but is not assigned to the session", async () => {
    // The session is the owner's (coach A covers both players but is not on it).
    const series = create("ownerA", { coachIds: [ids.ownerA] });
    const [s] = occurrences(series.id);
    act(
      "ownerA",
      "status",
      { status: "IN_PROGRESS", reason: "" },
      { id: s.id, expectedVersion: s.version },
    );
    save("ownerA", s.id, wrap());
    expect(visibleRecords(contextFor("ownerA"), "wrapup")).toHaveLength(1);
    expect(visibleRecords(contextFor("coachA"), "wrapup")).toEqual([]);
    expect(workspace(contextFor("coachA"), ["wrapup"]).records.wrapup).toEqual(
      [],
    );
    await rejects(() => save("coachA", s.id, wrap(), 1), 404);
  });
  it("never reaches a parent through the schedule, the payload or the records route", async () => {
    const { session } = running("coachA");
    save(
      "coachA",
      session.id,
      wrap({
        observations: "PRIVATE-OBSERVATION",
        achievements: "PRIVATE-ACHIEVEMENT",
        improvements: "PRIVATE-IMPROVEMENT",
      }),
    );
    const parent = contextFor("parent1");
    expect(JSON.stringify(parentSchedule(parent))).not.toMatch(/PRIVATE-/);
    expect(JSON.stringify(workspace(parent))).not.toMatch(/PRIVATE-/);
    expect(
      JSON.stringify(workspace(parent, ["wrapup", "series", "session"])),
    ).not.toMatch(/PRIVATE-/);
    const owner = contextFor("ownerA");
    expect(workspace(owner).records.wrapup).toEqual([]); // opt-in, not in the default payload
    expect(workspace(owner, ["wrapup"]).records.wrapup).toHaveLength(1);
    expect(workspace(contextFor("coachB"), ["wrapup"]).records.wrapup).toEqual(
      [],
    );
  });
  it("is not writable through the generic records route", async () => {
    const response = await callRoute(
      (await import("@/app/api/workspaces/[academyId]/records/[kind]/route"))
        .POST,
      {
        path: `/api/workspaces/${A}/records/wrapup`,
        method: "POST",
        as: "ownerA",
        params: { academyId: A, kind: "wrapup" },
        json: { sessionId: "x", observations: "y" },
      },
    );
    expect(response.status).toBe(400);
    expect(repo.list(A, "wrapup")).toHaveLength(0);
  });
});

describe("data integrity", () => {
  const problems = () =>
    checkDataIntegrity(database()).filter((f) =>
      /series|wrap-up|duplicate date/i.test(f.check),
    );
  it("finds nothing wrong after a normal create, cancel and wrap-up", () => {
    const series = create("ownerA");
    const [first, second] = occurrences(series.id);
    act(
      "ownerA",
      "status",
      { status: "CANCELLED", reason: "Rain" },
      { id: first.id, expectedVersion: first.version },
    );
    act(
      "ownerA",
      "status",
      { status: "IN_PROGRESS", reason: "" },
      { id: second.id, expectedVersion: second.version },
    );
    act(
      "ownerA",
      "wrapup",
      { drills: [{ drillId, outcome: "COMPLETED", actualMinutes: 30 }] },
      { id: second.id, expectedVersion: 0 },
    );
    act(
      "ownerA",
      "seriesCancel",
      { reason: "Term cancelled" },
      { id: series.id, expectedVersion: 1 },
    );
    expect(problems()).toEqual([]);
  });
  it("finds a session whose series is missing, or whose id does not carry its date", () => {
    const series = create("ownerA");
    const [first] = occurrences(series.id);
    repo.save(A, "session", {
      ...first,
      id: "extra-orphan",
      seriesId: "no-such-series",
      occurrenceDate: "2027-01-04",
    });
    repo.save(A, "session", {
      ...first,
      id: "extra-wrong-id",
      occurrenceDate: "2027-02-01",
    });
    const found = problems();
    expect(found.map((f) => f.check)).toEqual(
      expect.arrayContaining([
        "session belongs to a series that does not exist",
        "series session id is not series:date (a duplicate date could exist)",
      ]),
    );
    expect(found.every((f) => f.severity === "ERROR")).toBe(true);
  });
  it("finds a wrap-up for a missing session, one with the wrong id, and a cancelled series with live sessions", () => {
    const series = create("ownerA");
    const [first] = occurrences(series.id);
    const base = {
      academyId: A,
      sportId: "football" as const,
      version: 1,
      updatedAt: NOW,
      updatedBy: ids.ownerA,
      drills: [],
      observations: "",
      achievements: "",
      improvements: "",
    };
    repo.save(A, "wrapup", {
      ...base,
      id: "extra-w1",
      sessionId: "no-such-session",
    });
    repo.save(A, "wrapup", {
      ...base,
      id: "not-the-session-id",
      sessionId: first.id,
    });
    repo.save(A, "series", {
      ...repo.find(A, "series", series.id)!,
      status: "CANCELLED",
      cancelledAt: NOW,
      cancelOutcome: {
        cancelled: 0,
        left: [],
        notices: {
          emailEnabled: false,
          guardians: 0,
          queued: 0,
          deferred: 0,
          alreadyNotified: 0,
          noAddress: 0,
          refused: 0,
        },
      },
    });
    const checks = problems().map((f) => f.check);
    expect(checks).toEqual(
      expect.arrayContaining([
        "wrap-up refers to a session that does not exist",
        "wrap-up id is not its session id (a second wrap-up could exist)",
        "cancelled series still has a scheduled future session",
      ]),
    );
  });
});

describe("academy isolation", () => {
  it("keeps a series and its sessions inside their academy", () => {
    const series = create("ownerA");
    const rows = database()
      .prepare(
        "SELECT COUNT(*) n FROM workspace_records WHERE academyId=? AND (kind IN ('series','wrapup') OR json_extract(body,'$.seriesId') IS NOT NULL)",
      )
      .get(B)?.n;
    expect(rows).toBe(0);
    expect(repo.find(B, "series", series.id)).toBeUndefined();
    expect(workspace(contextFor("ownerB")).records.series).toEqual([]);
    void series;
  });
});
