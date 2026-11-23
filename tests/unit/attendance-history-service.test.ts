// Phase 9: per-player attendance history, percentages and the follow-up flag,
// through the service and the route, for every role. Real services against the
// two-academy fixture (see helpers/api-harness.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { trainingAction } from "@/server/training-service";
import {
  attendanceFollowUps,
  playerAttendanceHistory,
} from "@/server/attendance-history-service";
import * as historyRoute from "@/app/api/workspaces/[academyId]/attendance-history/route";
import type {
  AttendanceHistory,
  FootballAttendance,
  FootballSession,
} from "@/domain/training";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-attendance-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const stamp = {
  version: 1,
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: ids.ownerA,
};

/** A finished session of a squad on a September 2026 day, with marks. */
function held(
  tag: string,
  day: number,
  squadId: string,
  coachId: string,
  marks: Record<string, FootballAttendance["status"]>,
  status: FootballSession["status"] = "COMPLETED",
  correctionReason = "",
) {
  const date = `2026-09-${String(day).padStart(2, "0")}`;
  const session: FootballSession = {
    id: `extra-${tag}`,
    academyId: A,
    sportId: "football",
    ...stamp,
    branchId: ids.branch,
    squadId,
    venueId: ids.venue,
    location: "Synthetic pitch",
    coachIds: [coachId],
    timezone: "Asia/Kolkata",
    startLocal: `${date}T17:00`,
    endLocal: `${date}T18:00`,
    startAt: `${date}T11:30:00.000Z`,
    endAt: `${date}T12:30:00.000Z`,
    theme: "x",
    status,
    roster: Object.keys(marks).map((playerId) => ({
      playerId,
      name: playerId,
    })),
    agenda: [],
    objectives: [],
  };
  repo.save(A, "session", session);
  for (const [playerId, mark] of Object.entries(marks))
    repo.save(A, "attendance", {
      id: `${session.id}:${playerId}`,
      academyId: A,
      sportId: "football",
      ...stamp,
      sessionId: session.id,
      playerId,
      status: mark,
      correctionReason,
    } as FootballAttendance);
  return session;
}
const who = (p: Persona) => contextFor(p);
const read = (p: Persona, player: string) =>
  playerAttendanceHistory(who(p), player);
const refused = (fn: () => unknown, status: number) => {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect((error as { status?: number } | undefined)?.status).toBe(status);
};

beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

describe("history from the fixture (three present, then one absence)", () => {
  it("counts, percentages and newest-first listing", () => {
    const h = read("ownerA", ids.p1);
    expect(h).toMatchObject({
      playerId: ids.p1,
      playerName: "Synthetic Asha One",
      counted: 4,
      present: 3,
      absent: 1,
      excused: 0,
      percentage: 75,
      consecutiveAbsences: 1,
      followUp: false,
    });
    expect(h.sessions.map((r) => [r.date, r.status])).toEqual([
      ["2026-09-04", "ABSENT"],
      ["2026-09-03", "PRESENT"],
      ["2026-09-02", "PRESENT"],
      ["2026-09-01", "PRESENT"],
    ]);
    expect(h.sessions[0].squadName).toBe(`Batch ${ids.squadA}`);
  });
});

describe("the follow-up flag", () => {
  it("raises at three consecutive absences, ignores cancelled sessions and neutral excused marks", () => {
    // p1: ABSENT (fixture, 4 Sep), ABSENT, ABSENT  -> three in a row.
    // p2: ABSENT (4 Sep), EXCUSED, ABSENT, ABSENT  -> excused neither counts nor resets.
    held("a5", 10, ids.squadA, ids.coachA, {
      [ids.p1]: "ABSENT",
      [ids.p2]: "EXCUSED",
    });
    expect(read("ownerA", ids.p1).followUp).toBe(false); // two so far
    held("a6", 11, ids.squadA, ids.coachA, {
      [ids.p1]: "ABSENT",
      [ids.p2]: "ABSENT",
    });
    // A cancelled session where p1 was "present" must not break the run.
    held(
      "c1",
      12,
      ids.squadA,
      ids.coachA,
      { [ids.p1]: "PRESENT", [ids.p2]: "PRESENT" },
      "CANCELLED",
    );
    const p1 = read("ownerA", ids.p1),
      p2 = read("ownerA", ids.p2);
    expect(p1).toMatchObject({
      consecutiveAbsences: 3,
      followUp: true,
      counted: 6,
      present: 3,
      absent: 3,
    });
    expect(p1.percentage).toBe(50);
    expect(p2).toMatchObject({
      consecutiveAbsences: 2,
      followUp: false,
      excused: 1,
      counted: 6,
    });
    expect(p2.percentage).toBe(50); // 3 present of 6 counted, the excused mark included
    held("a7", 13, ids.squadA, ids.coachA, {
      [ids.p1]: "PRESENT",
      [ids.p2]: "ABSENT",
    });
    expect(read("ownerA", ids.p2)).toMatchObject({
      consecutiveAbsences: 3,
      followUp: true,
    });
    expect(read("ownerA", ids.p1)).toMatchObject({
      consecutiveAbsences: 0,
      followUp: false,
    }); // attended
  });

  it("follows a correction made with the existing correction rule", () => {
    // p2's run is currently three; correct the latest absence to present.
    const mark = repo.find(A, "attendance", "extra-a7:" + ids.p2)!;
    const ctx = contextFor("ownerA");
    const noReason = () =>
      trainingAction(ctx, {
        requestId: randomUUID(),
        action: "attendance",
        id: "extra-a7",
        data: {
          entries: [
            {
              playerId: ids.p2,
              status: "PRESENT",
              expectedVersion: mark.version,
            },
          ],
        },
      });
    // The session is COMPLETED but not CANCELLED, so staff may still correct a
    // mark, and only with a reason (unchanged rule).
    refused(noReason, 400);
    trainingAction(ctx, {
      requestId: randomUUID(),
      action: "attendance",
      id: "extra-a7",
      data: {
        entries: [
          {
            playerId: ids.p2,
            status: "PRESENT",
            expectedVersion: mark.version,
          },
        ],
        correctionReason: "Arrived late and was missed",
      },
    });
    const h = read("ownerA", ids.p2);
    expect(h.followUp).toBe(false);
    expect(h.consecutiveAbsences).toBe(0);
    expect(h.sessions[0]).toMatchObject({
      status: "PRESENT",
      correctionReason: "Arrived late and was missed",
    });
  });
});

describe("who can read what", () => {
  it("lets owners and admins read any football player", () => {
    for (const persona of ["ownerA", "adminA"] as const)
      for (const p of [ids.p1, ids.p2, ids.p3])
        expect(read(persona, p).playerId).toBe(p);
  });
  it("lets a coach read only their own players", () => {
    expect(read("coachA", ids.p1).playerId).toBe(ids.p1);
    expect(read("coachB", ids.p3).playerId).toBe(ids.p3);
    refused(() => read("coachA", ids.p3), 404);
    refused(() => read("coachB", ids.p1), 404);
    refused(() => read("coachB", ids.p2), 404);
  });
  it("shows a coach the player's whole record, including sessions another coach ran", () => {
    held("shared", 14, ids.squadA, ids.coachB, { [ids.p1]: "ABSENT" }); // run by coach B
    expect(read("coachA", ids.p1).sessions.map((r) => r.sessionId)).toContain(
      "extra-shared",
    );
  });
  it("lets a parent read only a linked child, without the flag or staff notes", () => {
    const h = read("parent1", ids.p1);
    expect(h.playerId).toBe(ids.p1);
    expect(h.counted).toBeGreaterThan(0);
    expect("followUp" in h).toBe(false);
    expect(h.sessions.every((r) => !("correctionReason" in r))).toBe(true);
    expect(JSON.stringify(h)).not.toContain("Arrived late");
    const staff = read("ownerA", ids.p1);
    expect(h.percentage).toBe(staff.percentage);
    expect(h.sessions.map((r) => r.status)).toEqual(
      staff.sessions.map((r) => r.status),
    );
    refused(() => read("parent1", ids.p2), 404);
    refused(() => read("parent2", ids.p1), 404);
    refused(() => read("parent1", "no-such-player"), 404);
    expect(read("parent2", ids.p2).playerId).toBe(ids.p2);
    expect(JSON.stringify(read("parent2", ids.p2))).toContain("2026-09");
  });
  it("gives the same answer for 'not yours' and 'does not exist'", () => {
    let a = "",
      b = "";
    try {
      read("parent1", ids.p2);
    } catch (e) {
      a = (e as Error).message;
    }
    try {
      read("parent1", "nobody");
    } catch (e) {
      b = (e as Error).message;
    }
    expect(a).toBe(b);
  });
  it("keeps parents out of the follow-up list", () => {
    refused(() => attendanceFollowUps(who("parent1")), 403);
  });
  it("refuses people with no membership here and other academies' owners", async () => {
    for (const persona of ["outsider", "ownerB"] as const) {
      const response = await callRoute(historyRoute.GET, {
        path: `/api/workspaces/${A}/attendance-history?player=${ids.p1}`,
        as: persona,
        params: { academyId: A },
      });
      expect(response.status).toBe(403);
    }
    // Academy B has its own player, unreachable from A and vice versa.
    const own = await callRoute(historyRoute.GET, {
      path: `/api/workspaces/${B}/attendance-history?player=${ids.bPlayer}`,
      as: "ownerB",
      params: { academyId: B },
    });
    expect(own.status).toBe(200);
    const cross = await callRoute(historyRoute.GET, {
      path: `/api/workspaces/${B}/attendance-history?player=${ids.p1}`,
      as: "ownerB",
      params: { academyId: B },
    });
    expect(cross.status).toBe(404);
  });
});

describe("the follow-up list", () => {
  it("lists players with three consecutive absences, most first, scoped to the viewer", () => {
    held("a8", 15, ids.squadA, ids.coachA, {
      [ids.p1]: "ABSENT",
      [ids.p2]: "ABSENT",
    });
    held("a9", 16, ids.squadA, ids.coachA, {
      [ids.p1]: "ABSENT",
      [ids.p2]: "ABSENT",
    });
    held("a10", 17, ids.squadA, ids.coachA, {
      [ids.p1]: "ABSENT",
      [ids.p2]: "ABSENT",
    });
    held("b1", 15, ids.squadB, ids.coachB, { [ids.p3]: "ABSENT" });
    const owner = attendanceFollowUps(who("ownerA"));
    expect(owner.map((h) => h.playerId).sort()).toEqual(
      [ids.p1, ids.p2].sort(),
    );
    expect(owner[0].consecutiveAbsences).toBeGreaterThanOrEqual(
      owner[1].consecutiveAbsences,
    );
    expect(owner.every((h) => h.followUp)).toBe(true);
    expect(
      attendanceFollowUps(who("coachA"))
        .map((h) => h.playerId)
        .sort(),
    ).toEqual([ids.p1, ids.p2].sort());
    expect(attendanceFollowUps(who("coachB"))).toEqual([]); // p3 has only two absences
    held("b2", 16, ids.squadB, ids.coachB, { [ids.p3]: "ABSENT" });
    held("b3", 17, ids.squadB, ids.coachB, { [ids.p3]: "ABSENT" });
    expect(attendanceFollowUps(who("coachB")).map((h) => h.playerId)).toEqual([
      ids.p3,
    ]);
    expect(
      attendanceFollowUps(who("coachA")).map((h) => h.playerId),
    ).not.toContain(ids.p3);
  });
});

describe("the route", () => {
  const get = (query: string, as?: Persona, academy = A) =>
    callRoute(historyRoute.GET, {
      path: `/api/workspaces/${academy}/attendance-history${query}`,
      as,
      params: { academyId: academy },
    });
  it("answers one player or the follow-up list, and nothing else", async () => {
    const one = await get(`?player=${ids.p1}`, "ownerA");
    expect(one.status).toBe(200);
    expect((one.body as AttendanceHistory).playerId).toBe(ids.p1);
    expect(one.headers.get("cache-control")).toMatch(/no-store|private/);
    const list = await get("?followUp=1", "ownerA");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    for (const bad of [
      "",
      "?followUp=",
      `?player=${ids.p1}&followUp=1`,
      "?player=x&other=1",
      "?other=1",
    ])
      expect((await get(bad, "ownerA")).status, bad).toBe(400);
  });
  it("needs a signed-in user", async () => {
    expect((await get(`?player=${ids.p1}`)).status).toBe(401);
  });
  it("shows a parent only their child, and never the follow-up list", async () => {
    const mine = await get(`?player=${ids.p1}`, "parent1");
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/followUp|correctionReason/);
    expect((await get(`?player=${ids.p2}`, "parent1")).status).toBe(404);
    expect((await get("?followUp=1", "parent1")).status).toBe(403);
  });
});
