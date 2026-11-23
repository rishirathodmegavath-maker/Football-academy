// The drill library over HTTP: the authenticated catalogue route, and the
// customise / archive / restore / edit routes with real sessions and roles.
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
import * as catalogueRoute from "@/app/api/workspaces/[academyId]/drills/catalogue/route";
import * as revisionsRoute from "@/app/api/workspaces/[academyId]/drills/[drillId]/revisions/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import { registerTestUser } from "./helpers/mock-auth";
import * as actionsRoute from "@/app/api/workspaces/[academyId]/actions/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import {
  A,
  B,
  callRoute,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-drill-routes-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const root = (a: string) => `/api/workspaces/${a}`;
const catalogue = (as?: Persona, academyId = A) =>
  callRoute(catalogueRoute.GET, {
    path: `${root(academyId)}/drills/catalogue`,
    as,
    params: { academyId },
  });
const act = (as: Persona, action: string, id: string, data?: unknown) =>
  callRoute(actionsRoute.POST, {
    path: `${root(A)}/actions`,
    method: "POST",
    as,
    params: { academyId: A },
    json: { action, id, data },
  });
interface Catalogue {
  categories: { id: string; initialCount: number; publishedCount: number }[];
  drills: { id: string; number: number; status: string; content: { steps: string[] } }[];
  headingPolicy: { country: string; headingEnabled: boolean };
}

describe("the catalogue route", () => {
  it("is closed to a visitor, a stranger, another academy's owner and families", async () => {
    expect((await catalogue(undefined)).status).toBe(401);
    expect((await catalogue("outsider")).status).toBe(403);
    expect((await catalogue("ownerB")).status).toBe(403);
    expect((await catalogue("parent1")).status).toBe(403);
    expect((await catalogue("parent2")).status).toBe(403);
    // Academy B's owner asking for academy A's catalogue by name is refused too.
    expect((await catalogue("ownerB", A)).status).toBe(403);
  });
  it("serves 49 published drills in seven categories to owner, admin and coaches", async () => {
    for (const as of ["ownerA", "adminA", "coachA", "coachB"] as const) {
      const response = await catalogue(as);
      expect(response.status, as).toBe(200);
      const body = response.body as Catalogue;
      expect(body.drills).toHaveLength(49);
      expect(body.categories).toHaveLength(7);
      expect(body.categories.map((c) => c.initialCount)).toEqual([7, 8, 9, 9, 7, 5, 5]);
      expect(body.categories.map((c) => c.publishedCount)).toEqual([7, 8, 9, 9, 7, 5, 4]);
      expect(body.drills.every((d) => d.status === "PUBLISHED")).toBe(true);
      expect(response.headers.get("cache-control")).toMatch(/no-store|private/);
    }
  });
  it("never exposes the draft or any heading content, and keeps heading closed for India", async () => {
    const body = (await catalogue("ownerA")).body as Catalogue;
    expect(body.drills.map((d) => d.number)).not.toContain(49);
    const text = JSON.stringify(body);
    expect(text).not.toContain("uni-049");
    expect(text).not.toContain("NOT_AUTHORED_PENDING");
    expect(text).not.toContain("Aerial timing and directional heading");
    expect(body.headingPolicy).toMatchObject({ country: "IN", headingEnabled: false });
  });
  it("is read-only", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(method in catalogueRoute, method).toBe(false);
  });
  it("a paused academy gets nothing", async () => {
    database()
      .prepare("UPDATE platform_entitlements SET status='PAUSED' WHERE academyId=?")
      .run(A);
    try {
      expect((await catalogue("ownerA")).status).toBe(403);
    } finally {
      database()
        .prepare("UPDATE platform_entitlements SET status='ACTIVE' WHERE academyId=?")
        .run(A);
    }
  });
  it("a revoked coach loses it at once", async () => {
    expect((await catalogue("coachB")).status).toBe(200);
    database()
      .prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId='coach-b'")
      .run(A);
    try {
      expect((await catalogue("coachB")).status).toBe(403);
    } finally {
      database()
        .prepare("UPDATE academy_memberships SET active=1 WHERE academyId=? AND userId='coach-b'")
        .run(A);
    }
  });
});

describe("the action routes", () => {
  it("customise is idempotent over HTTP, and a parent is refused", async () => {
    expect((await act("parent1", "customiseDrill", "uni-016")).status).toBe(403);
    const first = await act("coachA", "customiseDrill", "uni-016");
    expect(first.status).toBe(200);
    const again = await act("ownerA", "customiseDrill", "uni-016");
    expect((again.body as { created: boolean }).created).toBe(false);
    expect((first.body as { drill: { id: string } }).drill.id).toBe("from-uni-016");
  });
  it("an academy's copy is never visible to another academy", async () => {
    const list = await callRoute(recordsRoute.GET, {
      path: `${root(B)}/records/drill`,
      as: "ownerB",
      params: { academyId: B, kind: "drill" },
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("from-uni-016");
  });
  it("archive and restore follow the permission rules", async () => {
    const own = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      as: "coachA",
      params: { academyId: A, kind: "drill" },
      json: {
        name: "Coach A drill",
        category: "defending-pressing",
        focusArea: "Defending",
        purpose: "Practise delaying.",
        cue: "Stay side-on.",
      },
    });
    expect(own.status).toBe(201);
    const id = (own.body as { id: string }).id,
      v1 = (own.body as { recordVersion: number }).recordVersion;
    // Stage 1: archive and restore carry the version the screen saw. Who may
    // act is still judged first, so a refused person never learns about versions.
    expect((await act("coachB", "archiveDrill", id)).status).toBe(403);
    expect((await act("parent1", "archiveDrill", id)).status).toBe(403);
    expect((await act("coachA", "archiveDrill", id)).status).toBe(400);
    const archived = await act("coachA", "archiveDrill", id, { expectedVersion: v1 });
    expect(archived.status).toBe(200);
    const v2 = (archived.body as { recordVersion: number }).recordVersion;
    expect((await act("ownerA", "restoreDrill", id, { expectedVersion: v2 })).status).toBe(200);
    expect((await act("ownerB", "archiveDrill", id)).status).toBe(403);
  });
  it("edits need the version and respect ownership over HTTP", async () => {
    const made = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "drill" },
      json: {
        name: "Owner drill",
        category: "warm-up-activation",
        focusArea: "Passing",
        purpose: "Warm up.",
        cue: "Easy pace.",
      },
    });
    const drill = made.body as { id: string; recordVersion: number };
    const put = (as: Persona, json: unknown) =>
      callRoute(recordRoute.PUT, {
        path: `${root(A)}/records/drill/${drill.id}`,
        method: "PUT",
        as,
        params: { academyId: A, kind: "drill", recordId: drill.id },
        json,
      });
    const body = {
      name: "Owner drill, edited",
      category: "warm-up-activation",
      focusArea: "Passing",
      purpose: "Warm up.",
      cue: "Easy pace.",
    };
    expect((await put("coachA", { ...body, expectedVersion: drill.recordVersion })).status).toBe(403);
    expect((await put("ownerA", body)).status).toBe(409);
    expect((await put("ownerA", { ...body, expectedVersion: drill.recordVersion })).status).toBe(200);
    expect((await put("ownerA", { ...body, expectedVersion: drill.recordVersion })).status).toBe(409);
  });
  it("nobody can write a universal id through the record routes", async () => {
    for (const as of ["ownerA", "adminA", "coachA"] as const) {
      const response = await callRoute(recordRoute.PUT, {
        path: `${root(A)}/records/drill/uni-016`,
        method: "PUT",
        as,
        params: { academyId: A, kind: "drill", recordId: "uni-016" },
        json: {
          name: "Hijacked",
          category: "passing-combination-play",
          focusArea: "Passing",
          purpose: "Hijack.",
          cue: "Hijack.",
        },
      });
      // Refused: either as a reserved id or because no such record exists.
      expect([403, 404], as).toContain(response.status);
    }
    const stored = await callRoute(recordsRoute.GET, {
      path: `${root(A)}/records/drill`,
      as: "ownerA",
      params: { academyId: A, kind: "drill" },
    });
    expect(JSON.stringify(stored.body)).not.toContain("Hijacked");
  });
});

// Stage 1: the revision-history route, a Support member, and an expired
// invitation, all through the real route handlers and real membership checks.
describe("history route, Support and expired invitations", () => {
  const history = (
    as: Persona | undefined,
    drillId: string,
    options: { academyId?: string; headers?: Record<string, string> } = {},
  ) => {
    const academyId = options.academyId ?? A;
    return callRoute(revisionsRoute.GET, {
      path: `${root(academyId)}/drills/${drillId}/revisions`,
      as,
      headers: options.headers,
      params: { academyId, drillId },
    });
  };
  const make = async (as: Persona, name: string) => {
    const response = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      as,
      params: { academyId: A, kind: "drill" },
      json: {
        name,
        category: "warm-up-activation",
        focusArea: "Passing",
        purpose: "Warm up.",
        cue: "Easy pace.",
        content: { safety: ["Keep the area clear."] },
      },
    });
    expect(response.status).toBe(201);
    return response.body as { id: string; recordVersion: number };
  };
  it("is read by the owner, an admin and the creating coach, and by nobody else", async () => {
    const mine = await make("coachA", "History: coach A drill");
    const owners = await make("ownerA", "History: owner drill");
    for (const as of ["ownerA", "adminA", "coachA"] as const) {
      const response = await history(as, mine.id);
      expect(response.status, as).toBe(200);
      expect(
        (response.body as { revisions: { revision: number; context: string }[] }).revisions[0],
      ).toMatchObject({ revision: 1, context: "Created" });
    }
    expect((await history("coachB", mine.id)).status).toBe(403);
    expect((await history("coachA", owners.id)).status).toBe(403);
    expect((await history("parent1", mine.id)).status).toBe(403);
    expect((await history("outsider", mine.id)).status).toBe(403);
    expect((await history("ownerB", mine.id)).status).toBe(403);
    expect((await history("ownerB", mine.id, { academyId: B })).status).toBe(404);
    expect((await history(undefined, mine.id)).status).toBe(401);
    expect((await history("ownerA", "uni-016")).status).toBe(403);
    expect((await history("ownerA", "nothing-here")).status).toBe(404);
  });
  it("never answers with a drill that belongs to another academy", async () => {
    const mine = await make("ownerA", "History: tenant drill");
    const response = await history("ownerB", mine.id, { academyId: B });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("tenant drill");
  });
  it("a Support member is refused on every drill route", async () => {
    registerTestUser("support-a", "Synthetic Support");
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
      )
      .run("m-support-a", A, "support-a", "SUPPORT", '["football"]');
    database()
      .prepare("INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)")
      .run(A, "support-a", "player-1");
    const headers = { "x-test-user": "support-a" };
    const mine = await make("ownerA", "History: Support probe");
    expect(
      (
        await callRoute(catalogueRoute.GET, {
          path: `${root(A)}/drills/catalogue`,
          headers,
          params: { academyId: A },
        })
      ).status,
    ).toBe(403);
    expect((await history(undefined, mine.id, { headers })).status).toBe(403);
    for (const action of ["customiseDrill", "archiveDrill", "restoreDrill"])
      expect(
        (
          await callRoute(actionsRoute.POST, {
            path: `${root(A)}/actions`,
            method: "POST",
            headers,
            params: { academyId: A },
            json: { action, id: action === "customiseDrill" ? "uni-016" : mine.id, data: { expectedVersion: 1 } },
          })
        ).status,
        action,
      ).toBe(403);
    const created = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      headers,
      params: { academyId: A, kind: "drill" },
      json: { name: "x", category: "warm-up-activation", focusArea: "Passing", purpose: "p", cue: "c" },
    });
    expect(created.status).toBe(403);
    const listed = await callRoute(recordsRoute.GET, {
      path: `${root(A)}/records/drill`,
      headers,
      params: { academyId: A, kind: "drill" },
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
  });
  it("an expired invitation gives no access to the library", async () => {
    registerTestUser("invitee-x", "Synthetic Invitee");
    const made = await callRoute(actionsRoute.POST, {
      path: `${root(A)}/actions`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
      json: {
        action: "invite",
        data: { email: "invitee-x@example.test", role: "COACH", playerIds: [], guardianVerified: false },
      },
    });
    expect(made.status).toBe(200);
    database()
      .prepare("UPDATE workspace_invitations SET expiresAt='2000-01-01T00:00:00.000Z' WHERE academyId=? AND email=?")
      .run(A, "invitee-x@example.test");
    const accepted = await callRoute(acceptRoute.POST, {
      path: "/api/invitations/accept",
      method: "POST",
      headers: { "x-test-user": "invitee-x" },
      json: { token: (made.body as { token: string }).token },
    });
    expect(accepted.status).toBeGreaterThanOrEqual(400);
    expect(accepted.status).toBeLessThan(500);
    const catalogue = await callRoute(catalogueRoute.GET, {
      path: `${root(A)}/drills/catalogue`,
      headers: { "x-test-user": "invitee-x" },
      params: { academyId: A },
    });
    expect(catalogue.status).toBe(403);
    expect(
      database()
        .prepare("SELECT COUNT(*) AS n FROM academy_memberships WHERE academyId=? AND userId=?")
        .get(A, "invitee-x")?.n,
    ).toBe(0);
  });
  it("a revoked coach loses the history route too", async () => {
    const mine = await make("coachB", "History: revoked coach");
    expect((await history("coachB", mine.id)).status).toBe(200);
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?").run(A, "coach-b");
    try {
      expect((await history("coachB", mine.id)).status).toBe(403);
    } finally {
      database().prepare("UPDATE academy_memberships SET active=1 WHERE academyId=? AND userId=?").run(A, "coach-b");
    }
  });
  it("archive and restore need the version and refuse a stale one", async () => {
    const mine = await make("ownerA", "History: version rules");
    const send = (action: string, data?: unknown) =>
      callRoute(actionsRoute.POST, {
        path: `${root(A)}/actions`,
        method: "POST",
        as: "ownerA",
        params: { academyId: A },
        json: { action, id: mine.id, data },
      });
    expect((await send("archiveDrill")).status).toBe(400);
    expect((await send("archiveDrill", { expectedVersion: mine.recordVersion + 5 })).status).toBe(409);
    const ok = await send("archiveDrill", { expectedVersion: mine.recordVersion });
    expect(ok.status).toBe(200);
    expect((await send("archiveDrill", { expectedVersion: mine.recordVersion })).status).toBe(409);
  });
});

describe("staff-only drill content is not cached or shipped", () => {
  it("the catalogue and the history are private and never stored by a browser or proxy", async () => {
    const response = await catalogue("ownerA");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(response.headers.get("cache-control")).toMatch(/private/);
    const mine = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "drill" },
      json: {
        name: "Cache probe",
        category: "warm-up-activation",
        focusArea: "Passing",
        purpose: "Warm up.",
        cue: "Easy pace.",
        content: { safety: ["Keep the area clear."] },
      },
    });
    const history = await callRoute(revisionsRoute.GET, {
      path: `${root(A)}/drills/${(mine.body as { id: string }).id}/revisions`,
      as: "ownerA",
      params: { academyId: A, drillId: (mine.body as { id: string }).id },
    });
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("the browser store treats the catalogue as sensitive, so a new screen asks again", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/hooks/use-drill-catalogue.ts", "utf8")).toContain("sensitive: true");
  });
  it("refusals and validation errors carry no coaching content", async () => {
    const refused = await callRoute(recordsRoute.POST, {
      path: `${root(A)}/records/drill`,
      method: "POST",
      as: "coachA",
      params: { academyId: A, kind: "drill" },
      json: {
        name: "Leak probe",
        category: "warm-up-activation",
        focusArea: "Passing",
        purpose: "p".repeat(400),
        cue: "c",
        content: { safety: ["SECRET-STAFF-SAFETY-LINE"] },
      },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain("SECRET-STAFF-SAFETY-LINE");
    const denied = await callRoute(revisionsRoute.GET, {
      path: `${root(A)}/drills/uni-016/revisions`,
      as: "parent1",
      params: { academyId: A, drillId: "uni-016" },
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toMatch(/steps|safety|coachingPoints/);
  });
});
