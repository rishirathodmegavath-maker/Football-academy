// P1-08: all-day academy/branch closures. They block new sessions on closed
// days, skip recurring dates with a "closed day" reason, are visible to
// families only as dates plus the note written for them, and never cancel
// existing sessions on their own.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({
  WorkspaceError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authenticatedUser: vi.fn(),
}));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { trainingAction } from "@/server/training-service";
import { parentClosures } from "@/server/parent-schedule-service";
import { workspace } from "@/server/workspace-service";
import { visibleRecords } from "@/server/workspace-access";
import { checkDataIntegrity } from "@/server/data-integrity";
import { closureCovering } from "@/services/closure-rules";
import type {
  FootballClosure,
  FootballSeries,
  FootballSession,
  SeriesPreview,
} from "@/domain/training";
import type { AcademyConfiguration, AcademyRole } from "@/domain/workspace";
import {
  actorFor,
  linkGuardian,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-closures-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T06:00:00Z"));
});
afterEach(() => vi.useRealTimers());

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const act = (
  role: AcademyRole,
  action: string,
  data: unknown,
  extra: { id?: string; expectedVersion?: number } = {},
) =>
  trainingAction(as(role), { requestId: randomUUID(), action, data, ...extra });
const closeDays = (
  over: Record<string, unknown> = {},
  role: AcademyRole = "OWNER",
  extra: { id?: string; expectedVersion?: number } = {},
) =>
  act(
    role,
    "closure",
    {
      branchId: "",
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      reason: "Public holiday and ground maintenance",
      publicNote: "Training is off for the holidays.",
      ...over,
    },
    extra,
  ) as FootballClosure;
const sessionDraft = (date: string, over: Record<string, unknown> = {}) => ({
  branchId: "main",
  squadId: "squad-main",
  coachIds: [memberId("COACH", academy)],
  timezone: academy.timezone,
  location: "Synthetic pitch",
  startLocal: `${date}T17:00`,
  endLocal: `${date}T18:00`,
  ...over,
});
const sessions = () => repo.list(academy.id, "session");

beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
  for (const [id, name] of [
    ["main", "Main branch"],
    ["north", "North branch"],
  ])
    repo.save(academy.id, "branch", {
      id,
      academyId: academy.id,
      name,
      timezone: academy.timezone,
    });
  repo.save(academy.id, "player", {
    id: "child",
    academyId: academy.id,
    name: "Synthetic child",
    sportIds: ["football"],
    squad: "",
    squadId: "",
    coachId: memberId("COACH", academy),
  });
  act("OWNER", "squad", { name: "Main U12", branchId: "main", playerIds: ["child"] }, {
    id: "squad-main",
  });
  act("OWNER", "squad", { name: "North U12", branchId: "north", playerIds: [] }, {
    id: "squad-north",
  });
  linkGuardian(academy, memberId("PARENT", academy), "child");
});

describe("recording a closure", () => {
  it("owner and admin can record one; it is saved with its history and audited", () => {
    const closure = closeDays();
    expect(closure).toMatchObject({
      branchId: "",
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      status: "ACTIVE",
      version: 1,
    });
    expect(closeDays({}, "ADMIN").version).toBe(1);
    const audit = database()
      .prepare("SELECT action FROM workspace_audit WHERE academyId=? AND resourceId=?")
      .all(academy.id, closure.id)
      .map((r) => String(r.action));
    expect(audit.some((a) => a.startsWith("Closure recorded"))).toBe(true);
    expect(
      Number(
        database()
          .prepare("SELECT COUNT(*) n FROM training_history WHERE academyId=? AND kind='closure'")
          .get(academy.id)?.n,
      ),
    ).toBe(2);
  });
  it("coach, parent and support cannot record, change or lift one", async () => {
    const closure = closeDays();
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const) {
      expect(await statusOf(() => closeDays({}, role))).toBe(403);
      expect(
        await statusOf(() =>
          closeDays({ status: "LIFTED" }, role, { id: closure.id, expectedVersion: 1 }),
        ),
      ).toBe(403);
    }
    expect(repo.find(academy.id, "closure", closure.id)?.status).toBe("ACTIVE");
  });
  it("rejects bad dates, an overlong span, an unknown branch and a missing reason", async () => {
    expect(await statusOf(() => closeDays({ endDate: "2026-12-20" }))).toBe(400);
    expect(await statusOf(() => closeDays({ endDate: "2028-12-26" }))).toBe(400);
    expect(await statusOf(() => closeDays({ branchId: "nowhere" }))).toBe(404);
    expect(await statusOf(() => closeDays({ reason: "" }))).toBe(-1);
    expect(await statusOf(() => closeDays({ startDate: "24/12/2026" }))).toBe(-1);
  });
  it("one branch's closure cannot name another academy's branch", async () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    repo.save(other.id, "branch", {
      id: "foreign",
      academyId: other.id,
      name: "Elsewhere",
      timezone: other.timezone,
    });
    expect(await statusOf(() => closeDays({ branchId: "foreign" }))).toBe(404);
  });
  it("is versioned: a stale edit is refused", async () => {
    const closure = closeDays();
    expect(
      await statusOf(() =>
        closeDays({ endDate: "2026-12-27" }, "OWNER", {
          id: closure.id,
          expectedVersion: 5,
        }),
      ),
    ).toBe(409);
  });
});

describe("what a closure blocks", () => {
  it("a new session on a closed day, for the closed branch only", async () => {
    closeDays({ branchId: "main" });
    expect(await statusOf(() => act("OWNER", "session", sessionDraft("2026-12-25")))).toBe(409);
    await expect(
      (async () => act("OWNER", "session", sessionDraft("2026-12-25")))(),
    ).rejects.toThrow(/Main branch is closed on 2026-12-24 to 2026-12-26/);
    // The same day at the other branch, and the day after, are unaffected.
    expect(
      await statusOf(() =>
        act("OWNER", "session", sessionDraft("2026-12-25", { branchId: "north", squadId: "squad-north", coachIds: [] })),
      ),
    ).toBe(0);
    expect(await statusOf(() => act("OWNER", "session", sessionDraft("2026-12-27")))).toBe(0);
  });
  it("an academy-wide closure blocks every branch, and can be lifted", async () => {
    const closure = closeDays();
    expect(await statusOf(() => act("OWNER", "session", sessionDraft("2026-12-24")))).toBe(409);
    expect(
      await statusOf(() =>
        act("OWNER", "session", sessionDraft("2026-12-26", { branchId: "north", squadId: "squad-north", coachIds: [] })),
      ),
    ).toBe(409);
    closeDays({ status: "LIFTED" }, "OWNER", { id: closure.id, expectedVersion: 1 });
    expect(await statusOf(() => act("OWNER", "session", sessionDraft("2026-12-24")))).toBe(0);
  });
  it("rescheduling onto a closed day, and scheduling a draft that now sits on one", async () => {
    const draft = act("OWNER", "session", sessionDraft("2026-12-15")) as FootballSession;
    closeDays({ startDate: "2026-12-15", endDate: "2026-12-15" });
    // The draft is on a closed day now: it cannot be scheduled.
    expect(
      await statusOf(() =>
        act("OWNER", "status", { status: "SCHEDULED" }, { id: draft.id, expectedVersion: draft.version }),
      ),
    ).toBe(409);
    // Moving it to an open day works; moving it onto the closure does not.
    const moved = act(
      "OWNER",
      "reschedule",
      {
        startLocal: "2026-12-16T17:00",
        endLocal: "2026-12-16T18:00",
        timezone: academy.timezone,
        location: "Synthetic pitch",
        coachIds: [memberId("COACH", academy)],
        reason: "Moved off the closed day",
      },
      { id: draft.id, expectedVersion: draft.version },
    ) as FootballSession;
    expect(moved.startLocal).toBe("2026-12-16T17:00");
    expect(
      await statusOf(() =>
        act(
          "OWNER",
          "reschedule",
          {
            startLocal: "2026-12-15T17:00",
            endLocal: "2026-12-15T18:00",
            timezone: academy.timezone,
            location: "Synthetic pitch",
            coachIds: [memberId("COACH", academy)],
            reason: "Back onto the closed day",
          },
          { id: draft.id, expectedVersion: moved.version },
        ),
      ),
    ).toBe(409);
  });
  it("never cancels or edits a session that already exists", () => {
    const existing = act("OWNER", "session", sessionDraft("2026-12-24")) as FootballSession;
    expect(existing.status).toBe("DRAFT");
    closeDays();
    expect(repo.find(academy.id, "session", existing.id)).toMatchObject({
      status: "DRAFT",
      version: existing.version,
    });
  });
});

describe("recurring series", () => {
  const seriesData = (over: Record<string, unknown> = {}) => ({
    branchId: "main",
    squadId: "squad-main",
    location: "Synthetic pitch",
    coachIds: [memberId("COACH", academy)],
    timezone: academy.timezone,
    weekdays: [1, 3],
    startDate: "2026-12-14",
    endDate: "2027-01-03",
    startTime: "17:00",
    endTime: "18:00",
    theme: "Receiving",
    agenda: [],
    exclusions: [],
    ...over,
  });
  it("skips closed dates with a closed-day reason and keeps the rest", () => {
    closeDays({ startDate: "2026-12-21", endDate: "2026-12-23" });
    const preview = act("OWNER", "seriesPreview", seriesData()) as SeriesPreview;
    // Mondays 14, 21, 28 Dec and 4 Jan are outside the range; 14,16,21,23,28,30 Dec and 4 Jan: only 21 and 23 close.
    const closed = preview.skipped.filter((s) => s.reason === "CLOSURE");
    expect(closed.map((s) => s.date)).toEqual(["2026-12-21", "2026-12-23"]);
    expect(closed[0].detail).toMatch(/Main branch|academy/);
    expect(preview.occurrences.map((o) => o.date)).not.toContain("2026-12-21");
    expect(preview.occurrences.map((o) => o.date)).toContain("2026-12-28");
    const series = act("OWNER", "series", seriesData(), { id: randomUUID() }) as FootballSeries;
    const made = sessions().filter((s) => s.seriesId === series.id).map((s) => s.occurrenceDate);
    expect(made).not.toContain("2026-12-21");
    expect(made).not.toContain("2026-12-23");
    expect(made).toContain("2026-12-14");
  });
  it("does not skip dates for a closure at a different branch", () => {
    closeDays({ branchId: "north", startDate: "2026-12-21", endDate: "2026-12-23" });
    const preview = act("OWNER", "seriesPreview", seriesData()) as SeriesPreview;
    expect(preview.skipped.filter((s) => s.reason === "CLOSURE")).toEqual([]);
  });
  it("refuses a series whose every date is closed, saying why", async () => {
    closeDays({ startDate: "2026-12-01", endDate: "2027-02-01" });
    await expect(
      (async () => act("OWNER", "series", seriesData(), { id: randomUUID() }))(),
    ).rejects.toThrow(/closed-day/);
  });
});

describe("what families see", () => {
  it("dates, scope and the family note only: never the internal reason", () => {
    closeDays({ branchId: "main", reason: "SECRET internal reason: pitch dispute" });
    const seen = parentClosures(as("PARENT"), "2026-12-01");
    expect(seen).toEqual([
      {
        id: expect.any(String),
        startDate: "2026-12-24",
        endDate: "2026-12-26",
        scope: "BRANCH",
        branchName: "Main branch",
        note: "Training is off for the holidays.",
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain("SECRET");
    expect(JSON.stringify(workspace(as("PARENT")))).not.toContain("SECRET");
  });
  it("only the branch their child trains at, plus academy-wide closures", () => {
    closeDays({ branchId: "north", startDate: "2026-12-10", endDate: "2026-12-10" });
    closeDays({ startDate: "2026-12-11", endDate: "2026-12-11" });
    expect(parentClosures(as("PARENT"), "2026-12-01").map((c) => c.startDate)).toEqual(["2026-12-11"]);
  });
  it("not a lifted closure, and not one long over", () => {
    const lifted = closeDays();
    closeDays({ status: "LIFTED" }, "OWNER", { id: lifted.id, expectedVersion: 1 });
    closeDays({ startDate: "2026-10-01", endDate: "2026-10-02" });
    expect(parentClosures(as("PARENT"), "2026-12-01")).toEqual([]);
  });
  it("a parent with no child in the academy sees only academy-wide closures", () => {
    database()
      .prepare("DELETE FROM guardian_relationships WHERE academyId=?")
      .run(academy.id);
    closeDays({ branchId: "main", startDate: "2026-12-10", endDate: "2026-12-10" });
    closeDays({ startDate: "2026-12-11", endDate: "2026-12-11" });
    expect(parentClosures(as("PARENT"), "2026-12-01").map((c) => c.startDate)).toEqual(["2026-12-11"]);
  });
  it("only staff can read the closure records themselves; a parent's record read is empty", () => {
    closeDays();
    expect(visibleRecords(as("PARENT"), "closure")).toEqual([]);
    expect(visibleRecords(as("SUPPORT"), "closure")).toEqual([]);
    expect(visibleRecords(as("OWNER"), "closure")).toHaveLength(1);
    expect(visibleRecords(as("COACH"), "closure")).toHaveLength(1);
  });
  it("another academy's closures are invisible", () => {
    closeDays();
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(visibleRecords(actorFor("OWNER", other), "closure")).toEqual([]);
    expect(parentClosures(actorFor("PARENT", other), "2026-12-01")).toEqual([]);
  });
});

describe("rules and integrity", () => {
  it("closureCovering honours branch, inclusive dates and status", () => {
    const base = { id: "c", academyId: "a", sportId: "football", version: 1, updatedAt: "", updatedBy: "", reason: "r", publicNote: "" } as const;
    const list: FootballClosure[] = [
      { ...base, branchId: "b1", startDate: "2026-01-10", endDate: "2026-01-12", status: "ACTIVE" },
      { ...base, id: "d", branchId: "", startDate: "2026-02-01", endDate: "2026-02-01", status: "LIFTED" },
    ];
    expect(closureCovering(list, "b1", "2026-01-10")?.id).toBe("c");
    expect(closureCovering(list, "b1", "2026-01-12")?.id).toBe("c");
    expect(closureCovering(list, "b1", "2026-01-13")).toBeUndefined();
    expect(closureCovering(list, "b2", "2026-01-11")).toBeUndefined();
    expect(closureCovering(list, "b1", "2026-02-01")).toBeUndefined();
  });
  it("the integrity check reports a closure for a missing branch or with reversed dates", () => {
    closeDays();
    const clean = () =>
      checkDataIntegrity(database()).filter((f) => f.check.startsWith("closure"));
    expect(clean()).toEqual([]);
    for (const [id, body] of [
      ["bad-branch", { branchId: "ghost", startDate: "2026-01-01", endDate: "2026-01-02" }],
      ["bad-dates", { branchId: "", startDate: "2026-01-05", endDate: "2026-01-02" }],
    ] as const)
      database()
        .prepare("INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)")
        .run(
          academy.id,
          "closure",
          id,
          JSON.stringify({ id, academyId: academy.id, sportId: "football", reason: "r", publicNote: "", status: "ACTIVE", version: 1, ...body }),
        );
    expect(clean().map((f) => f.check).sort()).toEqual([
      "closure ends before it starts",
      "closure's branch does not exist",
    ]);
  });
});
