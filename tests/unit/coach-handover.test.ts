// P1-04: revoking a coach who still has players, upcoming sessions or weekly
// series needs a decision: a replacement coach (everything moves in one
// transaction) or an explicit "leave unassigned". Past sessions keep their coach.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { revokeMembership } from "@/server/membership-service";
import type { FootballSeries, FootballSession } from "@/domain/training";
import type { AcademyConfiguration } from "@/domain/workspace";
import {
  actorFor,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-handover-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});

let academy: AcademyConfiguration, coach: string, second: string;
const membershipRowId = (userId: string) => `${userId}`;
const active = (userId: string) =>
  Boolean(
    database()
      .prepare("SELECT active FROM academy_memberships WHERE academyId=? AND userId=?")
      .get(academy.id, userId)?.active,
  );
const base = () => ({
  academyId: academy.id,
  sportId: "football",
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "x",
});
function session(id: string, status: FootballSession["status"], startAt: string, coachIds = [coach]) {
  repo.save(academy.id, "session", {
    ...base(),
    id,
    branchId: "b",
    squadId: "sq",
    location: "Pitch",
    coachIds,
    timezone: "UTC",
    startLocal: startAt.slice(0, 16),
    endLocal: startAt.slice(0, 16),
    startAt,
    endAt: startAt,
    theme: "",
    status,
    roster: [{ playerId: "p1", name: "One" }],
    agenda: [],
    objectives: [],
  } as FootballSession);
}
const coachIdsOf = (id: string) => repo.find(academy.id, "session", id)!.coachIds;
const future = new Date(Date.now() + 14 * 86_400_000).toISOString();
const past = new Date(Date.now() - 14 * 86_400_000).toISOString();

beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
  coach = memberId("COACH", academy);
  second = `COACH2-${academy.id}`;
  const db = database();
  db.prepare("INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)").run(
    second,
    academy.id,
    second,
    "COACH",
    '["football"]',
  );
  db.prepare('INSERT OR REPLACE INTO "user"(id,name) VALUES(?,?)').run(second, "Second coach");
  for (const id of ["p1", "p2"])
    repo.save(academy.id, "player", {
      id,
      academyId: academy.id,
      name: `Player ${id}`,
      sportIds: ["football"],
      squad: "",
      squadId: "",
      coachId: coach,
    });
  repo.save(academy.id, "player", {
    id: "p3",
    academyId: academy.id,
    name: "Someone else's player",
    sportIds: ["football"],
    squad: "",
    squadId: "",
    coachId: memberId("ADMIN", academy),
  });
  session("future-1", "SCHEDULED", future);
  session("future-draft", "DRAFT", future);
  session("past-1", "COMPLETED", past);
  session("in-progress", "IN_PROGRESS", new Date(Date.now() - 600_000).toISOString());
  session("other-coach", "SCHEDULED", future, [second]);
  repo.save(academy.id, "series", {
    ...base(),
    id: "ser",
    branchId: "b",
    squadId: "sq",
    location: "Pitch",
    coachIds: [coach, second],
    timezone: "UTC",
    weekdays: [1],
    startDate: "2026-12-01",
    endDate: "2027-03-01",
    startTime: "17:00",
    endTime: "18:00",
    theme: "",
    agenda: [],
    exclusions: [],
    status: "ACTIVE",
    skipped: [],
  } as FootballSeries);
});

describe("revoking a coach with work still assigned", () => {
  it("asks for a decision and changes nothing until it gets one", async () => {
    let message = "";
    try {
      revokeMembership(actorFor("OWNER", academy), membershipRowId(coach));
    } catch (error) {
      message = (error as Error).message;
      expect((error as { status: number }).status).toBe(409);
    }
    expect(message).toMatch(/2 players, 2 upcoming sessions and 1 weekly series/);
    expect(active(coach)).toBe(true);
    expect(repo.find(academy.id, "player", "p1")!.coachId).toBe(coach);
    expect(coachIdsOf("future-1")).toEqual([coach]);
  });
  it("with a replacement, moves players, upcoming sessions and series in one step", () => {
    const result = revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
      replacementCoachId: second,
    });
    expect(result).toEqual({
      ok: true,
      handover: { players: 2, sessions: 2, series: 1, replacementCoachId: second },
    });
    expect(active(coach)).toBe(false);
    expect(repo.find(academy.id, "player", "p1")!.coachId).toBe(second);
    expect(repo.find(academy.id, "player", "p2")!.coachId).toBe(second);
    expect(coachIdsOf("future-1")).toEqual([second]);
    expect(coachIdsOf("future-draft")).toEqual([second]);
    // The series already listed the replacement: no duplicate, revoked coach gone.
    expect(repo.find(academy.id, "series", "ser")!.coachIds).toEqual([second]);
    // Not the revoked coach's: untouched.
    expect(repo.find(academy.id, "player", "p3")!.coachId).toBe(memberId("ADMIN", academy));
    expect(coachIdsOf("other-coach")).toEqual([second]);
  });
  it("also moves an undated draft (a copied session has no date yet)", () => {
    session("undated-draft", "DRAFT", "");
    revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
      replacementCoachId: second,
    });
    expect(coachIdsOf("undated-draft")).toEqual([second]);
  });
  it("keeps past sessions and a session in progress with the coach who ran them", () => {
    revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
      replacementCoachId: second,
    });
    expect(coachIdsOf("past-1")).toEqual([coach]);
    expect(coachIdsOf("in-progress")).toEqual([coach]);
  });
  it("is audited and keeps training history for what moved", () => {
    revokeMembership(actorFor("ADMIN", academy), membershipRowId(coach), {
      replacementCoachId: second,
    });
    const actions = database()
      .prepare("SELECT action FROM workspace_audit WHERE academyId=?")
      .all(academy.id)
      .map((r) => String(r.action));
    expect(actions).toContain(`Coach hand-over: 2 players, 2 sessions, 1 series moved to ${second}`);
    expect(actions).toContain("Membership revoked");
    expect(
      Number(
        database()
          .prepare("SELECT COUNT(*) n FROM training_history WHERE academyId=? AND kind IN ('session','series')")
          .get(academy.id)?.n,
      ),
    ).toBe(3);
  });
  it("can leave the work unassigned, but only when told to, and says so in the audit log", () => {
    const result = revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
      leaveUnassigned: true,
    });
    expect(result.handover).toEqual({ players: 0, sessions: 0, series: 0, replacementCoachId: undefined });
    expect(active(coach)).toBe(false);
    expect(repo.find(academy.id, "player", "p1")!.coachId).toBe(coach);
    const actions = database()
      .prepare("SELECT action FROM workspace_audit WHERE academyId=?")
      .all(academy.id)
      .map((r) => String(r.action));
    expect(actions).toContain(
      "Coach hand-over: 2 players, 2 sessions, 1 series explicitly left unassigned",
    );
  });
  it("refuses a bad replacement and leaves everything as it was", async () => {
    const owner = actorFor("OWNER", academy);
    for (const replacementCoachId of [
      coach, // themselves
      memberId("PARENT", academy), // not staff
      "nobody", // not a member
      memberId("SUPPORT", academy),
    ])
      expect(
        await statusOf(() =>
          revokeMembership(owner, membershipRowId(coach), { replacementCoachId }),
        ),
      ).toBe(400);
    expect(active(coach)).toBe(true);
    expect(repo.find(academy.id, "player", "p1")!.coachId).toBe(coach);
  });
  it("refuses a replacement from another academy", async () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(
      await statusOf(() =>
        revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
          replacementCoachId: memberId("COACH", other),
        }),
      ),
    ).toBe(400);
    expect(active(coach)).toBe(true);
  });
  it("refuses a replacement that has already been revoked", async () => {
    database()
      .prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?")
      .run(academy.id, second);
    expect(
      await statusOf(() =>
        revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
          replacementCoachId: second,
        }),
      ),
    ).toBe(400);
  });
  it("does not accept both options at once", async () => {
    expect(
      await statusOf(() =>
        revokeMembership(actorFor("OWNER", academy), membershipRowId(coach), {
          replacementCoachId: second,
          leaveUnassigned: true,
        }),
      ),
    ).toBe(400);
    expect(active(coach)).toBe(true);
  });
});

describe("everything else about revoking is unchanged", () => {
  it("a coach with nothing assigned is revoked without a decision", () => {
    expect(active(second)).toBe(true);
    // second has the series and one session: take those away first.
    repo.save(academy.id, "series", {
      ...repo.find(academy.id, "series", "ser")!,
      status: "CANCELLED",
    });
    repo.save(academy.id, "session", {
      ...repo.find(academy.id, "session", "other-coach")!,
      status: "CANCELLED",
    });
    const result = revokeMembership(actorFor("OWNER", academy), membershipRowId(second));
    expect(result.ok).toBe(true);
    expect(active(second)).toBe(false);
  });
  it("a parent is revoked as before", () => {
    revokeMembership(actorFor("OWNER", academy), memberId("PARENT", academy));
    expect(active(memberId("PARENT", academy))).toBe(false);
  });
  it("the owner still cannot be revoked", async () => {
    expect(
      await statusOf(() =>
        revokeMembership(actorFor("ADMIN", academy), memberId("OWNER", academy)),
      ),
    ).toBe(403);
  });
  it("coach, parent and support cannot revoke anyone", async () => {
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const)
      expect(
        await statusOf(() =>
          revokeMembership(actorFor(role, academy), memberId("PARENT", academy)),
        ),
      ).toBe(403);
  });
  it("cannot reach another academy's membership", async () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(
      await statusOf(() =>
        revokeMembership(actorFor("OWNER", other), membershipRowId(coach), {
          replacementCoachId: memberId("COACH", other),
        }),
      ),
    ).toBe(404);
    expect(active(coach)).toBe(true);
  });
});
