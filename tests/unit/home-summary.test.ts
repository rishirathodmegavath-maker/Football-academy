// WP2.3: the bootstrap and the Home summary. The bootstrap must carry exactly
// the payload's identity fields; the Home summary must agree, for every staff
// role, with the dashboard derivations that Home used to compute from the full
// payload, and must respect role scope and academy isolation.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { workspace, workspaceBootstrap } from "@/server/workspace-service";
import { homeSummary } from "@/server/home-summary-service";
import {
  academyDate,
  currentPlayerPlan,
  portalSessionSummary,
} from "@/services/portal-records";
import { monthReportProgress } from "@/services/report-period-filter";
import * as bootstrapRoute from "@/app/api/workspaces/[academyId]/bootstrap/route";
import * as homeRoute from "@/app/api/workspaces/[academyId]/home/route";
import type { HomeSummary } from "@/domain/home-summary";
import type { FootballAttendance, FootballSession } from "@/domain/training";
import type { WorkspaceConversation } from "@/domain/workspace";
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

const filename = join(
  tmpdir(),
  `sportozen-home-summary-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
// The fixture's sessions are on 1-4 September 2026 (Asia/Kolkata). Pin "now"
// to the afternoon of 3 September so two sessions are "today".
const NOW = new Date("2026-09-03T12:00:00.000Z");
const stamp = {
  version: 1,
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: ids.ownerA,
};
beforeAll(() => {
  seedApiFixture();
  // A scheduled session for tomorrow in squad A with unmarked attendance, and
  // one open conversation, so the upcoming/unmarked/conversation figures are
  // exercised. The fixture itself has only completed sessions.
  const base = repo.find(A, "session", `session-${ids.squadA}-1`)!;
  const next: FootballSession = {
    ...base,
    id: "session-next",
    startLocal: "2026-09-04T17:00",
    endLocal: "2026-09-04T18:00",
    startAt: "2026-09-04T11:30:00.000Z",
    endAt: "2026-09-04T12:30:00.000Z",
    theme: "",
    title: "Synthetic fixture match",
    status: "SCHEDULED",
    sharedObjective: {
      goal: "Synthetic shared goal",
      observe: "Synthetic shared observation",
    } as FootballSession["sharedObjective"],
  };
  repo.save(A, "session", next);
  const today = repo.find(A, "session", `session-${ids.squadA}-3`)!;
  for (const playerId of [ids.p1, ids.p2]) {
    const mark: FootballAttendance = {
      id: `${today.id}:${playerId}`,
      academyId: A,
      sportId: "football",
      ...stamp,
      sessionId: today.id,
      playerId,
      status: "UNMARKED",
      correctionReason: "",
    };
    repo.save(A, "attendance", mark);
  }
  const conversation: WorkspaceConversation = {
    id: "conversation-1",
    academyId: A,
    ...stamp,
    guardianId: ids.parent1,
    playerId: ids.p1,
    subject: "Synthetic question",
    status: "OPEN",
    messages: [
      {
        id: "m1",
        senderId: ids.parent1,
        senderRole: "PARENT",
        body: "Synthetic public message",
        at: "2026-09-10T05:00:00.000Z",
        internal: false,
      },
      {
        id: "m2",
        senderId: ids.coachA,
        senderRole: "COACH",
        body: "SYNTHETIC INTERNAL NOTE",
        at: "2026-09-10T06:00:00.000Z",
        internal: true,
      },
    ],
  };
  repo.save(A, "conversation", conversation);
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const staff: Persona[] = ["ownerA", "adminA", "coachA", "coachB"];
const everyone: Persona[] = [
  "ownerA",
  "adminA",
  "coachA",
  "coachB",
  "parent1",
  "parent2",
  "ownerB",
];

describe("bootstrap", () => {
  it.each(everyone)(
    "%s: carries exactly the payload's identity fields",
    (persona) => {
      const ctx = contextFor(persona);
      const boot = workspaceBootstrap(ctx),
        full = workspace(ctx);
      expect(boot.academy).toEqual(full.academy);
      expect(boot.membership).toEqual(full.membership);
      expect(boot.viewer).toEqual(full.viewer);
      expect(Object.keys(boot).sort()).toEqual([
        "academy",
        "membership",
        "viewer",
      ]);
    },
  );
  it("is a small fraction of the full payload and reads nothing extra", async () => {
    const ctx = contextFor("ownerA");
    const { queries } = await countQueries(() => workspaceBootstrap(ctx));
    expect(queries).toBe(0);
    const route = await callRoute(bootstrapRoute.GET, {
      path: `/api/workspaces/${A}/bootstrap`,
      as: "ownerA",
      params: { academyId: A },
    });
    expect(route.status).toBe(200);
    expect(route.headers.get("cache-control")).toBe("no-store, private");
    expect(route.bytes).toBeLessThan(2000);
    expect(route.bytes).toBeLessThan(JSON.stringify(workspace(ctx)).length / 4);
  });
  it("is refused to signed-out users, outsiders and other academies", async () => {
    const call = (as?: Persona, academyId = A) =>
      callRoute(bootstrapRoute.GET, {
        path: `/api/workspaces/${academyId}/bootstrap`,
        as,
        params: { academyId },
      });
    expect((await call()).status).toBe(401);
    expect((await call("outsider")).status).toBe(403);
    expect((await call("ownerB", A)).status).toBe(403);
    expect((await call("ownerA", B)).status).toBe(403);
    expect(((await call("ownerA", B)).body as { error: string }).error).toBe(
      "No active membership in this academy.",
    );
  });
});

describe("home summary equals the dashboard derived from the full payload", () => {
  // The derivations Home used before the summary, applied to the full payload.
  function expected(persona: Persona) {
    const d = workspace(contextFor(persona)),
      s = portalSessionSummary(d, NOW),
      month = s.today.slice(0, 7);
    const monthly = monthReportProgress(d.records.report, month),
      focusPlayer = d.records.player.find((p) => currentPlayerPlan(d, p.id));
    return {
      today: s.today,
      nextSession: s.next?.id,
      todaySessions: s.todaySessions.slice(0, 3).map((x) => x.id),
      upcomingSessions: s.upcoming.length,
      // Upcoming sessions on days after today, soonest first, five at most.
      comingSessions: s.upcoming
        .filter((x) => academyDate(d, new Date(x.startAt)) !== s.today)
        .slice(0, 5)
        .map((x) => x.id),
      activePlayers: d.records.player.filter((p) => p.status !== "INACTIVE")
        .length,
      batches: d.records.squad.length,
      openConversations: d.records.conversation.filter(
        (c) => c.status === "OPEN",
      ).length,
      observationsToReview: d.records.evidence.filter((e) =>
        ["DRAFT", "AWAITING_REVIEW"].includes(e.status),
      ).length,
      reportDrafts: d.records.report.filter((r) => r.status !== "Approved")
        .length,
      unmarkedToday: d.records.attendance.filter(
        (a) =>
          s.todaySessions.some((x) => x.id === a.sessionId) &&
          a.status === "UNMARKED",
      ).length,
      focusPlayer: focusPlayer?.name,
      reportsThisMonth: { month, ...monthly },
      approvedReports: d.records.report.filter((r) => r.status === "Approved")
        .length,
      hasBranch: d.records.branch.length > 0,
    };
  }
  it.each(staff)("%s", (persona) => {
    const summary = homeSummary(contextFor(persona), NOW),
      want = expected(persona);
    expect(summary.today).toBe(want.today);
    expect(summary.nextSession?.id).toBe(want.nextSession);
    expect(summary.todaySessions.map((x) => x.id)).toEqual(want.todaySessions);
    expect(summary.upcomingSessions).toBe(want.upcomingSessions);
    expect(summary.comingSessions.map((x) => x.id)).toEqual(want.comingSessions);
    expect(summary.comingSessions.length).toBeLessThanOrEqual(5);
    expect(summary.activePlayers).toBe(want.activePlayers);
    expect(summary.batches).toBe(want.batches);
    expect(summary.openConversations).toBe(want.openConversations);
    expect(summary.observationsToReview.count).toBe(want.observationsToReview);
    expect(summary.reportDrafts).toBe(want.reportDrafts);
    expect(summary.unmarkedToday.count).toBe(want.unmarkedToday);
    expect(summary.focus?.playerName).toBe(want.focusPlayer);
    expect(summary.reportsThisMonth).toEqual(want.reportsThisMonth);
    expect(summary.approvedReports).toBe(want.approvedReports);
    expect(summary.hasBranch).toBe(want.hasBranch);
  });
  it("also matches the academy-local date used elsewhere", () => {
    const ctx = contextFor("ownerA");
    expect(homeSummary(ctx, NOW).today).toBe(academyDate(workspace(ctx), NOW));
    // 18:29 UTC on 3 Sept is still 3 Sept in Kolkata; 18:30 UTC is 4 Sept.
    expect(homeSummary(ctx, new Date("2026-09-03T18:29:00.000Z")).today).toBe(
      "2026-09-03",
    );
    expect(homeSummary(ctx, new Date("2026-09-03T18:30:00.000Z")).today).toBe(
      "2026-09-04",
    );
  });
});

describe("home summary figures on the fixture", () => {
  it("shows the owner the whole academy", () => {
    const s = homeSummary(contextFor("ownerA"), NOW);
    expect(s.activePlayers).toBe(3);
    expect(s.batches).toBe(2);
    expect(s.todaySessions.map((x) => x.id).sort()).toEqual([
      `session-${ids.squadA}-3`,
      `session-${ids.squadB}-3`,
    ]);
    expect(s.nextSession).toMatchObject({
      id: "session-next",
      title: "Synthetic fixture match",
      rosterCount: 2,
      sharedObjective: { goal: "Synthetic shared goal" },
    });
    expect(s.upcomingSessions).toBe(1);
    expect(s.unmarkedToday.count).toBe(2);
    expect(s.unmarkedToday.firstSessionId).toBe(`session-${ids.squadA}-3`);
    expect(s.reportsThisMonth).toEqual({
      month: "2026-09",
      total: 3,
      approved: 3,
    });
    expect(s.approvedReports).toBe(3);
    expect(s.hasBranch).toBe(true);
    expect(s.openConversations).toBe(1);
  });
  it("shows a coach only their own players, sessions and reports", () => {
    const a = homeSummary(contextFor("coachA"), NOW),
      b = homeSummary(contextFor("coachB"), NOW);
    expect(a.activePlayers).toBe(2);
    expect(a.batches).toBe(1);
    expect(a.reportsThisMonth.total).toBe(2);
    expect(a.unmarkedToday.count).toBe(2);
    expect(b.activePlayers).toBe(1);
    expect(b.batches).toBe(1);
    expect(b.reportsThisMonth.total).toBe(1);
    expect(b.unmarkedToday.count).toBe(0);
    expect(b.upcomingSessions).toBe(0);
    expect(b.nextSession).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("session-next");
    expect(b.recent.map((r) => r.kind)).not.toContain("CONVERSATION");
  });
  it("lists recent activity newest first without internal notes", () => {
    const s = homeSummary(contextFor("ownerA"), NOW);
    expect(s.recent.length).toBeLessThanOrEqual(4);
    const dates = s.recent.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const text = JSON.stringify(s);
    expect(text).not.toContain("SYNTHETIC INTERNAL NOTE");
    expect(text).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    const chat = s.recent.find((r) => r.kind === "CONVERSATION");
    expect(chat).toMatchObject({
      subject: "Synthetic question",
      playerId: ids.p1,
    });
  });
  it("is much smaller than the full payload", async () => {
    const ctx = contextFor("ownerA");
    const home = JSON.stringify(homeSummary(ctx, NOW)).length;
    expect(home).toBeLessThan(4000);
    expect(home).toBeLessThan(JSON.stringify(workspace(ctx)).length / 3);
  });
});

describe("home summary authorisation", () => {
  const call = (as?: Persona, academyId = A) =>
    callRoute(homeRoute.GET, {
      path: `/api/workspaces/${academyId}/home`,
      as,
      params: { academyId },
    });
  it("serves owners, admins and coaches", async () => {
    for (const persona of staff) {
      const response = await call(persona);
      expect(response.status, persona).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect((response.body as HomeSummary).academyId).toBe(A);
    }
  });
  it("refuses parents, outsiders, signed-out users and other academies' owners", async () => {
    const refused = async (as?: Persona, academyId = A) =>
      (await call(as, academyId)) as {
        status: number;
        body: { error: string };
      };
    expect(await refused("parent1")).toMatchObject({
      status: 403,
      body: { error: "Your academy role cannot perform this action." },
    });
    expect((await refused("outsider")).status).toBe(403);
    expect((await refused()).status).toBe(401);
    expect((await refused("ownerB", A)).status).toBe(403);
    expect((await refused("ownerA", B)).status).toBe(403);
  });
  it("never shows academy B's data to academy A's staff, or the reverse", async () => {
    const a = (await call("ownerA")).body as HomeSummary,
      b = (await call("ownerB", B)).body as HomeSummary;
    expect(a.academyId).toBe(A);
    expect(b.academyId).toBe(B);
    expect(b.activePlayers).toBe(1);
    expect(b.upcomingSessions).toBe(0);
    expect(JSON.stringify(b)).not.toContain("session-");
  });
  it("sees a coach reassignment and a revoked membership on the next request", async () => {
    const db = database();
    const body = () =>
      db
        .prepare(
          "SELECT body FROM workspace_records WHERE academyId=? AND kind='player' AND id=?",
        )
        .get(A, ids.p2)!.body as string;
    const original = body();
    try {
      expect(homeSummary(contextFor("coachA"), NOW).activePlayers).toBe(2);
      db.prepare(
        "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
      ).run(
        JSON.stringify({ ...JSON.parse(original), coachId: ids.coachB }),
        A,
        ids.p2,
      );
      expect(homeSummary(contextFor("coachA"), NOW).activePlayers).toBe(1);
    } finally {
      db.prepare(
        "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
      ).run(original, A, ids.p2);
    }
    expect((await call("coachA")).status).toBe(200);
    db.prepare(
      "UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?",
    ).run(A, ids.coachA);
    try {
      expect((await call("coachA")).status).toBe(403);
    } finally {
      db.prepare(
        "UPDATE academy_memberships SET active=1 WHERE academyId=? AND userId=?",
      ).run(A, ids.coachA);
    }
  });
  it("refuses a support member and leaves support auditing to its existing reads", async () => {
    const db = database();
    try {
      db.prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
      ).run("m-support-home", A, ids.outsider, "SUPPORT", '["football"]');
      db.prepare(
        "INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)",
      ).run(A, ids.outsider, ids.p1);
      const audits = () =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM workspace_audit WHERE academyId=? AND action='Authorised support read'",
            )
            .get(A)!.n,
        );
      const before = audits();
      expect((await call("outsider")).status).toBe(403);
      expect(audits()).toBe(before);
      const boot = await callRoute(bootstrapRoute.GET, {
        path: `/api/workspaces/${A}/bootstrap`,
        as: "outsider",
        params: { academyId: A },
      });
      expect(boot.status).toBe(200);
      expect(audits()).toBe(before);
    } finally {
      db.prepare(
        "DELETE FROM support_relationships WHERE academyId=? AND userId=? AND playerId=?",
      ).run(A, ids.outsider, ids.p1);
      db.prepare(
        "DELETE FROM academy_memberships WHERE id=? AND academyId=? AND userId=?",
      ).run("m-support-home", A, ids.outsider);
    }
  });
});

describe("home summary cost", () => {
  it.each([
    ["ownerA", 30],
    ["coachA", 40],
    ["coachB", 40],
  ] as const)("%s stays within %i SQL statements", async (persona, limit) => {
    const ctx = contextFor(persona);
    const { queries } = await countQueries(() => homeSummary(ctx, NOW));
    expect(queries).toBeLessThanOrEqual(limit);
  });
});
