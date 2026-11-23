// WP2.4: the reads behind Messages and Development. Report content for one
// player (view=content) returns only what Messages prepares a message from;
// updates, conversations, plans and weekly plans are read per player with the
// ordinary filters. Every read starts from visibleRecords, so role, academy and
// parent-child scope are those of the long-standing endpoints.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { visibleRecords } from "@/server/workspace-access";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { periodAction } from "@/server/period-service";
import type { WorkspaceReport } from "@/domain/workspace";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as messagesRoute from "@/app/api/workspaces/[academyId]/player-messages/route";
import type { PlayerMessages, ReportContent } from "@/domain/records-query";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";
import {
  extended,
  extendedContext,
  seedExtendedFixture,
  type ExtendedFixture,
} from "./helpers/extended-fixture";

const filename = join(
  tmpdir(),
  `sportozen-messages-reads-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let extra: ExtendedFixture;
let base: ReturnType<typeof seedApiFixture>;
beforeAll(() => {
  base = seedApiFixture();
  extra = seedExtendedFixture(base);
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

type Viewer = Persona | { user: string } | undefined;
const as = (viewer: Viewer) =>
  viewer === undefined || typeof viewer === "string"
    ? { as: viewer }
    : { headers: { "x-test-user": viewer.user } };
const support = { user: extended.support } as const;
const read = (viewer: Viewer, kind: string, query = "", academyId = A) =>
  callRoute(recordsRoute.GET, {
    path: `/api/workspaces/${academyId}/records/${kind}${query}`,
    params: { academyId, kind },
    ...as(viewer),
  });
const content = async (viewer: Viewer, player: string, academyId = A) => {
  const response = await read(
    viewer,
    "report",
    `?view=content&player=${player}`,
    academyId,
  );
  expect(response.status).toBe(200);
  return response.body as ReportContent[];
};
const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("report content for Messages", () => {
  it("returns an approved report as the few fields a message is prepared from", async () => {
    const [report] = await content("ownerA", ids.p1);
    expect(report.id).toBe(base.reports[ids.p1]);
    expect(Object.keys(report).sort()).toEqual(
      [
        "academyId",
        "approvedPlan",
        "id",
        "period",
        "planId",
        "playerId",
        "snapshot",
        "sportId",
        "status",
      ].sort(),
    );
    expect(Object.keys(report.snapshot).sort()).toEqual(
      [
        "academy",
        "activities",
        "evidence",
        "focus",
        "nextStep",
        "observationCriteria",
        "period",
        "player",
        "practised",
        "reviewDate",
        "reviewedReason",
      ].sort(),
    );
    const text = JSON.stringify(report);
    for (const absent of [
      "monthlySources",
      "presentationData",
      "logoData",
      "playerPhoto",
      "privateNote",
      "SYNTHETIC STAFF-ONLY NOTE",
    ])
      expect(text, absent).not.toContain(absent);
    expect(report.approvedPlan).toEqual({
      id: expect.any(String),
      focus: "First touch and receiving",
    });
  });
  it("is much smaller than the whole report", async () => {
    const full = visibleRecords(contextFor("ownerA"), "report").find(
      (r) => r.playerId === ids.p1,
    )!;
    const short = await content("ownerA", ids.p1);
    expect(JSON.stringify(short).length).toBeLessThan(
      JSON.stringify(full).length,
    );
  });
  it("matches the approved reports each viewer may already read", async () => {
    const viewers: [Viewer, ReturnType<typeof contextFor>][] = [
      ["ownerA", contextFor("ownerA")],
      ["adminA", contextFor("adminA")],
      ["coachA", contextFor("coachA")],
      ["coachB", contextFor("coachB")],
      ["parent1", contextFor("parent1")],
      ["parent2", contextFor("parent2")],
      [support, extendedContext(extended.support)],
    ];
    for (const [viewer, ctx] of viewers)
      for (const player of [ids.p1, ids.p2, ids.p3]) {
        const expected = visibleRecords(ctx, "report")
          .filter(
            (r) =>
              r.playerId === player && r.status === "Approved" && r.snapshot,
          )
          .map((r) => r.id)
          .sort();
        expect(
          idsOf(await content(viewer, player)),
          JSON.stringify(viewer) + player,
        ).toEqual(expected);
      }
  });
  it("shows a coach only their own players", async () => {
    expect(idsOf(await content("coachA", ids.p1))).toEqual([
      base.reports[ids.p1],
    ]);
    expect(await content("coachA", ids.p3)).toEqual([]);
    expect(await content("coachB", ids.p1)).toEqual([]);
    expect(idsOf(await content("coachB", ids.p3))).toEqual([
      base.reports[ids.p3],
    ]);
  });
  it("shows a parent only their child, with the sanitised snapshot and no staff sources", async () => {
    const own = await content("parent1", ids.p1);
    expect(idsOf(own)).toEqual([base.reports[ids.p1]]);
    expect(own[0].sourceEvidenceIds).toBeUndefined();
    expect(own[0].monthly).toBeUndefined();
    expect(JSON.stringify(own)).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    expect(await content("parent1", ids.p2)).toEqual([]);
    expect(await content("parent1", ids.p3)).toEqual([]);
    expect(await content("parent2", ids.p1)).toEqual([]);
  });
  it("shows an authorised support member only the linked player, audited", async () => {
    const db = database();
    const audits = () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM workspace_audit WHERE academyId=? AND action='Authorised support read'",
          )
          .get(A)!.n,
      );
    const before = audits();
    const own = await content(support, ids.p1);
    expect(idsOf(own)).toEqual([base.reports[ids.p1]]);
    expect(own[0].sourceEvidenceIds).toBeUndefined();
    expect(await content(support, ids.p2)).toEqual([]);
    expect(audits() - before).toBe(2);
  });
  it("keeps academies apart and refuses outsiders and signed-out users", async () => {
    expect(await content("ownerB", ids.p1, B)).toEqual([]);
    expect(
      (await read("ownerB", "report", `?view=content&player=${ids.p1}`)).status,
    ).toBe(403);
    expect(
      (await read("outsider", "report", `?view=content&player=${ids.p1}`))
        .status,
    ).toBe(403);
    expect(
      (await read(undefined, "report", `?view=content&player=p`)).status,
    ).toBe(401);
  });
  it("is read for one player, unpaged, and only for reports", async () => {
    for (const [kind, query] of [
      ["report", "?view=content"],
      ["report", `?view=content&player=${ids.p1}&limit=5`],
      ["report", `?view=content&player=${ids.p1}&cursor=0`],
      ["session", `?view=content&player=${ids.p1}`],
      ["plan", `?view=content&player=${ids.p1}`],
      ["report", `?view=content&player=${ids.p1}&bogus=1`],
    ] as const)
      expect((await read("ownerA", kind, query)).status, kind + query).toBe(
        400,
      );
  });
  it("leaves the summary view and the long-standing response unchanged", async () => {
    const summary = await read("ownerA", "report", "?view=summary");
    expect(summary.status).toBe(200);
    expect(
      (await read("ownerA", "report")).body as { id: string }[],
    ).toHaveLength(3);
  });
});

describe("per-player reads for Messages and Development", () => {
  it("reads one player's updates with the viewer's own scope", async () => {
    const mine = (await read("ownerA", "update", `?player=${ids.p1}`)).body as {
      id: string;
    }[];
    expect(idsOf(mine)).toContain(extra.update.id);
    expect((await read("ownerA", "update", `?player=${ids.p2}`)).body).toEqual(
      [],
    );
    expect(
      idsOf(
        (await read("parent1", "update", `?player=${ids.p1}`)).body as {
          id: string;
        }[],
      ),
    ).toEqual([extra.update.id]);
    expect((await read("parent2", "update", `?player=${ids.p1}`)).body).toEqual(
      [],
    );
    expect((await read("coachB", "update", `?player=${ids.p1}`)).body).toEqual(
      [],
    );
    expect((await read(support, "update", `?player=${ids.p1}`)).body).toEqual(
      [],
    );
  });
  it("reads one player's conversation, with internal notes for staff only", async () => {
    const staff = (await read("coachA", "conversation", `?player=${ids.p1}`))
      .body as { id: string; messages: { internal: boolean }[] }[];
    expect(staff.map((c) => c.id)).toEqual([extra.conversation.id]);
    expect(staff[0].messages.some((m) => m.internal)).toBe(true);
    const parent = (await read("parent1", "conversation", `?player=${ids.p1}`))
      .body as { messages: { internal: boolean }[] }[];
    expect(parent).toHaveLength(1);
    expect(parent[0].messages.some((m) => m.internal)).toBe(false);
    expect(JSON.stringify(parent)).not.toContain("INTERNAL COACH NOTE");
    expect(
      (await read("parent2", "conversation", `?player=${ids.p1}`)).body,
    ).toEqual([]);
    expect(
      (await read("coachB", "conversation", `?player=${ids.p1}`)).body,
    ).toEqual([]);
  });
  it("reads one player's plans and weekly plans, never widening access", async () => {
    for (const kind of ["plan", "weekly"] as const) {
      for (const persona of [
        "ownerA",
        "coachA",
        "coachB",
        "parent1",
        "parent2",
      ] as const) {
        const all = visibleRecords(contextFor(persona), kind) as {
          id: string;
          playerId?: string;
        }[];
        const filtered = (await read(persona, kind, `?player=${ids.p1}`))
          .body as { id: string }[];
        expect(idsOf(filtered), kind + persona).toEqual(
          idsOf(all.filter((r) => r.playerId === ids.p1)),
        );
      }
    }
    expect((await read("coachB", "plan", `?player=${ids.p1}`)).body).toEqual(
      [],
    );
  });
  it("lists one player's approved monthly reports for the delivery panel", async () => {
    const summary = (
      await read("ownerA", "report", `?view=summary&player=${ids.p1}`)
    ).body as { id: string; status: string }[];
    expect(summary.map((r) => r.id)).toEqual([base.reports[ids.p1]]);
  });
});

describe("the Messages read for one player", () => {
  const bundle = (viewer: Viewer, query: string, academyId = A) =>
    callRoute(messagesRoute.GET, {
      path: `/api/workspaces/${academyId}/player-messages${query}`,
      params: { academyId },
      ...as(viewer),
    });
  it("is exactly the four filtered reads, for every viewer and player", async () => {
    const viewers: Viewer[] = [
      "ownerA",
      "adminA",
      "coachA",
      "coachB",
      "parent1",
      "parent2",
      support,
    ];
    for (const viewer of viewers)
      for (const player of [ids.p1, ids.p2, ids.p3]) {
        const response = await bundle(viewer, `?player=${player}`);
        expect(response.status, JSON.stringify(viewer) + player).toBe(200);
        const body = response.body as PlayerMessages;
        expect(Object.keys(body).sort()).toEqual([
          "conversations",
          "plans",
          "reports",
          "updates",
        ]);
        const part = async (kind: string, extra = "") =>
          (await read(viewer, kind, `?player=${player}${extra}`)).body;
        expect(body.plans).toEqual(await part("plan"));
        expect(body.updates).toEqual(await part("update"));
        expect(body.conversations).toEqual(await part("conversation"));
        expect(body.reports).toEqual(await part("report", "&view=content"));
      }
  });
  it("gives a parent no internal note and nothing of another family", async () => {
    const own = (await bundle("parent1", `?player=${ids.p1}`))
      .body as PlayerMessages;
    expect(own.conversations.map((c) => c.id)).toEqual([extra.conversation.id]);
    expect(JSON.stringify(own)).not.toContain("INTERNAL COACH NOTE");
    expect(JSON.stringify(own)).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    for (const [viewer, player] of [
      ["parent1", ids.p2],
      ["parent2", ids.p1],
      ["coachB", ids.p1],
    ] as const)
      expect(await bundle(viewer, `?player=${player}`)).toMatchObject({
        body: { plans: [], updates: [], conversations: [], reports: [] },
      });
    const staff = (await bundle("coachA", `?player=${ids.p1}`))
      .body as PlayerMessages;
    expect(
      staff.conversations.some((c) => c.messages.some((m) => m.internal)),
    ).toBe(true);
  });
  it("is read for one player only, with the usual access checks", async () => {
    for (const query of [
      "",
      "?player=",
      `?player=${ids.p1}&kind=plan`,
      `?player=${ids.p1}&limit=1`,
    ])
      expect((await bundle("ownerA", query)).status, query).toBe(400);
    expect((await bundle("ownerB", `?player=${ids.p1}`, B)).body).toMatchObject(
      { reports: [] },
    );
    expect((await bundle("ownerB", `?player=${ids.p1}`)).status).toBe(403);
    expect((await bundle("outsider", `?player=${ids.p1}`)).status).toBe(403);
    expect((await bundle(undefined, `?player=${ids.p1}`)).status).toBe(401);
  });
});

describe("report content for a monthly report, through its life", () => {
  it("leaves out drafts and revision requests, and shows staff (not parents) the monthly flag and source ids", async () => {
    const owner = contextFor("ownerA");
    const [draft] = (await periodAction(owner, {
      requestId: randomUUID(),
      action: "monthlyPrepare",
      data: { playerIds: [ids.p2], month: "2026-09" },
    })) as WorkspaceReport[];
    expect(draft.monthlySources).toBeDefined();
    const ofDraft = async (viewer: Viewer) =>
      (await content(viewer, ids.p2)).find((r) => r.id === draft.id);
    // A draft is not an approved report: nobody receives it as content.
    for (const viewer of ["ownerA", "coachA", "parent2"] as const)
      expect(await ofDraft(viewer), viewer).toBeUndefined();
    const approvedSnapshot = repo.find(
      A,
      "report",
      base.reports[ids.p2],
    )!.snapshot!;
    const saved = (status: WorkspaceReport["status"]) =>
      repo.save(A, "report", {
        ...repo.find(A, "report", draft.id)!,
        status,
        snapshot: approvedSnapshot,
        sourceEvidenceIds: ["evidence-for-review"],
      });
    saved("Revision Requested");
    for (const viewer of ["ownerA", "coachA", "parent2"] as const)
      expect(await ofDraft(viewer), viewer).toBeUndefined();
    saved("Approved");
    // Staff get what Messages needs to decide which updates it can draft.
    for (const viewer of ["ownerA", "adminA", "coachA"] as const) {
      const report = await ofDraft(viewer);
      expect(report, viewer).toMatchObject({
        id: draft.id,
        status: "Approved",
        monthly: true,
        sourceEvidenceIds: ["evidence-for-review"],
      });
    }
    // A parent sees the approved report, but never how it was built.
    const forParent = await ofDraft("parent2");
    expect(forParent).toBeDefined();
    expect(forParent).not.toHaveProperty("monthly");
    expect(forParent).not.toHaveProperty("sourceEvidenceIds");
    expect(JSON.stringify(forParent)).not.toContain("evidence-for-review");
    // Another family and another coach still get nothing.
    expect(await ofDraft("parent1")).toBeUndefined();
    expect(await ofDraft("coachB")).toBeUndefined();
    // Support reads the same sanitised content, without the staff fields.
    expect((await content(support, ids.p2)).length).toBe(0);
  });
});
