// WP2.4: the focused records reads. Filters, summaries and paging only ever
// narrow what visibleRecords already allows; a request without query
// parameters is the long-standing response.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { visibleRecords } from "@/server/workspace-access";
import { workspace } from "@/server/workspace-service";
import { periodAction } from "@/server/period-service";
import { reportPresentation } from "@/services/reports/report-presentation";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import type {
  RecordPage,
  ReportSummary,
  SessionSummary,
} from "@/domain/records-query";
import type { WorkspaceReport } from "@/domain/workspace";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  countQueries,
  seedApiFixture,
  type Fixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-records-query-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let fixture: Fixture;
beforeAll(() => {
  fixture = seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const read = (
  as: Persona | undefined,
  kind: string,
  query = "",
  academyId = A,
) =>
  callRoute(recordsRoute.GET, {
    path: `/api/workspaces/${academyId}/records/${kind}${query}`,
    as,
    params: { academyId, kind },
  });
const rows = (response: { body: unknown }) => response.body as { id: string }[];
const page = (response: { body: unknown }) =>
  response.body as RecordPage<{ id: string }>;
const idsOf = (response: { body: unknown }) =>
  rows(response)
    .map((r) => r.id)
    .sort();

describe("without query parameters the response is unchanged", () => {
  it.each([
    ["ownerA", "report"],
    ["ownerA", "session"],
    ["coachA", "attendance"],
    ["coachB", "evidence"],
    ["parent1", "report"],
    ["parent1", "player"],
  ] as const)("%s %s", async (persona, kind) => {
    const response = await read(persona, kind);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      JSON.parse(JSON.stringify(visibleRecords(contextFor(persona), kind))),
    );
  });
});

describe("paging", () => {
  it("walks every record exactly once, in the stored order", async () => {
    const whole = idsOf(await read("ownerA", "attendance"));
    const seen: string[] = [];
    let cursor: number | null = 0,
      pages = 0;
    while (cursor !== null) {
      const response = await read(
        "ownerA",
        "attendance",
        `?limit=5&cursor=${cursor}`,
      );
      expect(response.status).toBe(200);
      const p = page(response);
      expect(p.total).toBe(whole.length);
      expect(p.items.length).toBeLessThanOrEqual(5);
      seen.push(...p.items.map((r) => r.id));
      cursor = p.nextCursor;
      pages++;
    }
    expect(pages).toBe(Math.ceil(whole.length / 5));
    expect([...seen].sort()).toEqual(whole);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it("gives an empty last page for a cursor past the end", async () => {
    expect(page(await read("ownerA", "player", "?limit=2&cursor=50"))).toEqual({
      items: [],
      total: 3,
      nextCursor: null,
    });
  });
  it.each([
    "limit=0",
    "limit=201",
    "limit=abc",
    "limit=1.5",
    "limit=1&cursor=-1",
    "cursor=2",
  ])("rejects %s", async (query) => {
    const response = await read("ownerA", "player", `?${query}`);
    expect(response.status).toBe(400);
  });
});

describe("filters", () => {
  it("narrows sessions by date window, batch, coach and status", async () => {
    expect(
      (await read("ownerA", "session", "?from=2026-09-02&to=2026-09-03")).body,
    ).toHaveLength(4);
    expect(
      (await read("ownerA", "session", "?from=2026-09-04")).body,
    ).toHaveLength(2);
    expect(
      (await read("ownerA", "session", "?to=2026-08-31")).body,
    ).toHaveLength(0);
    expect(
      (await read("ownerA", "session", `?squad=${ids.squadA}`)).body,
    ).toHaveLength(4);
    expect(
      (await read("ownerA", "session", `?coach=${ids.coachB}`)).body,
    ).toHaveLength(4);
    expect(
      (await read("ownerA", "session", "?status=COMPLETED")).body,
    ).toHaveLength(8);
    expect(
      (await read("ownerA", "session", "?status=SCHEDULED")).body,
    ).toHaveLength(0);
    expect(
      (await read("ownerA", "session", `?player=${ids.p3}`)).body,
    ).toHaveLength(4);
    expect(
      (await read("coachA", "session", "?from=2026-09-02&to=2026-09-03")).body,
    ).toHaveLength(2);
  });
  it("narrows attendance and evidence by session, player, status and date", async () => {
    const first = `session-${ids.squadA}-1`;
    expect(
      (await read("ownerA", "attendance", `?session=${first}`)).body,
    ).toHaveLength(2);
    expect(
      (await read("ownerA", "attendance", `?player=${ids.p3}`)).body,
    ).toHaveLength(4);
    expect(
      (await read("ownerA", "attendance", "?status=ABSENT")).body,
    ).toHaveLength(3);
    expect(
      (await read("coachA", "attendance", "?status=ABSENT")).body,
    ).toHaveLength(2);
    expect(
      (await read("ownerA", "attendance", "?from=2026-09-04")).body,
    ).toHaveLength(3);
    expect(
      (await read("ownerA", "evidence", `?session=${first}&player=${ids.p1}`))
        .body,
    ).toHaveLength(1);
    expect(
      (
        await read(
          "ownerA",
          "evidence",
          "?status=REVIEWED&from=2026-09-03&to=2026-09-03",
        )
      ).body,
    ).toHaveLength(3);
  });
  it("narrows players by name, status, batch and coach", async () => {
    expect(idsOf(await read("ownerA", "player", "?q=synthetic"))).toHaveLength(
      3,
    );
    expect(idsOf(await read("ownerA", "player", "?q=ZZZ"))).toEqual([]);
    expect(
      idsOf(await read("ownerA", "player", "?status=ACTIVE")),
    ).toHaveLength(3);
    expect(idsOf(await read("ownerA", "player", "?status=INACTIVE"))).toEqual(
      [],
    );
    expect(
      idsOf(await read("ownerA", "player", `?coach=${ids.coachA}`)),
    ).toEqual([ids.p1, ids.p2].sort());
    expect(
      idsOf(await read("ownerA", "player", `?squad=${ids.squadB}`)),
    ).toEqual([ids.p3]);
    expect(
      page(await read("ownerA", "player", "?q=synthetic&limit=2")).items,
    ).toHaveLength(2);
  });
  it("narrows reports and plans by player, period and status", async () => {
    expect(idsOf(await read("ownerA", "report", `?player=${ids.p1}`))).toEqual([
      fixture.reports[ids.p1],
    ]);
    expect(
      (await read("ownerA", "report", "?period=2026-09")).body,
    ).toHaveLength(3);
    expect(
      (await read("ownerA", "report", "?period=2026-08")).body,
    ).toHaveLength(0);
    expect(
      (await read("ownerA", "report", "?status=Approved")).body,
    ).toHaveLength(3);
    expect((await read("ownerA", "report", "?status=Draft")).body).toHaveLength(
      0,
    );
    expect(
      (await read("ownerA", "plan", `?player=${ids.p2}`)).body,
    ).toHaveLength(1);
  });
  it("rejects filters the record type does not support, and unknown parameters", async () => {
    for (const [kind, query] of [
      ["report", "?squad=x"],
      ["player", "?from=2026-09-01"],
      ["drill", "?status=x"],
      ["session", "?q=x"],
      ["report", "?unknown=1"],
      ["player", "?view=summary"],
      ["session", "?from=2026-9-1"],
      ["session", "?from=2026-09-04&to=2026-09-01"],
    ])
      expect(
        (await read("ownerA", kind, query)).status,
        `${kind}${query}`,
      ).toBe(400);
  });
});

describe("authorisation", () => {
  it("never widens what the viewer may read", async () => {
    // A coach cannot reach another coach's player by naming them.
    expect(idsOf(await read("coachA", "player"))).toEqual(
      [ids.p1, ids.p2].sort(),
    );
    expect(
      await read("coachA", "player", `?coach=${ids.coachB}`),
    ).toMatchObject({ body: [] });
    expect(await read("coachB", "report", `?player=${ids.p1}`)).toMatchObject({
      body: [],
    });
    expect(
      await read("coachB", "attendance", `?player=${ids.p1}`),
    ).toMatchObject({ body: [] });
    // A parent sees only their own child's approved reports, and no training records.
    expect(idsOf(await read("parent1", "report", "?period=2026-09"))).toEqual([
      fixture.reports[ids.p1],
    ]);
    expect(await read("parent1", "report", `?player=${ids.p2}`)).toMatchObject({
      body: [],
    });
    for (const kind of ["session", "attendance", "evidence"])
      expect(await read("parent1", kind, "?limit=10")).toMatchObject({
        body: { items: [], total: 0, nextCursor: null },
      });
  });
  it("keeps academies apart and refuses outsiders and signed-out users", async () => {
    expect((await read("ownerB", "player", "", B)).body).toHaveLength(1);
    expect(
      (await read("ownerB", "player", `?q=synthetic&limit=5`, B)).body,
    ).toMatchObject({ total: 1 });
    expect((await read("ownerB", "player", "?q=synthetic", A)).status).toBe(
      403,
    );
    expect((await read("outsider", "report", "?period=2026-09")).status).toBe(
      403,
    );
    expect((await read(undefined, "report", "?period=2026-09")).status).toBe(
      401,
    );
  });
  it("applies the same access check on every filtered request", async () => {
    const db = database();
    expect((await read("coachA", "session", "?from=2026-09-01")).status).toBe(
      200,
    );
    db.prepare(
      "UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?",
    ).run(A, ids.coachA);
    try {
      expect((await read("coachA", "session", "?from=2026-09-01")).status).toBe(
        403,
      );
    } finally {
      db.prepare(
        "UPDATE academy_memberships SET active=1 WHERE academyId=? AND userId=?",
      ).run(A, ids.coachA);
    }
  });
  it("audits each filtered read by a support member", async () => {
    const db = database();
    try {
      db.prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
      ).run("m-support-rq", A, ids.outsider, "SUPPORT", '["football"]');
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
      const first = await read("outsider", "report", "?period=2026-09");
      const second = await read("outsider", "report", "?limit=1");
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(idsOf(first)).toEqual([fixture.reports[ids.p1]]);
      expect(audits() - before).toBe(2);
    } finally {
      db.prepare(
        "DELETE FROM support_relationships WHERE academyId=? AND userId=? AND playerId=?",
      ).run(A, ids.outsider, ids.p1);
      db.prepare(
        "DELETE FROM academy_memberships WHERE id=? AND academyId=? AND userId=?",
      ).run("m-support-rq", A, ids.outsider);
    }
  });
});

describe("summaries", () => {
  it("lists reports without snapshots, sources or plans", async () => {
    const full = await read("ownerA", "report"),
      summary = await read("ownerA", "report", "?view=summary");
    expect(summary.status).toBe(200);
    const items = summary.body as ReportSummary[];
    expect(items.map((r) => r.id).sort()).toEqual(idsOf(full));
    for (const item of items) {
      const source = (full.body as WorkspaceReport[]).find(
        (r) => r.id === item.id,
      )!;
      expect(item).not.toHaveProperty("snapshot");
      expect(item).not.toHaveProperty("monthlySources");
      expect(item).not.toHaveProperty("approvedPlan");
      expect(item).toMatchObject({
        playerId: source.playerId,
        period: source.period,
        status: source.status,
        recordVersion: source.recordVersion,
        hasSnapshot: true,
        monthly: false,
        periodLabel: reportPresentation(source.snapshot!).periodLabel,
      });
    }
    expect(summary.bytes).toBeLessThan(full.bytes / 3);
  });
  it("carries the approved focus and next step so history lists need no detail read", async () => {
    const full = (await read("ownerA", "report")).body as WorkspaceReport[],
      summary = (await read("ownerA", "report", "?view=summary"))
        .body as ReportSummary[];
    for (const item of summary) {
      const source = full.find((r) => r.id === item.id)!;
      expect(item.focus).toBe(source.snapshot!.focus);
      expect(item.nextStep).toBe(source.snapshot!.nextStep);
    }
  });
  it("reads one player's scheduled sessions without agenda or objectives", async () => {
    // The fixture's sessions are all completed: none are scheduled.
    expect(
      (
        await read(
          "ownerA",
          "session",
          `?view=summary&status=SCHEDULED&player=${ids.p1}`,
        )
      ).body,
    ).toEqual([]);
    const completed = (
      await read(
        "ownerA",
        "session",
        `?view=summary&status=COMPLETED&player=${ids.p1}`,
      )
    ).body as SessionSummary[];
    expect(completed).toHaveLength(4);
    expect(
      completed.every((s) => s.roster.some((p) => p.playerId === ids.p1)),
    ).toBe(true);
    expect(completed.every((s) => !("agenda" in s))).toBe(true);
    // Another coach's player yields nothing.
    expect(
      (
        await read(
          "coachB",
          "session",
          `?view=summary&status=COMPLETED&player=${ids.p1}`,
        )
      ).body,
    ).toEqual([]);
  });
  it("shows a parent only their child's approved reports in summary form", async () => {
    const summary = (await read("parent1", "report", "?view=summary"))
      .body as ReportSummary[];
    expect(summary.map((r) => r.id)).toEqual([fixture.reports[ids.p1]]);
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
  });
  it("lists sessions without agenda, objectives or notes but with the agenda size", async () => {
    const full = (await read("ownerA", "session")).body as {
        id: string;
        agenda: unknown[];
      }[],
      summary = (await read("ownerA", "session", "?view=summary"))
        .body as SessionSummary[];
    expect(summary.map((s) => s.id)).toEqual(full.map((s) => s.id));
    for (const s of summary) {
      expect(s).not.toHaveProperty("agenda");
      expect(s).not.toHaveProperty("objectives");
      expect(s.agendaItems).toBe(
        full.find((x) => x.id === s.id)!.agenda.length,
      );
      expect(s.roster.length).toBeGreaterThan(0);
    }
  });
  it("pages summaries", async () => {
    const response = page(
      await read("ownerA", "session", "?view=summary&limit=3&from=2026-09-02"),
    );
    expect(response.items).toHaveLength(3);
    expect(response.total).toBe(6);
    expect(response.nextCursor).toBe(3);
  });
});

describe("a monthly draft reports whether its sources are current", () => {
  it("matches the academy payload and re-checks when the report is opened", async () => {
    const owner = contextFor("ownerA");
    const [draft] = (await periodAction(owner, {
      requestId: randomUUID(),
      action: "monthlyPrepare",
      data: { playerIds: [ids.p2], month: "2026-09" },
    })) as WorkspaceReport[];
    expect(draft.monthlySources).toBeDefined();
    // The source check is opt-in (`review=1`): only the monthly review
    // queue shows it.
    const list = async (review = "&review=1") =>
      (
        (
          await read(
            "ownerA",
            "report",
            `?view=summary&player=${ids.p2}&status=Draft${review}`,
          )
        ).body as ReportSummary[]
      ).find((r) => r.id === draft.id)!;
    const detail = async (as: Persona = "ownerA") =>
      callRoute(recordRoute.GET, {
        path: `/api/workspaces/${A}/records/report/${draft.id}?review=1`,
        as,
        params: { academyId: A, kind: "report", recordId: draft.id },
      });
    expect(await list()).toMatchObject({
      monthly: true,
      hasSnapshot: false,
      sourcesCurrent: true,
    });
    // Without the opt-in the summary carries no source check at all.
    const plain = await list("");
    expect(plain.sourcesCurrent).toBeUndefined();
    expect(plain.staleReason).toBeUndefined();
    expect(workspace(owner).monthlyReportReview?.[draft.id]).toEqual({
      sourcesCurrent: true,
    });
    expect((await detail()).body).toMatchObject({
      report: { id: draft.id, monthlySources: expect.any(Object) },
      review: { sourcesCurrent: true },
    });
    // A new reviewed observation changes the month's training sources.
    const evidence = repo.find(
      A,
      "evidence",
      `evidence-session-${ids.squadA}-2-${ids.p2}`,
    )!;
    repo.save(A, "evidence", {
      ...evidence,
      observation: "Changed after the draft was prepared",
    });
    const stale = await list();
    expect(stale.sourcesCurrent).toBe(false);
    expect(stale.staleReason).toMatch(/sources changed/i);
    expect(workspace(owner).monthlyReportReview?.[draft.id]).toEqual({
      sourcesCurrent: false,
      reason: stale.staleReason,
    });
    expect((await detail()).body).toMatchObject({
      review: { sourcesCurrent: false, reason: stale.staleReason },
    });
    // Another coach's draft is not reachable by id.
    expect((await detail("coachB")).status).toBe(404);
    // The review view exists for reports only.
    const wrong = await callRoute(recordRoute.GET, {
      path: `/api/workspaces/${A}/records/player/${ids.p1}?review=1`,
      as: "ownerA",
      params: { academyId: A, kind: "player", recordId: ids.p1 },
    });
    expect(wrong.status).toBe(400);
    // The opt-in belongs to the report summary view only.
    for (const [kind, query] of [
      ["report", "?review=1"],
      ["report", "?view=content&player=" + ids.p1 + "&review=1"],
      ["session", "?view=summary&review=1"],
      ["report", "?view=summary&review=2"],
    ] as const)
      expect((await read("ownerA", kind, query)).status, kind + query).toBe(
        400,
      );
  });
  it("is much cheaper than the whole payload", async () => {
    const ctx = contextFor("ownerA");
    const request = await countQueries(() =>
      read("ownerA", "report", "?view=summary&limit=3"),
    );
    const whole = await countQueries(() => workspace(ctx));
    expect(request.queries).toBeLessThan(whole.queries);
  });
});

describe("the training records behind a monthly report", () => {
  type Sources = {
    sessions: { id: string; startAt: string }[];
    evidence: Record<string, unknown>[];
    attendance: { sessionId: string; playerId: string; status: string }[];
    drills: { id: string; focusArea: string }[];
  };
  const open = (
    as: Persona | undefined,
    reportId: string,
    query = "?sources=1",
    academyId = A,
  ) =>
    callRoute(recordRoute.GET, {
      path: `/api/workspaces/${academyId}/records/report/${reportId}${query}`,
      as,
      params: { academyId, kind: "report", recordId: reportId },
    });
  async function draftFor(playerId: string) {
    const [draft] = (await periodAction(contextFor("ownerA"), {
      requestId: randomUUID(),
      action: "monthlyPrepare",
      data: { playerIds: [playerId], month: "2026-09" },
    })) as WorkspaceReport[];
    return draft;
  }
  it("returns the sessions, reviewed observations, attendance and drill focus the draft was built from", async () => {
    const draft = await draftFor(ids.p1);
    const response = await open("ownerA", draft.id);
    expect(response.status).toBe(200);
    const { report, sources } = response.body as {
      report: WorkspaceReport;
      sources: Sources;
    };
    expect(report.id).toBe(draft.id);
    const saved = draft.monthlySources!;
    expect(sources.sessions.length).toBeGreaterThan(0);
    expect(sources.sessions.map((x) => x.id).sort()).toEqual(
      [...saved.sessionIds].sort(),
    );
    for (const entry of sources.evidence) {
      expect(saved.evidenceIds).toContain(entry.id);
      expect(Object.keys(entry).sort()).toEqual([
        "id",
        "observation",
        "playerId",
        "sessionId",
      ]);
    }
    expect(JSON.stringify(sources)).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    expect(sources.attendance.length).toBeGreaterThan(0);
    for (const mark of sources.attendance) {
      expect(mark.playerId).toBe(ids.p1);
      expect(saved.sessionIds).toContain(mark.sessionId);
    }
    for (const drill of sources.drills)
      expect(Object.keys(drill).sort()).toEqual(["focusArea", "id"]);
    // It agrees with what the whole payload offers for the same report.
    const everything = workspace(contextFor("ownerA"));
    expect(
      everything.records.session
        .filter((x) => saved.sessionIds.includes(x.id))
        .map((x) => x.id)
        .sort(),
    ).toEqual(sources.sessions.map((x) => x.id).sort());
    expect(
      everything.records.evidence
        .filter(
          (x) => saved.evidenceIds.includes(x.id) && x.status === "REVIEWED",
        )
        .map((x) => x.id)
        .sort(),
    ).toEqual(sources.evidence.map((x) => x.id as string).sort());
  });
  it("can be requested together with the source check", async () => {
    const draft = await draftFor(ids.p1);
    const both = (await open("ownerA", draft.id, "?review=1&sources=1"))
      .body as Record<string, unknown>;
    expect(Object.keys(both).sort()).toEqual(["report", "review", "sources"]);
    const only = (await open("ownerA", draft.id, "?sources=1")).body as Record<
      string,
      unknown
    >;
    expect(Object.keys(only).sort()).toEqual(["report", "sources"]);
    // Neither parameter: the long-standing response, the bare report.
    expect(
      (await open("ownerA", draft.id, "")).body as WorkspaceReport,
    ).toMatchObject({ id: draft.id });
  });
  it("shows a coach only their own player's draft, and refuses everyone else the same way", async () => {
    const own = await draftFor(ids.p1);
    const other = await draftFor(ids.p3);
    expect((await open("coachA", own.id)).status).toBe(200);
    expect((await open("coachA", other.id)).status).toBe(404);
    expect((await open("coachB", other.id)).status).toBe(200);
    expect((await open("coachB", own.id)).status).toBe(404);
    // Unapproved drafts are not visible to parents at all.
    expect((await open("parent1", own.id)).status).toBe(404);
    expect((await open("parent2", own.id)).status).toBe(404);
    expect((await open("ownerB", own.id, "?sources=1", B)).status).toBe(404);
    expect((await open("ownerB", own.id)).status).toBe(403);
    expect((await open("outsider", own.id)).status).toBe(403);
    expect((await open(undefined, own.id)).status).toBe(401);
  });
  it("gives a parent nothing of the sources behind an approved report", async () => {
    const approved = fixture.reports[ids.p1];
    const response = await open("parent1", approved);
    expect(response.status).toBe(200);
    const body = response.body as { report: WorkspaceReport; sources: Sources };
    expect(body.report.monthlySources).toBeUndefined();
    expect(body.sources).toEqual({
      sessions: [],
      evidence: [],
      attendance: [],
      drills: [],
    });
  });
  it("is available for reports only, and only as 1", async () => {
    const draft = await draftFor(ids.p1);
    expect((await open("ownerA", draft.id, "?sources=2")).status).toBe(400);
    const player = await callRoute(recordRoute.GET, {
      path: `/api/workspaces/${A}/records/player/${ids.p1}?sources=1`,
      as: "ownerA",
      params: { academyId: A, kind: "player", recordId: ids.p1 },
    });
    expect(player.status).toBe(400);
  });
  it("lists the draft's review state without its text", async () => {
    const draft = await draftFor(ids.p1);
    const listed = (
      (
        await read(
          "ownerA",
          "report",
          `?view=summary&player=${ids.p1}&review=1`,
        )
      ).body as ReportSummary[]
    ).find((r) => r.id === draft.id)!;
    expect(listed.untouched).toBe(
      !draft.observation.trim() &&
        !draft.nextStep.trim() &&
        !draft.closingNote.trim(),
    );
    expect(listed.hasNextStep).toBe(Boolean(draft.nextStep.trim()));
    expect(JSON.stringify(listed)).not.toContain(draft.closingNote || "\u0000");
    expect(listed).not.toHaveProperty("observation");
    expect(listed).not.toHaveProperty("monthlySources");
  });
});

describe("the academy payload limited to some record kinds", () => {
  const get = (as: Persona | undefined, query = "", academyId = A) =>
    callRoute(workspaceRoute.GET, {
      path: `/api/workspaces/${academyId}${query}`,
      as,
      params: { academyId },
    });
  type Payload = {
    records: Record<string, unknown[]>;
    loadedKinds?: string[];
    [key: string]: unknown;
  };
  it("is unchanged without the parameter", async () => {
    const response = await get("ownerA");
    expect((response.body as Payload).loadedKinds).toBeUndefined();
    expect(response.body).toEqual(
      JSON.parse(JSON.stringify(workspace(contextFor("ownerA")))),
    );
  });
  it.each(["ownerA", "coachA", "coachB", "parent1"] as const)(
    "%s: each loaded kind equals the full payload; the rest are empty",
    async (persona) => {
      const wanted = ["player", "squad", "session"];
      const full = (await get(persona)).body as Payload,
        part = (await get(persona, `?kinds=${wanted.join(",")}`))
          .body as Payload;
      expect(part.loadedKinds).toEqual(wanted);
      for (const kind of Object.keys(full.records))
        expect(part.records[kind], kind).toEqual(
          wanted.includes(kind) ? full.records[kind] : [],
        );
      for (const field of ["academy", "membership", "viewer", "members"])
        expect(part[field], field).toEqual(full[field]);
    },
  );
  it("applies the viewer's own scope to the kinds it loads", async () => {
    const coach = (await get("coachA", "?kinds=player,session"))
      .body as Payload;
    expect(
      (coach.records.player as { id: string }[]).map((p) => p.id).sort(),
    ).toEqual([ids.p1, ids.p2].sort());
    expect(coach.records.session).toHaveLength(4);
    const parent = (await get("parent1", "?kinds=session,attendance,player"))
      .body as Payload;
    expect(parent.records.session).toEqual([]);
    expect(parent.records.attendance).toEqual([]);
    expect(parent.records.player).toHaveLength(1);
  });
  it("rejects unknown or empty kinds and still checks access", async () => {
    for (const query of [
      "?kinds=nonsense",
      "?kinds=",
      "?kinds=player,,squad",
      "?kinds=player,nonsense",
    ])
      expect((await get("ownerA", query)).status, query).toBe(400);
    expect((await get(undefined, "?kinds=player")).status).toBe(401);
    expect((await get("outsider", "?kinds=player")).status).toBe(403);
    expect((await get("ownerB", "?kinds=player", A)).status).toBe(403);
  });
  it("is smaller and cheaper than the full payload", async () => {
    const full = await countQueries(() => get("ownerA")),
      part = await countQueries(() => get("ownerA", "?kinds=player,squad"));
    expect(part.result.bytes).toBeLessThan(full.result.bytes / 3);
    expect(part.queries).toBeLessThan(full.queries);
  });
});

describe("opening one report", () => {
  const open = (
    as: Persona | undefined,
    reportId: string,
    query = "",
    academyId = A,
  ) =>
    callRoute(recordRoute.GET, {
      path: `/api/workspaces/${academyId}/records/report/${reportId}${query}`,
      as,
      params: { academyId, kind: "report", recordId: reportId },
    });
  it("returns the full report to staff who may see it, with its snapshot", async () => {
    for (const [persona, player] of [
      ["ownerA", ids.p1],
      ["ownerA", ids.p3],
      ["coachA", ids.p1],
      ["coachB", ids.p3],
    ] as const) {
      const response = await open(persona, fixture.reports[player]);
      expect(response.status, persona + player).toBe(200);
      const report = response.body as WorkspaceReport;
      expect(report.playerId).toBe(player);
      expect(report.snapshot).toBeDefined();
      expect(report.status).toBe("Approved");
    }
  });
  it("refuses a coach another coach's player's report, as not available", async () => {
    for (const [persona, player] of [
      ["coachA", ids.p3],
      ["coachB", ids.p1],
    ] as const) {
      expect((await open(persona, fixture.reports[player])).status).toBe(404);
      expect(
        (await open(persona, fixture.reports[player], "?review=1")).status,
      ).toBe(404);
    }
  });
  it("lets a parent open only their own child's approved report, without staff sources or notes", async () => {
    const own = await open("parent1", fixture.reports[ids.p1]);
    expect(own.status).toBe(200);
    const text = JSON.stringify(own.body);
    expect(text).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    expect((own.body as WorkspaceReport).monthlySources).toBeUndefined();
    expect((await open("parent1", fixture.reports[ids.p2])).status).toBe(404);
    expect((await open("parent1", fixture.reports[ids.p3])).status).toBe(404);
    expect((await open("parent2", fixture.reports[ids.p1])).status).toBe(404);
  });
  it("answers the same way for unknown ids, other academies, outsiders and signed-out users", async () => {
    expect((await open("ownerA", "no-such-report")).status).toBe(404);
    expect((await open("ownerB", fixture.reports[ids.p1], "", B)).status).toBe(
      404,
    );
    expect((await open("ownerB", fixture.reports[ids.p1], "", A)).status).toBe(
      403,
    );
    expect((await open("outsider", fixture.reports[ids.p1])).status).toBe(403);
    expect((await open(undefined, fixture.reports[ids.p1])).status).toBe(401);
  });
  it("keeps the list and the detail in step for every viewer", async () => {
    for (const persona of ["ownerA", "coachA", "coachB", "parent1"] as const) {
      const listed = (
        (await read(persona, "report", "?view=summary")).body as ReportSummary[]
      )
        .map((r) => r.id)
        .sort();
      const full = idsOf(await read(persona, "report"));
      expect(listed, persona).toEqual(full);
      for (const id of listed)
        expect((await open(persona, id)).status, persona + id).toBe(200);
    }
  });
});
