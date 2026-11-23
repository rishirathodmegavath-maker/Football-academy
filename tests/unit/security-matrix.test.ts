// WP5: a systematic permission matrix over every academy-scoped API route.
// Each route is called as an anonymous visitor, a signed-in stranger, the owner
// of a different academy, from a foreign or missing origin, against a paused
// academy and by a revoked member. The service checks run for real; only the
// session lookup is replaced (see helpers/mock-auth.ts).
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
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as bootstrapRoute from "@/app/api/workspaces/[academyId]/bootstrap/route";
import * as homeRoute from "@/app/api/workspaces/[academyId]/home/route";
import * as messagesRoute from "@/app/api/workspaces/[academyId]/player-messages/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import * as actionsRoute from "@/app/api/workspaces/[academyId]/actions/route";
import * as communicationRoute from "@/app/api/workspaces/[academyId]/communication/route";
import * as announcementsRoute from "@/app/api/workspaces/[academyId]/communication/announcements/route";
import * as jobsRoute from "@/app/api/workspaces/[academyId]/communication/jobs/route";
import * as lifecycleRoute from "@/app/api/workspaces/[academyId]/lifecycle/route";
import * as guardianAnnouncementsRoute from "@/app/api/workspaces/[academyId]/announcements/route";
import { announcementRepository } from "@/server/batch-announcement-repository";
import type { BatchAnnouncement } from "@/domain/batch-announcement";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as financePdfRoute from "@/app/api/workspaces/[academyId]/finance/[kind]/[recordId]/pdf/route";
import * as periodsRoute from "@/app/api/workspaces/[academyId]/periods/route";
import * as placesRoute from "@/app/api/workspaces/[academyId]/places/route";
import * as trialsRoute from "@/app/api/workspaces/[academyId]/trials/route";
import * as trainingRoute from "@/app/api/workspaces/[academyId]/training/route";
import * as attendanceHistoryRoute from "@/app/api/workspaces/[academyId]/attendance-history/route";
import * as reportPdfRoute from "@/app/api/workspaces/[academyId]/reports/[reportId]/pdf/route";
import * as drillCatalogueRoute from "@/app/api/workspaces/[academyId]/drills/catalogue/route";
import * as drillRevisionsRoute from "@/app/api/workspaces/[academyId]/drills/[drillId]/revisions/route";
import {
  A,
  B,
  ids,
  callRoute,
  seedApiFixture,
  type Fixture,
  type Persona,
} from "./helpers/api-harness";
import { warmPdfRenderer } from "./helpers/warm-pdf";

const filename = join(tmpdir(), `sportozen-matrix-${randomUUID()}.sqlite`);
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

interface Endpoint {
  name: string;
  handler: unknown;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: (academyId: string) => string;
  params: (academyId: string) => Record<string, string>;
  json?: unknown;
}
const root = (a: string) => `/api/workspaces/${a}`;
const endpoint = (
  name: string,
  handler: unknown,
  method: Endpoint["method"],
  path: string,
  extra: Record<string, string> = {},
  json?: unknown,
): Endpoint => ({
  name: `${method} ${name}`,
  handler,
  method,
  path: (a) => root(a) + path,
  params: (a) => ({ academyId: a, ...extra }),
  json,
});
const endpoints: Endpoint[] = [
  endpoint("workspace", workspaceRoute.GET, "GET", ""),
  endpoint("workspace", workspaceRoute.PATCH, "PATCH", "", {}, {}),
  endpoint("bootstrap", bootstrapRoute.GET, "GET", "/bootstrap"),
  endpoint("home", homeRoute.GET, "GET", "/home"),
  endpoint(
    "player-messages",
    messagesRoute.GET,
    "GET",
    `/player-messages?player=${ids.p1}`,
  ),
  endpoint("records", recordsRoute.GET, "GET", "/records/player", {
    kind: "player",
  }),
  endpoint(
    "records",
    recordsRoute.POST,
    "POST",
    "/records/player",
    { kind: "player" },
    {},
  ),
  endpoint("record", recordRoute.GET, "GET", `/records/player/${ids.p1}`, {
    kind: "player",
    recordId: ids.p1,
  }),
  endpoint(
    "record",
    recordRoute.PUT,
    "PUT",
    `/records/player/${ids.p1}`,
    { kind: "player", recordId: ids.p1 },
    {},
  ),
  endpoint(
    "actions",
    actionsRoute.POST,
    "POST",
    "/actions",
    {},
    {
      action: "revoke",
      id: "x",
    },
  ),
  endpoint("communication", communicationRoute.GET, "GET", "/communication"),
  endpoint(
    "communication",
    communicationRoute.POST,
    "POST",
    "/communication",
    {},
    {},
  ),
  endpoint("communication jobs", jobsRoute.GET, "GET", "/communication/jobs"),
  endpoint("lifecycle", lifecycleRoute.GET, "GET", "/lifecycle"),
  endpoint(
    "attendance-history",
    attendanceHistoryRoute.GET,
    "GET",
    `/attendance-history?player=${ids.p1}`,
  ),
  endpoint(
    "attendance-history follow-ups",
    attendanceHistoryRoute.GET,
    "GET",
    "/attendance-history?followUp=1",
  ),
  endpoint(
    "lifecycle",
    lifecycleRoute.POST,
    "POST",
    "/lifecycle",
    {},
    { action: "submit", expectedVersion: 1 },
  ),
  endpoint(
    "announcements",
    announcementsRoute.GET,
    "GET",
    "/communication/announcements",
  ),
  endpoint(
    "announcements",
    announcementsRoute.POST,
    "POST",
    "/communication/announcements",
    {},
    {},
  ),
  endpoint(
    "guardian announcements",
    guardianAnnouncementsRoute.GET,
    "GET",
    "/announcements",
  ),
  endpoint("finance", financeRoute.GET, "GET", "/finance"),
  endpoint("finance", financeRoute.POST, "POST", "/finance", {}, {}),
  endpoint(
    "finance pdf",
    financePdfRoute.GET,
    "GET",
    "/finance/invoice/none/pdf",
    { kind: "invoice", recordId: "none" },
  ),
  endpoint("periods", periodsRoute.POST, "POST", "/periods", {}, {}),
  endpoint("places", placesRoute.GET, "GET", "/places"),
  endpoint("places", placesRoute.POST, "POST", "/places", {}, {}),
  endpoint("trials", trialsRoute.GET, "GET", "/trials"),
  endpoint("trials", trialsRoute.POST, "POST", "/trials", {}, {}),
  endpoint("training", trainingRoute.GET, "GET", "/training"),
  endpoint("training", trainingRoute.POST, "POST", "/training", {}, {}),
  endpoint("drill catalogue", drillCatalogueRoute.GET, "GET", "/drills/catalogue"),
  endpoint(
    "drill revisions",
    drillRevisionsRoute.GET,
    "GET",
    "/drills/none/revisions",
    { drillId: "none" },
  ),
  endpoint("report pdf", reportPdfRoute.GET, "GET", "/reports/none/pdf", {
    reportId: "none",
  }),
];
const call = (
  e: Endpoint,
  as: Persona | undefined,
  opts: { academyId?: string; origin?: string | null } = {},
) => {
  const academyId = opts.academyId ?? A;
  return callRoute(e.handler, {
    path: e.path(academyId),
    method: e.method,
    as,
    params: e.params(academyId),
    json: e.json,
    origin: opts.origin,
  });
};
const mutating = endpoints.filter((e) => e.method !== "GET");

describe("who may call each route at all", () => {
  it.each(endpoints.map((e) => [e.name, e] as const))(
    "%s refuses an anonymous visitor with 401",
    async (_name, e) => {
      expect((await call(e, undefined)).status).toBe(401);
    },
  );
  it.each(endpoints.map((e) => [e.name, e] as const))(
    "%s refuses a signed-in stranger with 403",
    async (_name, e) => {
      expect((await call(e, "outsider")).status).toBe(403);
    },
  );
  it.each(endpoints.map((e) => [e.name, e] as const))(
    "%s refuses the owner of another academy with 403",
    async (_name, e) => {
      expect((await call(e, "ownerB")).status).toBe(403);
    },
  );
});

describe("state-changing routes insist on this application's own origin", () => {
  it.each(mutating.map((e) => [e.name, e] as const))(
    "%s refuses a foreign or missing origin",
    async (_name, e) => {
      for (const origin of ["https://evil.example", null] as const)
        expect(
          (await call(e, "ownerA", { origin })).status,
          String(origin),
        ).toBe(403);
    },
  );
});

describe("a paused academy is closed to every member", () => {
  const setStatus = (status: string) =>
    database()
      .prepare("UPDATE platform_entitlements SET status=? WHERE academyId=?")
      .run(status, A);
  it("answers 403 on every route for owner, admin, coach and parent", async () => {
    setStatus("PAUSED");
    try {
      for (const e of endpoints)
        for (const as of ["ownerA", "adminA", "coachA", "parent1"] as const)
          expect((await call(e, as)).status, `${e.name} as ${as}`).toBe(403);
    } finally {
      setStatus("ACTIVE");
    }
    expect((await call(endpoints[0], "ownerA")).status).toBe(200);
  });
});

describe("a revoked member loses access immediately", () => {
  const setActive = (userId: string, active: number) =>
    database()
      .prepare(
        "UPDATE academy_memberships SET active=? WHERE academyId=? AND userId=?",
      )
      .run(active, A, userId);
  it.each([
    ["coachA", ids.coachA],
    ["parent1", ids.parent1],
    ["adminA", ids.adminA],
  ] as const)("%s", async (persona, userId) => {
    expect((await call(endpoints[0], persona)).status).toBe(200);
    setActive(userId, 0);
    try {
      for (const e of endpoints)
        expect((await call(e, persona)).status, e.name).toBe(403);
    } finally {
      setActive(userId, 1);
    }
  });
  it("an expired membership is refused as well", async () => {
    database()
      .prepare(
        "UPDATE academy_memberships SET expiresAt='2000-01-01T00:00:00.000Z' WHERE academyId=? AND userId=?",
      )
      .run(A, ids.coachB);
    try {
      for (const e of endpoints)
        expect((await call(e, "coachB")).status, e.name).toBe(403);
    } finally {
      database()
        .prepare(
          "UPDATE academy_memberships SET expiresAt=NULL WHERE academyId=? AND userId=?",
        )
        .run(A, ids.coachB);
    }
  });
});

describe("a member may not act outside the role", () => {
  const post = (
    persona: Persona,
    kind: string,
    json: unknown = {},
    academyId = A,
  ) =>
    callRoute(recordsRoute.POST, {
      path: `${root(academyId)}/records/${kind}`,
      method: "POST",
      as: persona,
      params: { academyId, kind },
      json,
    });
  it("parents cannot create any staff-managed record", async () => {
    for (const kind of [
      "player",
      "plan",
      "report",
      "drill",
      "branch",
      "update",
      "fee",
      "session",
      "squad",
      "attendance",
      "evidence",
    ])
      expect((await post("parent1", kind)).status, kind).toBe(403);
  });
  it("a coach cannot create fees or administer batches", async () => {
    for (const kind of ["fee", "branch"])
      expect((await post("coachA", kind)).status, kind).toBeGreaterThanOrEqual(
        400,
      );
    const res = await post("coachA", "fee", {
      playerId: ids.p1,
      amountMinor: 100,
      currency: "INR",
      label: "x",
    });
    expect(res.status).toBe(403);
  });
  it("a parent can only create their own conversation, never for another family", async () => {
    const mine = await post("parent1", "conversation", {
      playerId: ids.p1,
      guardianId: ids.parent1,
      subject: "Question about training",
    });
    expect(mine.status).toBe(201);
    // Another family's child is "not available" (404) rather than "forbidden",
    // so the refusal does not confirm that the child exists.
    for (const [persona, body] of [
      ["parent1", { playerId: ids.p2, guardianId: ids.parent1 }],
      ["parent1", { playerId: ids.p1, guardianId: ids.parent2 }],
      ["parent2", { playerId: ids.p1, guardianId: ids.parent2 }],
    ] as const)
      expect([403, 404], JSON.stringify(body)).toContain(
        (
          await post(persona, "conversation", {
            ...body,
            subject: "Hello there",
          })
        ).status,
      );
  });
  it("an academy owner cannot write into another academy by naming it", async () => {
    const res = await post(
      "ownerB",
      "player",
      { name: "Intruder", sportIds: ["football"], coachId: ids.ownerB },
      A,
    );
    expect(res.status).toBe(403);
    const count = database()
      .prepare(
        "SELECT COUNT(*) n FROM workspace_records WHERE academyId=? AND kind='player' AND body LIKE '%Intruder%'",
      )
      .get(A)!.n;
    expect(count).toBe(0);
  });
});

describe("children's financial documents stay inside the family", () => {
  beforeAll(warmPdfRenderer, 30_000);
  const pdf = (persona: Persona, kind: string, recordId: string) =>
    callRoute(financePdfRoute.GET, {
      path: `${root(A)}/finance/${kind}/${recordId}/pdf`,
      as: persona,
      params: { academyId: A, kind, recordId },
    });
  it("serves a parent only their own child's invoice", async () => {
    const own = fixture.invoices[ids.p1],
      other = fixture.invoices[ids.p2];
    expect(own && other).toBeTruthy();
    expect((await pdf("parent1", "invoice", own)).status).toBe(200);
    expect((await pdf("parent1", "invoice", other)).status).toBe(404);
    expect((await pdf("parent2", "invoice", own)).status).toBe(404);
  });
  it("is not available to a coach", async () => {
    const res = await pdf("coachA", "invoice", fixture.invoices[ids.p1]);
    expect([403, 404]).toContain(res.status);
  });
});

describe("private responses are never cached or shared", () => {
  it("marks JSON and PDF answers no-store and private", async () => {
    const read = await call(endpoints[0], "ownerA");
    expect(read.headers.get("cache-control")).toBe("no-store, private");
    expect(read.headers.get("vary")).toMatch(/Cookie/);
    const denied = await call(endpoints[0], undefined);
    expect(denied.headers.get("cache-control")).toBe("no-store, private");
  });
  it("never discloses internals in a refusal", async () => {
    for (const e of endpoints) {
      const body = JSON.stringify((await call(e, "outsider")).body);
      expect(body, e.name).not.toMatch(/SELECT|sqlite|stack|node_modules/i);
    }
  });
});

describe("guardian announcements: a parent reads only their own child's batch", () => {
  const record = (
    id: string,
    batchIds: string[],
    status: "APPROVED" | "CANCELLED" | "DRAFT" = "APPROVED",
  ): BatchAnnouncement => ({
    id,
    academyId: A,
    version: 1,
    authorId: ids.coachA,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    kind: "OPERATIONAL",
    urgency: "NORMAL",
    batchIds,
    body: `Generic update ${id}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    status,
    approval: {
      reviewerId: ids.ownerA,
      approvedAt: "2026-01-01T00:00:00.000Z",
      fingerprint: "f",
      renderedBody: "r",
      templateName: "t",
      recipients: [],
    },
  });
  const read = (persona: Persona | undefined, academyId = A) =>
    callRoute(guardianAnnouncementsRoute.GET, {
      path: `${root(academyId)}/announcements`,
      as: persona,
      params: { academyId },
    });
  beforeAll(() => {
    announcementRepository.save(record("for-batch-a", [ids.squadA]));
    announcementRepository.save(record("for-batch-b", [ids.squadB]));
    announcementRepository.save(
      record("cancelled-a", [ids.squadA], "CANCELLED"),
    );
    announcementRepository.save(record("draft-a", [ids.squadA], "DRAFT"));
  });
  it("answers each guardian with only approved announcements for a batch their child is in", async () => {
    for (const persona of ["parent1", "parent2"] as const) {
      const res = await read(persona);
      expect(res.status).toBe(200);
      const items = (res.body as { announcements: { id: string }[] })
        .announcements;
      expect(items.map((item) => item.id)).toEqual(["for-batch-a"]);
    }
  });
  it("is refused to every staff role, to strangers and to another academy", async () => {
    for (const persona of ["ownerA", "adminA", "coachA"] as const)
      expect((await read(persona)).status, persona).toBe(403);
    expect((await read("outsider")).status).toBe(403);
    expect((await read("ownerB")).status).toBe(403);
    expect((await read("parent1", B)).status).toBe(403);
    expect((await read(undefined)).status).toBe(401);
  });
  it("returns no author, reviewer, fingerprint or recipient data", async () => {
    const text = JSON.stringify((await read("parent1")).body);
    for (const secret of [
      ids.coachA,
      ids.ownerA,
      "fingerprint",
      "reviewerId",
      "authorId",
      "recipients",
      "templateName",
    ])
      expect(text).not.toContain(secret);
  });
});
