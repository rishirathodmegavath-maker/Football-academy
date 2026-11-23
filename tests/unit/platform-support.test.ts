// WP5: the Platform Administrator and Support boundaries. A platform
// administrator manages customer accounts and holds no academy role; a child's
// records open to Support only through an expiring grant that the academy's
// owner makes, scoped to named players, read-only and audited.
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
import { registerTestUser } from "./helpers/mock-auth";
import * as accountsRoute from "@/app/api/platform/accounts/route";
import * as decisionRoute from "@/app/api/platform/applications/[academyId]/decision/route";
import * as actionsRoute from "@/app/api/workspaces/[academyId]/actions/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import {
  A,
  B,
  ids,
  callRoute,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-platform-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const PLATFORM = "platform-admin",
  SUPPORT = "support-agent";
beforeAll(() => {
  seedApiFixture();
  registerTestUser(PLATFORM, "Synthetic Platform Admin");
  registerTestUser(SUPPORT, "Synthetic Support Agent");
  const db = database();
  db.prepare("INSERT INTO platform_administrators(userId) VALUES(?)").run(
    PLATFORM,
  );
  db.prepare("INSERT INTO platform_administrators(userId) VALUES(?)").run(
    SUPPORT,
  );
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const as = (user: string) => ({ headers: { "x-test-user": user } });
const accounts = (user?: string, method = "GET", json?: unknown) =>
  callRoute(method === "GET" ? accountsRoute.GET : accountsRoute.PATCH, {
    path: "/api/platform/accounts",
    method,
    json,
    ...(user ? as(user) : {}),
  });
const grant = (persona: Persona, data: unknown) =>
  callRoute(actionsRoute.POST, {
    path: `/api/workspaces/${A}/actions`,
    method: "POST",
    as: persona,
    params: { academyId: A },
    json: { action: "support", data },
  });
const reasonText = "Investigating a report that will not open";
const asSupport = (path: string, handler: unknown, params = {}) =>
  callRoute(handler, {
    path,
    params: { academyId: A, ...params },
    ...as(SUPPORT),
  });

describe("the platform administrator", () => {
  it("is refused by anyone who is not one, and by anonymous callers", async () => {
    expect((await accounts()).status).toBe(401);
    for (const user of [ids.ownerA, ids.coachA, ids.parent1, ids.outsider])
      expect((await accounts(user)).status, user).toBe(403);
    expect(
      (
        await accounts(ids.ownerA, "PATCH", {
          academyId: A,
          status: "PAUSED",
          tier: "PILOT",
          modules: [],
        })
      ).status,
    ).toBe(403);
    expect(
      database()
        .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
        .get(A)?.status,
    ).toBe("ACTIVE");
  });
  it("sees customer metadata only, never a child's or a family's data", async () => {
    const res = await accounts(PLATFORM);
    expect(res.status).toBe(200);
    const list = res.body as Record<string, unknown>[];
    expect(list.map((a) => a.id).sort()).toEqual([A, B]);
    for (const account of list)
      expect(Object.keys(account).sort()).toEqual([
        "country",
        "demo",
        "id",
        "lifecycle",
        "lifecycleVersion",
        "modules",
        "name",
        "onboardingStatus",
        "status",
        "tier",
      ]);
    const text = JSON.stringify(list);
    for (const secret of ["Synthetic Player", "player-1", "parent-1"])
      expect(text).not.toContain(secret);
  });
  it("holds no academy role: academy data stays closed without a grant", async () => {
    for (const [path, handler, params] of [
      [`/api/workspaces/${A}`, workspaceRoute.GET, {}],
      [
        `/api/workspaces/${A}/records/player`,
        recordsRoute.GET,
        { kind: "player" },
      ],
      [`/api/workspaces/${A}/finance`, financeRoute.GET, {}],
    ] as const)
      expect((await asSupport(path, handler, params)).status, path).toBe(403);
    const platform = await callRoute(recordsRoute.GET, {
      path: `/api/workspaces/${A}/records/player`,
      params: { academyId: A, kind: "player" },
      ...as(PLATFORM),
    });
    expect(platform.status).toBe(403);
  });
  it("suspends and reactivates an academy through a recorded decision, which closes and reopens it for members", async () => {
    const decide = (decision: string, reason?: string) => {
      const life = database()
        .prepare("SELECT version FROM academy_lifecycle WHERE academyId=?")
        .get(B) as { version: number };
      return callRoute(decisionRoute.POST, {
        path: `/api/platform/applications/${B}/decision`,
        method: "POST",
        params: { academyId: B },
        json: { decision, reason, expectedVersion: life.version },
        ...as(PLATFORM),
      });
    };
    const read = () =>
      callRoute(workspaceRoute.GET, {
        path: `/api/workspaces/${B}`,
        as: "ownerB",
        params: { academyId: B },
      });
    expect((await read()).status).toBe(200);
    expect((await decide("suspend")).status).toBe(400); // a reason is required
    expect((await decide("suspend", "Unpaid invoice 42")).status).toBe(200);
    expect((await read()).status).toBe(403);
    expect((await decide("reactivate", "Invoice paid")).status).toBe(200);
    expect((await read()).status).toBe(200);
  });
  it("no longer pauses an academy through the entitlement route: a decision with a reason is required", async () => {
    const res = await accounts(PLATFORM, "PATCH", {
      academyId: B,
      status: "PAUSED",
      tier: "PILOT",
      modules: ["development", "reports", "communication", "fees"],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("approval decision");
    // Repeating the current status while changing the tier still works.
    expect(
      (
        await accounts(PLATFORM, "PATCH", {
          academyId: B,
          status: "ACTIVE",
          tier: "PILOT",
          modules: ["development", "reports", "communication", "fees"],
        })
      ).status,
    ).toBe(200);
  });
  it("rejects invalid or unknown account changes without changing anything", async () => {
    const valid = {
      status: "ACTIVE",
      tier: "PILOT",
      modules: ["development"],
    };
    expect(
      (await accounts(PLATFORM, "PATCH", { academyId: "nope", ...valid }))
        .status,
    ).toBe(404);
    for (const bad of [
      { academyId: A, ...valid, status: "DELETED" },
      { academyId: A, ...valid, tier: "FREE" },
      { academyId: A, ...valid, modules: ["everything"] },
      { status: "ACTIVE" },
    ])
      expect((await accounts(PLATFORM, "PATCH", bad)).status).toBe(400);
  });
  it("records entitlement changes in the audit trail", async () => {
    const before = Number(
      database()
        .prepare(
          "SELECT COUNT(*) n FROM workspace_audit WHERE academyId=? AND action LIKE 'Platform entitlement%'",
        )
        .get(B)?.n,
    );
    await accounts(PLATFORM, "PATCH", {
      academyId: B,
      status: "ACTIVE",
      tier: "PILOT",
      modules: ["development", "reports", "communication", "fees"],
    });
    expect(
      Number(
        database()
          .prepare(
            "SELECT COUNT(*) n FROM workspace_audit WHERE academyId=? AND action LIKE 'Platform entitlement%'",
          )
          .get(B)?.n,
      ),
    ).toBe(before + 1);
  });
});

describe("granting Support access", () => {
  it("is something only the academy owner can do", async () => {
    const data = { userId: SUPPORT, playerIds: [ids.p1], reason: reasonText };
    for (const persona of ["adminA", "coachA", "parent1", "ownerB"] as const)
      expect((await grant(persona, data)).status, persona).toBe(403);
    expect(
      database()
        .prepare("SELECT 1 FROM academy_memberships WHERE userId=?")
        .get(SUPPORT),
    ).toBeUndefined();
  });
  it("must name a registered platform administrator, real players of this academy and a reason", async () => {
    const ok = { userId: SUPPORT, playerIds: [ids.p1], reason: reasonText };
    expect((await grant("ownerA", { ...ok, userId: ids.parent1 })).status).toBe(
      400,
    );
    expect(
      (await grant("ownerA", { ...ok, playerIds: [ids.bPlayer] })).status,
    ).toBe(400);
    expect((await grant("ownerA", { ...ok, playerIds: [] })).status).toBe(400);
    expect((await grant("ownerA", { ...ok, reason: "short" })).status).toBe(
      400,
    );
  });
  it("cannot replace an existing academy role", async () => {
    database()
      .prepare(
        "INSERT INTO platform_administrators(userId) VALUES(?) ON CONFLICT DO NOTHING",
      )
      .run(ids.coachB);
    const res = await grant("ownerA", {
      userId: ids.coachB,
      playerIds: [ids.p1],
      reason: reasonText,
    });
    expect(res.status).toBe(409);
    expect(
      database()
        .prepare(
          "SELECT role FROM academy_memberships WHERE academyId=? AND userId=?",
        )
        .get(A, ids.coachB)?.role,
    ).toBe("COACH");
  });
});

describe("a Support grant", () => {
  let grantedAt = 0;
  beforeAll(async () => {
    grantedAt = Date.now();
    const res = await grant("ownerA", {
      userId: SUPPORT,
      playerIds: [ids.p1],
      reason: reasonText,
    });
    expect(res.status).toBe(200);
  });
  it("expires in about an hour and names the person and the reason in the audit trail", () => {
    const row = database()
      .prepare(
        "SELECT role,expiresAt FROM academy_memberships WHERE academyId=? AND userId=?",
      )
      .get(A, SUPPORT)!;
    expect(row.role).toBe("SUPPORT");
    const remaining = Date.parse(String(row.expiresAt)) - grantedAt;
    expect(remaining).toBeGreaterThan(55 * 60000);
    expect(remaining).toBeLessThanOrEqual(61 * 60000);
    const audit = database()
      .prepare(
        "SELECT userId,action FROM workspace_audit WHERE academyId=? AND action LIKE 'Explicit one-hour support grant%'",
      )
      .get(A)!;
    expect(audit.userId).toBe(ids.ownerA);
    expect(String(audit.action)).toContain(reasonText);
  });
  it("opens only the named child, and only for reading", async () => {
    const players = await asSupport(
      `/api/workspaces/${A}/records/player`,
      recordsRoute.GET,
      { kind: "player" },
    );
    expect(players.status).toBe(200);
    expect((players.body as { id: string }[]).map((p) => p.id)).toEqual([
      ids.p1,
    ]);
    for (const kind of ["plan", "report", "weekly"]) {
      const res = await asSupport(
        `/api/workspaces/${A}/records/${kind}`,
        recordsRoute.GET,
        { kind },
      );
      expect(res.status, kind).toBe(200);
      for (const record of res.body as { playerId?: string }[])
        expect(record.playerId ?? ids.p1, kind).toBe(ids.p1);
    }
    // Messages, preferences and dietary notes are never open to Support, and
    // neither are fees or any write.
    for (const kind of [
      "conversation",
      "update",
      "preference",
      "dietary",
      "fee",
    ])
      expect(
        (
          await asSupport(
            `/api/workspaces/${A}/records/${kind}`,
            recordsRoute.GET,
            { kind },
          )
        ).body,
        kind,
      ).toEqual([]);
    for (const kind of ["player", "plan", "conversation", "preference"]) {
      const res = await callRoute(recordsRoute.POST, {
        path: `/api/workspaces/${A}/records/${kind}`,
        method: "POST",
        params: { academyId: A, kind },
        json: {},
        ...as(SUPPORT),
      });
      expect(res.status, kind).toBe(403);
    }
  });
  it("records each read in the audit trail", async () => {
    const reads = () =>
      Number(
        database()
          .prepare(
            "SELECT COUNT(*) n FROM workspace_audit WHERE academyId=? AND userId=? AND action='Authorised support read'",
          )
          .get(A, SUPPORT)?.n,
      );
    const before = reads();
    await asSupport(`/api/workspaces/${A}/records/report`, recordsRoute.GET, {
      kind: "report",
    });
    expect(reads()).toBeGreaterThan(before);
  });
  it("cannot be used to cross into another academy", async () => {
    const res = await callRoute(recordsRoute.GET, {
      path: `/api/workspaces/${B}/records/player`,
      params: { academyId: B, kind: "player" },
      ...as(SUPPORT),
    });
    expect(res.status).toBe(403);
  });
  it("closes when it expires, and can be revoked early by the owner", async () => {
    const read = () =>
      asSupport(`/api/workspaces/${A}/records/player`, recordsRoute.GET, {
        kind: "player",
      });
    expect((await read()).status).toBe(200);
    database()
      .prepare(
        "UPDATE academy_memberships SET expiresAt='2000-01-01T00:00:00.000Z' WHERE academyId=? AND userId=?",
      )
      .run(A, SUPPORT);
    expect((await read()).status).toBe(403);
    // A fresh grant reopens it, and the owner can end it at once.
    expect(
      (
        await grant("ownerA", {
          userId: SUPPORT,
          playerIds: [ids.p1],
          reason: reasonText,
        })
      ).status,
    ).toBe(200);
    expect((await read()).status).toBe(200);
    const membershipId = String(
      database()
        .prepare(
          "SELECT id FROM academy_memberships WHERE academyId=? AND userId=?",
        )
        .get(A, SUPPORT)?.id,
    );
    const revoked = await callRoute(actionsRoute.POST, {
      path: `/api/workspaces/${A}/actions`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
      json: { action: "revoke", id: membershipId },
    });
    expect(revoked.status).toBe(200);
    expect((await read()).status).toBe(403);
  });
});
