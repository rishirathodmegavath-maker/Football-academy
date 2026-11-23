// WP3 (architecture), WP4 (integrity) and WP5 (abuse protection) foundations:
// nested transactions, atomic record saves, database error mapping, the
// migration-008 guards, the shared coach rule, atomic invitations and the
// write rate limiter.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "6";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { DatabaseSync } from "node:sqlite";
import { atomic, database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { apiError } from "@/server/http";
import { coachCoversPlayers } from "@/server/workspace-access";
import * as workspaceService from "@/server/workspace-service";
import * as membership from "@/server/membership-service";
import { migrateIntegrityGuards } from "@/server/migrations/008-integrity-guards";
import { enforceRateLimit } from "@/server/rate-limit";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  seedApiFixture,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-wp3-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const db = () => database();
const count = (sql: string, ...args: string[]) =>
  Number(
    db()
      .prepare(sql)
      .get(...args)?.n,
  );

describe("atomic() nests", () => {
  const insert = (id: string) =>
    db()
      .prepare(
        "INSERT INTO request_rate_limits(scope,bucket,requests,expiresAt) VALUES(?,?,1,0)",
      )
      .run("nest", id);
  const rows = () =>
    count("SELECT COUNT(*) n FROM request_rate_limits WHERE scope='nest'");
  it("keeps an inner unit's work when the outer one commits, and drops it with the outer one", () => {
    atomic(() => {
      insert("a");
      atomic(() => insert("b"));
    });
    expect(rows()).toBe(2);
    expect(() =>
      atomic(() => {
        insert("c");
        atomic(() => insert("d"));
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");
    expect(rows()).toBe(2);
  });
  it("undoes only the inner unit when the caller handles its failure", () => {
    atomic(() => {
      insert("e");
      expect(() =>
        atomic(() => {
          insert("f");
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
      insert("g");
    });
    const kept = db()
      .prepare("SELECT bucket FROM request_rate_limits WHERE scope='nest'")
      .all()
      .map((r) => r.bucket);
    expect(kept).toEqual(expect.arrayContaining(["e", "g"]));
    expect(kept).not.toContain("f");
  });
  it("refuses an asynchronous callback and stays usable afterwards", async () => {
    expect(() => atomic((async () => 1) as unknown as () => number)).toThrow(
      /asynchronous/,
    );
    expect(atomic(() => 7)).toBe(7);
    expect(db().isTransaction).toBe(false);
  });
});

describe("saving a record and the notifications it invalidates is all-or-nothing", () => {
  it("leaves the plan unsaved when a dependent weekly update cannot be changed", () => {
    const academyId = A,
      planId = `plan-${randomUUID()}`,
      weeklyId = `weekly-${randomUUID()}`,
      plan = {
        id: planId,
        academyId,
        sportId: "football",
        playerId: ids.p1,
      } as never;
    db()
      .prepare(
        "INSERT INTO workspace_records(academyId,kind,id,sportId,playerId,body) VALUES(?,?,?,?,?,?)",
      )
      .run(
        academyId,
        "weekly",
        weeklyId,
        "football",
        ids.p1,
        JSON.stringify({
          id: weeklyId,
          academyId,
          playerId: ids.p1,
          squadId: ids.squadA,
          status: "APPROVED",
          version: 1,
          content: { sourcePlanId: planId, sessions: [], period: {} },
        }),
      );
    db().exec(
      `CREATE TRIGGER test_block_weekly BEFORE UPDATE ON workspace_records WHEN OLD.kind='weekly' BEGIN SELECT RAISE(ABORT,'weekly locked'); END`,
    );
    try {
      expect(() => repo.save(academyId, "plan", plan)).toThrow(/weekly locked/);
      expect(repo.find(academyId, "plan", planId)).toBeUndefined();
    } finally {
      db().exec("DROP TRIGGER test_block_weekly");
    }
    // Without the failure the same save succeeds and invalidates the update.
    repo.save(academyId, "plan", plan);
    expect(repo.find(academyId, "plan", planId)).toBeDefined();
    expect(repo.find(academyId, "weekly", weeklyId)?.status).toBe(
      "INVALIDATED",
    );
  });
});

describe("database failures are mapped to the right response", () => {
  const caught = (sql: string) => {
    try {
      db().exec(sql);
    } catch (error) {
      return error;
    }
    throw new Error("expected the statement to fail");
  };
  it("answers a duplicate key with 409 and a plain message", async () => {
    db().exec(
      "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES('m-dup','academy-a','dup-user','COACH',1)",
    );
    const response = apiError(
      caught(
        "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES('m-dup2','academy-a','dup-user','COACH',1)",
      ),
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(
      /UNIQUE|academy_memberships/,
    );
  });
  it("answers a busy database with 503 and Retry-After", () => {
    const busy = Object.assign(new Error("database is locked"), {
      errcode: 5,
    });
    const response = apiError(busy);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });
  it("does not turn a rule the service should have enforced into a client error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = apiError(
        caught(
          "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES('m-x','academy-a','x-user','OVERLORD',1)",
        ),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("x-error-reference")).toMatch(
        /^[0-9a-f]{8}$/,
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("migration 008 guards", () => {
  const record = (over: Record<string, unknown> = {}, columns = {}) => {
    const body = { id: "r-1", academyId: A, ...over },
      c = { academyId: A, kind: "note", id: "r-1", ...columns };
    return () =>
      db()
        .prepare(
          "INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)",
        )
        .run(c.academyId, c.kind, c.id, JSON.stringify(body));
  };
  it("refuses a record filed under another academy, with another id, or malformed", () => {
    expect(record({ academyId: B })).toThrow(/does not match/);
    expect(record({ id: "other" })).toThrow(/does not match/);
    expect(() =>
      db()
        .prepare(
          "INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)",
        )
        .run(A, "note", "r-bad", "{not json"),
    ).toThrow(/does not match/);
    expect(
      count("SELECT COUNT(*) n FROM workspace_records WHERE kind='note'"),
    ).toBe(0);
  });
  it("accepts a correct record and refuses an update that moves it to another academy", () => {
    record()();
    expect(() =>
      db()
        .prepare(
          "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='note' AND id='r-1'",
        )
        .run(JSON.stringify({ id: "r-1", academyId: B }), A),
    ).toThrow(/does not match/);
    db().prepare("DELETE FROM workspace_records WHERE kind='note'").run();
  });
  it("refuses a finance record that belongs to another academy", () => {
    const insert = (academyId: string, bodyAcademy: string) =>
      db()
        .prepare(
          "INSERT INTO academy_finance_records(academyId,kind,id,body,version) VALUES(?,?,?,?,1)",
        )
        .run(
          academyId,
          "invoice",
          "inv-guard",
          JSON.stringify({ id: "inv-guard", academyId: bodyAcademy }),
        );
    expect(() => insert(A, B)).toThrow(/does not match/);
    insert(A, A);
    db()
      .prepare("DELETE FROM academy_finance_records WHERE id='inv-guard'")
      .run();
  });
  it("makes history and the audit trail append-only against edits", () => {
    for (const [table, insert, update] of [
      [
        "training_history",
        "INSERT INTO training_history(academyId,kind,recordId,version,body,actorId,at) VALUES('academy-a','session','s',1,'{}','u','t')",
        "UPDATE training_history SET body='{\"edited\":true}'",
      ],
      [
        "workspace_audit",
        "INSERT INTO workspace_audit(academyId,userId,action,at) VALUES('academy-a','u','test','t')",
        "UPDATE workspace_audit SET action='rewritten'",
      ],
      [
        "academy_finance_history",
        "INSERT INTO academy_finance_history(academyId,kind,recordId,version,body,actorId,at) VALUES('academy-a','invoice','i',1,'{}','u','t')",
        "UPDATE academy_finance_history SET body='{\"edited\":true}'",
      ],
    ]) {
      db().exec(insert); // appending is always allowed
      expect(() => db().exec(update), table).toThrow(/append-only/);
    }
  });
  it("limits roles to the five the product defines", () => {
    expect(() =>
      db().exec(
        "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES('m-bad','academy-a','bad-user','GUEST',1)",
      ),
    ).toThrow(/unknown academy role/);
    expect(() =>
      db().exec(
        "UPDATE academy_memberships SET role='GUEST' WHERE userId='coach-a'",
      ),
    ).toThrow(/unknown academy role/);
    expect(() =>
      db().exec(
        "INSERT INTO workspace_invitations(id,academyId,email,role,playerIds,tokenHash,expiresAt) VALUES('i-bad','academy-a','a@b.test','GUEST','[]','h','2999')",
      ),
    ).toThrow(/unknown invitation role/);
  });
  it("is safe to run again and leaves rows written before it untouched", () => {
    const before = count("SELECT COUNT(*) n FROM workspace_records");
    migrateIntegrityGuards(db());
    migrateIntegrityGuards(db());
    expect(count("SELECT COUNT(*) n FROM workspace_records")).toBe(before);
    // A database that already holds a mismatched row (written before the
    // guard existed) must still open and run the migration.
    db().exec("DROP TRIGGER workspace_records_owner_insert");
    try {
      db()
        .prepare(
          "INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)",
        )
        .run(
          A,
          "note",
          "legacy",
          JSON.stringify({ id: "legacy", academyId: B }),
        );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => migrateIntegrityGuards(db())).not.toThrow();
      expect(warn.mock.calls.flat().join(" ")).toMatch(
        /workspace_records_owner NOT installed/,
      );
      warn.mockRestore();
      // While the legacy row exists the guard stays off, so saves still work...
      expect(
        count(
          "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='workspace_records_owner_insert'",
        ),
      ).toBe(0);
      expect(
        count("SELECT COUNT(*) n FROM workspace_records WHERE id='legacy'"),
      ).toBe(1);
    } finally {
      db().prepare("DELETE FROM workspace_records WHERE id='legacy'").run();
    }
    // ...and it installs itself on a later start once the data is clean.
    migrateIntegrityGuards(db());
    expect(
      count(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='workspace_records_owner_insert'",
      ),
    ).toBe(1);
  });
});

describe("the shared coach rule", () => {
  it("covers a group only when every player is assigned to that coach", () => {
    expect(coachCoversPlayers(A, ids.coachA, [ids.p1, ids.p2])).toBe(true);
    expect(coachCoversPlayers(A, ids.coachA, [ids.p1, ids.p3])).toBe(false);
    expect(coachCoversPlayers(A, ids.coachB, [ids.p3])).toBe(true);
    expect(coachCoversPlayers(A, ids.coachB, [ids.p1])).toBe(false);
    expect(coachCoversPlayers(A, ids.coachA, ["no-such-player"])).toBe(false);
    expect(coachCoversPlayers(A, ids.coachA, [])).toBe(true);
  });
  it("never reaches across academies", () => {
    expect(coachCoversPlayers(B, ids.coachA, [ids.p1])).toBe(false);
    expect(coachCoversPlayers(A, ids.coachA, [ids.bPlayer])).toBe(false);
  });
});

describe("invitations and revocation", () => {
  it("are re-exported from workspace-service unchanged", () => {
    expect(workspaceService.invite).toBe(membership.invite);
    expect(workspaceService.acceptInvitation).toBe(membership.acceptInvitation);
    expect(workspaceService.revokeMembership).toBe(membership.revokeMembership);
  });
  it("create an invitation and its audit entry together, or neither", () => {
    const owner = contextFor("ownerA"),
      invitations = () =>
        count(
          "SELECT COUNT(*) n FROM workspace_invitations WHERE academyId=?",
          A,
        );
    const before = invitations();
    db().exec(
      "CREATE TRIGGER test_block_audit BEFORE INSERT ON workspace_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    try {
      expect(() =>
        membership.invite(owner, {
          email: "new-coach@example.test",
          role: "COACH",
        }),
      ).toThrow(/audit unavailable/);
      expect(invitations()).toBe(before);
    } finally {
      db().exec("DROP TRIGGER test_block_audit");
    }
    membership.invite(owner, {
      email: "new-coach@example.test",
      role: "COACH",
    });
    expect(invitations()).toBe(before + 1);
  });
  it("do not let a coach invite or revoke anyone", () => {
    const coach = contextFor("coachA");
    expect(() =>
      membership.invite(coach, { email: "x@example.test", role: "COACH" }),
    ).toThrow(/role cannot perform/);
    expect(() => membership.revokeMembership(coach, "anything")).toThrow(
      /role cannot perform/,
    );
  });
});

describe("the write rate limiter", () => {
  const limit = (name: string, max = 3) => ({ name, max, windowSeconds: 60 });
  const status = (fn: () => void) => {
    try {
      fn();
      return 200;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  it("allows the limit, then refuses with 429 and a sensible Retry-After", () => {
    const l = limit("t1"),
      now = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) enforceRateLimit("user-a", l, now);
    try {
      enforceRateLimit("user-a", l, now + 1000);
      throw new Error("expected 429");
    } catch (error) {
      const e = error as { status: number; headers: Record<string, string> };
      expect(e.status).toBe(429);
      expect(Number(e.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
      expect(Number(e.headers["Retry-After"])).toBeLessThanOrEqual(60);
    }
  });
  it("starts a fresh allowance in the next window", () => {
    const l = limit("t2"),
      now = 2_000_000_000_000;
    for (let i = 0; i < 3; i++) enforceRateLimit("user-a", l, now);
    expect(status(() => enforceRateLimit("user-a", l, now))).toBe(429);
    expect(status(() => enforceRateLimit("user-a", l, now + 61_000))).toBe(200);
  });
  it("counts each user separately and each action separately", () => {
    const now = 3_000_000_000_000;
    for (let i = 0; i < 3; i++) enforceRateLimit("user-a", limit("t3"), now);
    expect(status(() => enforceRateLimit("user-a", limit("t3"), now))).toBe(
      429,
    );
    expect(status(() => enforceRateLimit("user-b", limit("t3"), now))).toBe(
      200,
    );
    expect(
      status(() => enforceRateLimit("user-a", limit("t3-other"), now)),
    ).toBe(200);
  });
  describe("on state-changing routes", () => {
    const rows = () =>
      count(
        "SELECT COUNT(*) n FROM request_rate_limits WHERE scope LIKE 'write:%'",
      );
    const post = (
      as: "parent1" | "parent2" | undefined,
      cookie = "better-auth.session_token=anything",
    ) =>
      callRoute(recordsRoute.POST, {
        path: `/api/workspaces/${A}/records/preference`,
        method: "POST",
        as,
        params: { academyId: A, kind: "preference" },
        headers: { cookie },
        json: {
          nutrition: false,
          development: true,
          inApp: true,
          language: "en",
          quietStart: "",
          quietEnd: "",
        },
      });
    it("limit a signed-in person, whatever cookies they send", async () => {
      // A fixed clock keeps all calls inside one window.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2031-01-01T00:00:10Z"));
      try {
        // Forged cookie names and rotating values must not buy a new allowance.
        const results: number[] = [];
        for (let i = 0; i < 8; i++)
          results.push(
            (
              await post(
                "parent1",
                `x.session_token=forged-${i}; better-auth.session_token=s${i}`,
              )
            ).status,
          );
        expect(results.slice(0, 6).every((x) => x === 201)).toBe(true);
        expect(results.slice(6)).toEqual([429, 429]);
        const last = await post("parent1");
        expect(last.headers.get("retry-after")).toMatch(/^[0-9]+$/);
        // Another person is unaffected; reads are not counted.
        expect((await post("parent2")).status).toBe(201);
        const read = await callRoute(recordsRoute.GET, {
          path: `/api/workspaces/${A}/records/preference`,
          as: "parent1",
          params: { academyId: A, kind: "preference" },
        });
        expect(read.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });
    it("write nothing for a caller who is not signed in", async () => {
      const before = rows();
      for (let i = 0; i < 20; i++)
        expect(
          (await post(undefined, `better-auth.session_token=random-${i}`))
            .status,
        ).toBe(401);
      expect(rows()).toBe(before);
    });
    it("never store a session token", () => {
      const scopes = db()
        .prepare("SELECT scope FROM request_rate_limits")
        .all()
        .map((r) => String(r.scope));
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes)
        expect(scope).not.toMatch(/session|token|anything/);
    });
  });
});

describe("replying to a conversation", () => {
  const start = () =>
    workspaceService.saveRecord(contextFor("parent1"), "conversation", {
      playerId: ids.p1,
      guardianId: ids.parent1,
      subject: "Question about training",
    }) as { id: string };
  const messages = (id: string) =>
    (repo.find(A, "conversation", id) as { messages: { body: string }[] })
      .messages;
  it("holds the write lock from reading the conversation to saving it", () => {
    const { id } = start();
    const other = new DatabaseSync(filename); // stands in for the worker process
    other.exec("PRAGMA busy_timeout=0");
    const probe = () => {
      try {
        other.exec("BEGIN IMMEDIATE");
        other.exec("ROLLBACK");
        return "second connection obtained the write lock";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const seen: Record<string, string> = {};
    const realFind = repo.find.bind(repo),
      realSave = repo.save.bind(repo);
    vi.spyOn(repo, "find").mockImplementation(((
      ...args: Parameters<typeof realFind>
    ) => {
      if (args[1] === "conversation") seen.find ??= probe();
      return realFind(...args);
    }) as never);
    vi.spyOn(repo, "save").mockImplementation(((
      ...args: Parameters<typeof realSave>
    ) => {
      if (args[1] === "conversation") seen.save = probe();
      return realSave(...args);
    }) as never);
    try {
      workspaceService.reply(contextFor("coachA"), id, { body: "On my way" });
    } finally {
      vi.restoreAllMocks();
      other.close();
    }
    // The lock is held when the conversation is READ, not only when it is saved.
    expect(seen.find).toMatch(/database is locked/);
    expect(seen.save).toMatch(/database is locked/);
    expect(messages(id).map((m) => m.body)).toEqual(["On my way"]);
  });
  it("saves the message and its audit entry together, or neither", () => {
    const { id } = start();
    db().exec(
      "CREATE TRIGGER test_block_reply_audit BEFORE INSERT ON workspace_audit WHEN NEW.action LIKE 'Conversation%' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    try {
      expect(() =>
        workspaceService.reply(contextFor("coachA"), id, { body: "Lost?" }),
      ).toThrow(/audit unavailable/);
    } finally {
      db().exec("DROP TRIGGER test_block_reply_audit");
    }
    expect(messages(id)).toEqual([]);
    workspaceService.reply(contextFor("coachA"), id, { body: "Kept" });
    expect(messages(id).map((m) => m.body)).toEqual(["Kept"]);
  });
  it("still refuses a reply to a closed conversation and hides staff notes from the parent", () => {
    const { id } = start();
    workspaceService.reply(contextFor("coachA"), id, {
      body: "Closing",
      action: "close",
    });
    expect(() =>
      workspaceService.reply(contextFor("parent1"), id, { body: "Hello" }),
    ).toThrow(/Reopen/);
    workspaceService.reply(contextFor("coachA"), id, {
      body: "Reopening",
      action: "reopen",
    });
    const forStaff = workspaceService.reply(contextFor("coachA"), id, {
      body: "Staff only",
      internal: true,
    });
    expect(forStaff.messages.some((m) => m.internal)).toBe(true);
    const parentView = workspaceService.reply(contextFor("parent1"), id, {
      body: "Thanks",
    });
    expect(parentView.messages.map((m) => m.body)).toEqual(["Thanks"]);
    expect(() =>
      workspaceService.reply(contextFor("parent1"), id, {
        body: "x",
        internal: true,
      }),
    ).toThrow(/staff-only/);
  });
});

describe("a transaction opened by someone else", () => {
  it("makes atomic() fail as retryable 'busy', and works again afterwards", () => {
    db().exec("BEGIN IMMEDIATE"); // as Better Auth does on the shared connection
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let failure: unknown;
      try {
        atomic(() => 1);
      } catch (error) {
        failure = error;
      }
      const response = apiError(failure);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
    } finally {
      warn.mockRestore();
      db().exec("ROLLBACK");
    }
    expect(atomic(() => 1)).toBe(1);
  });
});
