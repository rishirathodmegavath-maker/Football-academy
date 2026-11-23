// Lookup scope (Task 3): repeated access lookups are shared only inside one
// synchronous read. These tests show the shared reads return exactly what
// independent reads return, never cross academies, never outlive the call and
// leave support auditing unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import {
  scopedLookup,
  visibleRecords,
  visibleRecord,
  withLookupScope,
  type WorkspaceAccess,
} from "@/server/workspace-access";
import { kinds, workspace } from "@/server/workspace-service";
import { financeView } from "@/server/finance-service";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import {
  A,
  ids,
  callRoute,
  contextFor,
  countQueries,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-access-scope-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const personas: Persona[] = [
  "ownerA",
  "adminA",
  "coachA",
  "coachB",
  "parent1",
  "parent2",
  "ownerB",
];

describe("shared lookups return what independent reads return", () => {
  it("matches every role and record kind, with and without an outer scope", () => {
    for (const persona of personas) {
      const ctx = contextFor(persona);
      const independent = kinds.map((kind) =>
        JSON.stringify(visibleRecords(ctx, kind)),
      );
      const shared = withLookupScope(() =>
        kinds.map((kind) => {
          const first = JSON.stringify(visibleRecords(ctx, kind));
          // A repeated read inside the same scope must match the first one.
          expect(JSON.stringify(visibleRecords(ctx, kind))).toBe(first);
          return first;
        }),
      );
      expect(shared).toEqual(independent);
    }
  });
  it("keeps the same single-record decisions for each role", () => {
    const decision = (ctx: WorkspaceAccess, id: string) => {
      try {
        return visibleRecord(ctx, "player", id).id;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    for (const persona of personas) {
      const ctx = contextFor(persona);
      const all = [ids.p1, ids.p2, ids.p3, ids.bPlayer];
      const independent = all.map((id) => decision(ctx, id));
      expect(withLookupScope(() => all.map((id) => decision(ctx, id)))).toEqual(
        independent,
      );
    }
    expect(
      [ids.p1, ids.p2, ids.p3].map((id) => decision(contextFor("parent1"), id)),
    ).toEqual([ids.p1, 404, 404]);
    expect(
      [ids.p1, ids.p2, ids.p3].map((id) => decision(contextFor("coachA"), id)),
    ).toEqual([ids.p1, ids.p2, 404]);
  });
  it("never shares results between academies, users or roles in one scope", () => {
    withLookupScope(() => {
      const owner = visibleRecords(contextFor("ownerA"), "player")
        .map((p) => p.id)
        .sort();
      const otherAcademy = visibleRecords(contextFor("ownerB"), "player").map(
        (p) => p.id,
      );
      const parent = visibleRecords(contextFor("parent1"), "player").map(
        (p) => p.id,
      );
      const coach = visibleRecords(contextFor("coachA"), "player")
        .map((p) => p.id)
        .sort();
      expect(owner).toEqual([ids.p1, ids.p2, ids.p3]);
      expect(otherAcademy).toEqual([ids.bPlayer]);
      expect(parent).toEqual([ids.p1]);
      expect(coach).toEqual([ids.p1, ids.p2]);
    });
  });
  it("hands each caller its own list so one caller cannot change another's", () => {
    withLookupScope(() => {
      const ctx = contextFor("ownerA");
      visibleRecords(ctx, "player").splice(0);
      expect(visibleRecords(ctx, "player")).toHaveLength(3);
    });
  });
});

describe("no stale permission decisions", () => {
  it("sees a coach reassignment made after the previous read", async () => {
    const db = database();
    const body = () =>
      db
        .prepare(
          "SELECT body FROM workspace_records WHERE academyId=? AND kind='player' AND id=?",
        )
        .get(A, ids.p2)!.body as string;
    const original = body();
    const coachPlayers = () =>
      workspace(contextFor("coachA"))
        .records.player.map((p) => p.id)
        .sort();
    expect(coachPlayers()).toEqual([ids.p1, ids.p2]);
    db.prepare(
      "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
    ).run(
      JSON.stringify({ ...JSON.parse(original), coachId: ids.coachB }),
      A,
      ids.p2,
    );
    try {
      expect(coachPlayers()).toEqual([ids.p1]);
      expect(
        workspace(contextFor("coachB"))
          .records.player.map((p) => p.id)
          .sort(),
      ).toEqual([ids.p2, ids.p3]);
    } finally {
      db.prepare(
        "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
      ).run(original, A, ids.p2);
    }
  });
  it("refuses a revoked parent on the very next request", async () => {
    const db = database();
    const read = () =>
      callRoute(workspaceRoute.GET, {
        path: `/api/workspaces/${A}`,
        as: "parent2",
        params: { academyId: A },
      });
    expect((await read()).status).toBe(200);
    db.prepare(
      "UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?",
    ).run(A, ids.parent2);
    try {
      expect((await read()).status).toBe(403);
    } finally {
      db.prepare(
        "UPDATE academy_memberships SET active=1 WHERE academyId=? AND userId=?",
      ).run(A, ids.parent2);
    }
  });
  it("closes the scope when the call returns, including for async callers", async () => {
    let computed = 0;
    const compute = () => ++computed;
    withLookupScope(() => {
      scopedLookup("k", compute);
      scopedLookup("k", compute);
    });
    expect(computed).toBe(1);
    scopedLookup("k", compute);
    expect(computed).toBe(2);
    await withLookupScope(async () => {
      scopedLookup("k", compute);
      await Promise.resolve();
      scopedLookup("k", compute);
      scopedLookup("k", compute);
    });
    expect(computed).toBe(5);
  });
  it("does not remember a failed lookup", () => {
    let attempts = 0;
    withLookupScope(() => {
      for (let i = 0; i < 2; i++)
        expect(() =>
          scopedLookup("failing", () => {
            attempts++;
            throw new Error("synthetic failure");
          }),
        ).toThrow("synthetic failure");
    });
    expect(attempts).toBe(2);
  });
});

describe("support access stays audited on every read", () => {
  it("writes one audit row per support read, inside a scope too", () => {
    const db = database();
    try {
      db.prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
      ).run("m-support", A, ids.outsider, "SUPPORT", '["football"]');
      db.prepare(
        "INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)",
      ).run(A, ids.outsider, ids.p1);
      const support = contextFor("outsider");
      const audits = () =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM workspace_audit WHERE academyId=? AND action='Authorised support read'",
            )
            .get(A)!.n,
        );
      const before = audits();
      withLookupScope(() => {
        visibleRecords(support, "player");
        visibleRecords(support, "player");
      });
      expect(audits() - before).toBe(2);
      expect(visibleRecords(support, "player").map((p) => p.id)).toEqual([
        ids.p1,
      ]);
    } finally {
      db.prepare(
        "DELETE FROM support_relationships WHERE academyId=? AND userId=? AND playerId=?",
      ).run(A, ids.outsider, ids.p1);
      db.prepare(
        "DELETE FROM academy_memberships WHERE id=? AND academyId=? AND userId=?",
      ).run("m-support", A, ids.outsider);
    }
  });
});

describe("repeated lookups are shared within one read", () => {
  // Upper bounds on the 3-player fixture; before the scope these reads issued
  // 69, 124, 111, 38 and 55 statements (tests/unit/api-baseline.test.ts output).
  it.each([
    ["ownerA", 30],
    ["coachA", 40],
    ["coachB", 40],
    ["parent1", 20],
  ] as const)(
    "%s academy payload stays within %i statements",
    async (persona, limit) => {
      const { queries } = await countQueries(() =>
        workspace(contextFor(persona)),
      );
      expect(queries).toBeLessThanOrEqual(limit);
    },
  );
  it("the owner's finance view no longer repeats per-player lookups", async () => {
    const owner = contextFor("ownerA");
    const { queries, result } = await countQueries(() => financeView(owner));
    expect(result.invoiceSuggestions).toHaveLength(3);
    expect(queries).toBeLessThanOrEqual(30);
  });
});
