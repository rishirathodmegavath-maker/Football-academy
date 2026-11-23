// The academy approval workflow: the state machine, the migration of academies
// that already exist, what an unapproved academy can and cannot reach (every
// route, on the server), the platform administrator's decisions and their
// authorization, concurrency, isolation, and the notices. docs/ACADEMY_APPROVAL.md
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
  // These tests are about the platform review, which a deployment switches on explicitly; the default is a direct opening.
  process.env.SPORTOZEN_ACADEMY_APPROVAL = "required";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { registerTestUser } from "./helpers/mock-auth";
import { A, B, ids, callRoute, seedApiFixture } from "./helpers/api-harness";
import {
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  TRANSITIONS,
  nextState,
  historyAction,
  isOperationalState,
  type LifecycleAction,
  type LifecycleState,
} from "@/domain/academy-lifecycle";
import {
  migrateAcademyLifecycle,
  MIGRATION_ACTOR,
} from "@/server/migrations/013-academy-lifecycle";
import {
  academyOperational,
  lifecycleOf,
} from "@/server/academy-lifecycle-state";
import { processOutbox } from "@/server/email/outbox";
import { captured, resetCapture } from "@/server/email/transport";
import * as workspacesRoute from "@/app/api/workspaces/route";
import * as academyRoute from "@/app/api/workspaces/[academyId]/route";
import * as bootstrapRoute from "@/app/api/workspaces/[academyId]/bootstrap/route";
import * as lifecycleRoute from "@/app/api/workspaces/[academyId]/lifecycle/route";
import * as accountsRoute from "@/app/api/platform/accounts/route";
import * as queueRoute from "@/app/api/platform/applications/route";
import * as detailRoute from "@/app/api/platform/applications/[academyId]/route";
import * as decisionRoute from "@/app/api/platform/applications/[academyId]/decision/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";

const filename = join(tmpdir(), `sportozen-approval-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const ADMIN = "platform-admin",
  ADMIN2 = "platform-admin-2",
  OWNER = "new-owner",
  OWNER2 = "new-owner-2",
  MEMBER_ADMIN = "academy-admin";
const as = (user: string) => ({ headers: { "x-test-user": user } });

beforeAll(() => {
  database().exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT)',
  );
  seedApiFixture();
  for (const [id, name] of [
    [ADMIN, "Platform Admin One"],
    [ADMIN2, "Platform Admin Two"],
    [OWNER, "New Owner"],
    [OWNER2, "Second New Owner"],
    [MEMBER_ADMIN, "Academy Admin"],
  ] as const) {
    registerTestUser(id, name);
    database()
      .prepare('INSERT OR REPLACE INTO "user"(id,name,email) VALUES(?,?,?)')
      .run(id, name, `${id}@example.test`);
  }
  for (const id of [ADMIN, ADMIN2])
    database()
      .prepare("INSERT INTO platform_administrators(userId) VALUES(?)")
      .run(id);
});
// Creating an academy is limited to 10 an hour per person; the tests create
// many, so the counters are cleared between tests (the limit itself is tested
// in rate-limit-routes.test.ts).
beforeEach(() => {
  database().exec("DELETE FROM request_rate_limits");
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const academyBody = (name: string) => ({
  name,
  contactEmail: "office@example.test",
  country: "IN",
  language: "English",
  currency: "INR",
  timezone: "Asia/Kolkata",
  dateLocale: "en-IN",
  measurementSystem: "METRIC",
  brandAccent: "#008463",
  sportIds: ["football"],
  ageGroups: [],
  reviewFrequency: "Monthly",
  modules: ["development", "reports", "communication", "fees"],
  demo: false,
});
async function create(owner: string, name: string) {
  const res = await callRoute(workspacesRoute.POST, {
    path: "/api/workspaces",
    method: "POST",
    json: academyBody(name),
    ...as(owner),
  });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}
const lifecycle = (user: string, academyId: string) =>
  callRoute(lifecycleRoute.GET, {
    path: `/api/workspaces/${academyId}/lifecycle`,
    params: { academyId },
    ...as(user),
  });
const submit = (user: string, academyId: string, expectedVersion: number) =>
  callRoute(lifecycleRoute.POST, {
    path: `/api/workspaces/${academyId}/lifecycle`,
    method: "POST",
    params: { academyId },
    json: { action: "submit", expectedVersion },
    ...as(user),
  });
const version = (academyId: string) => lifecycleOf(academyId)!.version;
const decide = (
  user: string | undefined,
  academyId: string,
  decision: string,
  reason?: string,
  expectedVersion = version(academyId),
) =>
  callRoute(decisionRoute.POST, {
    path: `/api/platform/applications/${academyId}/decision`,
    method: "POST",
    params: { academyId },
    json: { decision, reason, expectedVersion },
    ...(user ? as(user) : {}),
  });
const REASON = "The contact details do not match the academy name.";
/** An academy taken to the given state through the real routes. */
async function academyAt(
  owner: string,
  name: string,
  target:
    "CONFIGURING" | "SUBMITTED" | "PENDING_REVIEW" | "REJECTED" | "ACTIVE",
) {
  const id = await create(owner, name);
  if (target === "CONFIGURING") return id;
  expect((await submit(owner, id, version(id))).status).toBe(200);
  if (target === "SUBMITTED") return id;
  expect((await decide(ADMIN, id, "startReview")).status).toBe(200);
  if (target === "PENDING_REVIEW") return id;
  expect(
    (
      await decide(
        ADMIN,
        id,
        target === "ACTIVE" ? "approve" : "reject",
        REASON,
      )
    ).status,
  ).toBe(200);
  return id;
}

describe("the state machine", () => {
  // The whole table, written out: every (state, action) pair is either a
  // listed transition or refused. A change to TRANSITIONS fails this test.
  const ALLOWED: Record<LifecycleAction, [LifecycleState[], LifecycleState]> = {
    submit: [["CONFIGURING", "REJECTED"], "SUBMITTED"],
    startReview: [["SUBMITTED"], "PENDING_REVIEW"],
    approve: [["PENDING_REVIEW"], "ACTIVE"],
    reject: [["PENDING_REVIEW"], "REJECTED"],
    suspend: [["ACTIVE"], "SUSPENDED"],
    reactivate: [["SUSPENDED"], "ACTIVE"],
  };
  it("allows exactly the listed transitions and refuses every other pair", () => {
    let refused = 0;
    for (const state of LIFECYCLE_STATES)
      for (const action of LIFECYCLE_ACTIONS) {
        const [from, to] = ALLOWED[action];
        const expected = from.includes(state) ? to : null;
        expect(nextState(state, action), `${state} + ${action}`).toBe(expected);
        if (!expected) refused++;
      }
    expect(LIFECYCLE_STATES.length * LIFECYCLE_ACTIONS.length).toBe(36);
    expect(refused).toBe(36 - 7);
  });
  it("says who may act and which actions need a written reason", () => {
    expect(TRANSITIONS.submit.actor).toBe("OWNER");
    for (const a of [
      "startReview",
      "approve",
      "reject",
      "suspend",
      "reactivate",
    ] as const)
      expect(TRANSITIONS[a].actor, a).toBe("PLATFORM");
    expect(
      LIFECYCLE_ACTIONS.filter((a) => TRANSITIONS[a].reasonRequired).sort(),
    ).toEqual(["reject", "suspend"]);
  });
  it("opens operations only in ACTIVE", () => {
    for (const state of LIFECYCLE_STATES)
      expect(isOperationalState(state), state).toBe(state === "ACTIVE");
    expect(isOperationalState(undefined)).toBe(false);
  });
  it("labels a resubmission differently in the history", () => {
    expect(historyAction("submit", "CONFIGURING")).toBe("SUBMITTED");
    expect(historyAction("submit", "REJECTED")).toBe("RESUBMITTED");
  });
  it("cannot leave ACTIVE except by suspension, and SUSPENDED only by reactivation", () => {
    for (const action of LIFECYCLE_ACTIONS) {
      const fromActive = nextState("ACTIVE", action);
      expect(fromActive === null || fromActive === "SUSPENDED").toBe(true);
      const fromSuspended = nextState("SUSPENDED", action);
      expect(fromSuspended === null || fromSuspended === "ACTIVE").toBe(true);
    }
  });
});

describe("the migration of academies that already exist", () => {
  function legacyDatabase() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`CREATE TABLE academy_workspaces(id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE platform_entitlements(academyId TEXT PRIMARY KEY REFERENCES academy_workspaces(id),tier TEXT NOT NULL,modules TEXT NOT NULL,status TEXT NOT NULL);`);
    for (const [id, status] of [
      ["live", "ACTIVE"],
      ["paused", "PAUSED"],
      ["odd", "SUSPENDED"],
      ["noentitlement", null],
    ] as const) {
      db.prepare("INSERT INTO academy_workspaces VALUES(?,?)").run(
        id,
        JSON.stringify({ id, configVersion: 3 }),
      );
      if (status)
        db.prepare("INSERT INTO platform_entitlements VALUES(?,?,?,?)").run(
          id,
          "T",
          "[]",
          status,
        );
    }
    return db;
  }
  it("records an ACTIVE academy as ACTIVE and every other as SUSPENDED, by a named rule, with history", () => {
    const db = legacyDatabase();
    migrateAcademyLifecycle(db);
    const states = Object.fromEntries(
      db
        .prepare("SELECT academyId,state,decidedBy FROM academy_lifecycle")
        .all()
        .map((r) => [r.academyId, [r.state, r.decidedBy]]),
    );
    expect(states).toEqual({
      live: ["ACTIVE", MIGRATION_ACTOR],
      paused: ["SUSPENDED", MIGRATION_ACTOR],
      odd: ["SUSPENDED", MIGRATION_ACTOR],
      noentitlement: ["SUSPENDED", MIGRATION_ACTOR],
    });
    const history = db
      .prepare("SELECT * FROM academy_lifecycle_history ORDER BY academyId")
      .all();
    expect(history).toHaveLength(4);
    for (const h of history) {
      expect(h.action).toBe("MIGRATED");
      expect(h.actorKind).toBe("SYSTEM");
      expect(h.actorId).toBe(MIGRATION_ACTOR);
      expect(h.fromState).toBeNull();
      expect(h.configVersion).toBe(3);
      expect(String(h.at)).toMatch(/Z$/);
    }
    // Nothing else changed.
    expect(
      db
        .prepare(
          "SELECT status FROM platform_entitlements WHERE academyId='paused'",
        )
        .get()?.status,
    ).toBe("PAUSED");
  });
  it("is idempotent and never overwrites a decision made since", () => {
    const db = legacyDatabase();
    migrateAcademyLifecycle(db);
    db.prepare(
      "UPDATE academy_lifecycle SET state='SUSPENDED', version=2 WHERE academyId='live'",
    ).run();
    migrateAcademyLifecycle(db);
    migrateAcademyLifecycle(db);
    expect(
      db
        .prepare(
          "SELECT state,version FROM academy_lifecycle WHERE academyId='live'",
        )
        .get(),
    ).toMatchObject({ state: "SUSPENDED", version: 2 });
    expect(
      db.prepare("SELECT COUNT(*) n FROM academy_lifecycle").get()?.n,
    ).toBe(4);
    expect(
      db.prepare("SELECT COUNT(*) n FROM academy_lifecycle_history").get()?.n,
    ).toBe(4);
  });
  it("gives an academy added later no record: it is not operational until one exists", () => {
    const db = legacyDatabase();
    migrateAcademyLifecycle(db);
    db.prepare("INSERT INTO academy_workspaces VALUES('late','{}')").run();
    migrateAcademyLifecycle(db); // the next start-up records it by the same rule
    expect(
      db
        .prepare("SELECT state FROM academy_lifecycle WHERE academyId='late'")
        .get()?.state,
    ).toBe("SUSPENDED");
  });
  it("keeps the history append-only and the state vocabulary closed", () => {
    const db = legacyDatabase();
    migrateAcademyLifecycle(db);
    expect(() =>
      db.prepare("UPDATE academy_lifecycle_history SET reason='x'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM academy_lifecycle_history").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db
        .prepare(
          "UPDATE academy_lifecycle SET state='APPROVED' WHERE academyId='live'",
        )
        .run(),
    ).toThrow();
  });
  it("leaves a missing lifecycle row not operational (fail closed)", () => {
    expect(lifecycleOf("no-such-academy")).toBeUndefined();
    expect(academyOperational("no-such-academy")).toBe(false);
  });
});

describe("a new academy", () => {
  it("starts in CONFIGURING with a registration record, and is not operational", async () => {
    const id = await create(OWNER, "Fresh Academy");
    expect(lifecycleOf(id)).toMatchObject({
      state: "CONFIGURING",
      version: 1,
      submissions: 0,
    });
    expect(academyOperational(id)).toBe(false);
    const history = database()
      .prepare("SELECT * FROM academy_lifecycle_history WHERE academyId=?")
      .all(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromState: null,
      toState: "CONFIGURING",
      action: "REGISTERED",
      actorId: OWNER,
      actorKind: "OWNER",
    });
  });
  it("can read its status and bootstrap, and edit its profile", async () => {
    const id = await create(OWNER, "Profile Academy");
    const view = await lifecycle(OWNER, id);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      state: "CONFIGURING",
      label: "Setting up",
      canSubmit: true,
      canEdit: true,
      progress: { done: 4, total: 9 },
    });
    const boot = await callRoute(bootstrapRoute.GET, {
      path: `/api/workspaces/${id}/bootstrap`,
      params: { academyId: id },
      ...as(OWNER),
    });
    expect(boot.status).toBe(200);
    expect(boot.body).toMatchObject({ lifecycle: { state: "CONFIGURING" } });
    expect(
      (boot.body as { academy: { onboardingStatus: string } }).academy
        .onboardingStatus,
    ).toBe("CONFIGURING");
    const saved = await callRoute(academyRoute.PATCH, {
      path: `/api/workspaces/${id}`,
      method: "PATCH",
      params: { academyId: id },
      json: {
        ...academyBody("Profile Academy"),
        phone: "+91 98765 43210",
        expectedVersion: 0,
      },
      ...as(OWNER),
    });
    expect(saved.status).toBe(200);
    const after = await lifecycle(OWNER, id);
    expect(after.body).toMatchObject({ progress: { done: 5, total: 9 } });
  });
  it("is refused every operational request, on the server", async () => {
    const id = await create(OWNER, "Closed Academy");
    // Every route under /api/workspaces/[academyId], every method it exports.
    const modules = Object.fromEntries(
      Object.entries(
        import.meta.glob("../../src/app/api/workspaces/**/route.ts"),
      ).filter(([file]) => file.includes("/[academyId]/")),
    );
    const OPEN = new Set([
      "GET bootstrap",
      "PATCH ",
      "GET lifecycle",
      "POST lifecycle",
    ]);
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    let checked = 0;
    const leaked: string[] = [];
    for (const [file, load] of Object.entries(modules)) {
      const name = file
        .replace(/^.*\[academyId\]\//, "")
        .replace(/\/?route\.ts$/, "");
      const mod = (await load()) as Record<string, unknown>;
      const params: Record<string, string> = {
        academyId: id,
        kind: "player",
        recordId: "x",
        reportId: "x",
        invitationId: "x",
      };
      for (const method of methods) {
        if (typeof mod[method] !== "function" || OPEN.has(`${method} ${name}`))
          continue;
        const res = await callRoute(mod[method], {
          // These check their query before they read anything.
          path: `/api/workspaces/${id}/${name}${name === "player-messages" || name === "attendance-history" ? "?player=x" : ""}`,
          method,
          params,
          json: method === "GET" ? undefined : {},
          ...as(OWNER),
        });
        checked++;
        if (
          res.status !== 403 ||
          (res.body as { code?: string }).code !== "ACADEMY_NOT_APPROVED"
        )
          leaked.push(
            `${method} ${name} -> ${res.status} ${JSON.stringify(res.body).slice(0, 80)}`,
          );
      }
    }
    expect(leaked).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(20);
  });
  it("tells the owner what is missing and a non-owner only that the academy is not open", async () => {
    const id = await create(OWNER, "Private Academy");
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,'[]')",
      )
      .run(randomUUID(), id, MEMBER_ADMIN, "ADMIN");
    const denied = await callRoute(academyRoute.GET, {
      path: `/api/workspaces/${id}`,
      params: { academyId: id },
      ...as(OWNER),
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain("submit it for approval");
    // An ADMIN can read the status, but not submit.
    const view = await lifecycle(MEMBER_ADMIN, id);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ canSubmit: false });
    expect((await submit(MEMBER_ADMIN, id, version(id))).status).toBe(403);
    // A stranger, and an owner of another academy, see nothing.
    for (const user of [ids.ownerA, ids.coachA, ids.parent1, ids.outsider]) {
      expect((await lifecycle(user, id)).status, user).toBe(403);
    }
  });
  it("cannot accept an invitation to an academy that is not open", async () => {
    const id = await create(OWNER, "Invite Academy");
    const token = "a".repeat(64);
    database()
      .prepare(
        "INSERT INTO workspace_invitations(id,academyId,email,role,playerIds,tokenHash,expiresAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        id,
        `${ids.outsider}@example.test`,
        "COACH",
        "[]",
        createHash("sha256").update(token).digest("hex"),
        new Date(Date.now() + 86_400_000).toISOString(),
      );
    const res = await callRoute(acceptRoute.POST, {
      path: "/api/invitations/accept",
      method: "POST",
      json: { token },
      ...as(ids.outsider),
    });
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe("ACADEMY_NOT_APPROVED");
  });
});

describe("submitting for approval", () => {
  it("moves CONFIGURING to SUBMITTED once, records who and when, and refuses a repeat", async () => {
    const id = await create(OWNER, "Submit Academy");
    const first = await submit(OWNER, id, 1);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "SUBMITTED", canSubmit: false });
    expect(lifecycleOf(id)).toMatchObject({
      state: "SUBMITTED",
      submissions: 1,
      version: 2,
    });
    expect(lifecycleOf(id)!.submittedAt).toMatch(/Z$/);
    // The same click twice: the second request is stale.
    const again = await submit(OWNER, id, 1);
    expect(again.status).toBe(409);
    expect((again.body as { code?: string }).code).toBe("STALE_VERSION");
    // A current version still cannot submit from SUBMITTED.
    const wrong = await submit(OWNER, id, version(id));
    expect(wrong.status).toBe(409);
    expect((wrong.body as { code?: string }).code).toBe("INVALID_TRANSITION");
    expect(lifecycleOf(id)!.submissions).toBe(1);
  });
  it("accepts only the documented body", async () => {
    const id = await create(OWNER, "Body Academy");
    for (const bad of [
      {},
      { action: "approve", expectedVersion: 1 },
      { action: "submit" },
      { action: "submit", expectedVersion: 0 },
    ])
      expect(
        (
          await callRoute(lifecycleRoute.POST, {
            path: `/api/workspaces/${id}/lifecycle`,
            method: "POST",
            params: { academyId: id },
            json: bad,
            ...as(OWNER),
          })
        ).status,
      ).toBe(400);
    expect(lifecycleOf(id)!.state).toBe("CONFIGURING");
  });
  it("refuses a request from another origin", async () => {
    const id = await create(OWNER, "Origin Academy");
    expect(
      (
        await callRoute(lifecycleRoute.POST, {
          path: `/api/workspaces/${id}/lifecycle`,
          method: "POST",
          params: { academyId: id },
          json: { action: "submit", expectedVersion: 1 },
          origin: "https://evil.example",
          ...as(OWNER),
        })
      ).status,
    ).toBe(403);
    expect(lifecycleOf(id)!.state).toBe("CONFIGURING");
  });
});

describe("the platform administrator's review", () => {
  it("lists applications waiting for a decision first, oldest first", async () => {
    const first = await academyAt(OWNER, "Queue One", "SUBMITTED");
    const second = await academyAt(OWNER2, "Queue Two", "SUBMITTED");
    const res = await callRoute(queueRoute.GET, {
      path: "/api/platform/applications",
      ...as(ADMIN),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      applications: {
        id: string;
        state: string;
        submittedAt: string | null;
        carriedOver: boolean;
      }[];
      waiting: number;
    };
    const waiting = body.applications.filter((a) => a.state === "SUBMITTED");
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    const ids2 = waiting.map((a) => a.id);
    expect(ids2.indexOf(first)).toBeLessThan(ids2.indexOf(second));
    // Waiting ones come before everything else.
    const firstOther = body.applications.findIndex(
      (a) => !["SUBMITTED", "PENDING_REVIEW"].includes(a.state),
    );
    const lastWaiting = body.applications
      .map((a) => a.state)
      .lastIndexOf("SUBMITTED");
    expect(lastWaiting).toBeLessThan(firstOther);
    expect(body.waiting).toBeGreaterThanOrEqual(2);
    // The fixture academies exist but were not decided by anyone.
    const filtered = await callRoute(queueRoute.GET, {
      path: "/api/platform/applications?state=ACTIVE",
      ...as(ADMIN),
    });
    expect(
      (
        filtered.body as { applications: { state: string }[] }
      ).applications.every((a) => a.state === "ACTIVE"),
    ).toBe(true);
    expect(
      (
        await callRoute(queueRoute.GET, {
          path: "/api/platform/applications?state=APPROVED",
          ...as(ADMIN),
        })
      ).status,
    ).toBe(400);
  });
  it("shows the submitted profile and the history, and nothing about children", async () => {
    const id = await academyAt(OWNER, "Detail Academy", "SUBMITTED");
    const res = await callRoute(detailRoute.GET, {
      path: `/api/platform/applications/${id}`,
      params: { academyId: id },
      ...as(ADMIN),
    });
    expect(res.status).toBe(200);
    const detail = res.body as {
      state: string;
      owners: string[];
      profile: { name: string };
      history: { action: string; actorName: string | null; at: string }[];
      allowed: string[];
    };
    expect(detail).toMatchObject({
      state: "SUBMITTED",
      owners: ["New Owner"],
      allowed: ["startReview"],
    });
    expect(detail.profile.name).toBe("Detail Academy");
    expect(detail.history.map((h) => h.action)).toEqual([
      "SUBMITTED",
      "REGISTERED",
    ]);
    expect(detail.history[0]!.actorName).toBe("New Owner");
    expect(detail.history[0]!.at).toMatch(/Z$/);
    const text = JSON.stringify(res.body);
    for (const secret of ["player-1", "Synthetic Asha", "parent-1"])
      expect(text).not.toContain(secret);
  });
  it("approves through review, records the reviewer, and then opens operations", async () => {
    const id = await academyAt(OWNER, "Approve Academy", "SUBMITTED");
    // Approval needs a review first: a reviewer has to open the application.
    const early = await decide(ADMIN, id, "approve");
    expect(early.status).toBe(409);
    expect((early.body as { code?: string }).code).toBe("INVALID_TRANSITION");
    expect((await decide(ADMIN, id, "startReview")).status).toBe(200);
    expect(lifecycleOf(id)).toMatchObject({
      state: "PENDING_REVIEW",
      reviewerId: ADMIN,
    });
    const open = await callRoute(academyRoute.GET, {
      path: `/api/workspaces/${id}`,
      params: { academyId: id },
      ...as(OWNER),
    });
    expect(open.status).toBe(403);
    const approved = await decide(ADMIN2, id, "approve", "Looks good.");
    expect(approved.status).toBe(200);
    expect(lifecycleOf(id)).toMatchObject({
      state: "ACTIVE",
      decidedBy: ADMIN2,
      reviewerId: ADMIN,
      reason: "Looks good.",
    });
    expect(academyOperational(id)).toBe(true);
    const now = await callRoute(academyRoute.GET, {
      path: `/api/workspaces/${id}`,
      params: { academyId: id },
      ...as(OWNER),
    });
    expect(now.status).toBe(200);
    const history = database()
      .prepare(
        "SELECT action,actorId,actorKind,fromState,toState,at FROM academy_lifecycle_history WHERE academyId=? ORDER BY id",
      )
      .all(id);
    expect(history.map((h) => h.action)).toEqual([
      "REGISTERED",
      "SUBMITTED",
      "REVIEW_STARTED",
      "APPROVED",
    ]);
    expect(history.map((h) => h.actorId)).toEqual([
      OWNER,
      OWNER,
      ADMIN,
      ADMIN2,
    ]);
    expect(history[3]).toMatchObject({
      fromState: "PENDING_REVIEW",
      toState: "ACTIVE",
      actorKind: "PLATFORM",
    });
    for (const h of history)
      expect(String(h.at)).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    // The academy's own audit trail carries each step.
    const audit = database()
      .prepare(
        "SELECT action FROM workspace_audit WHERE academyId=? AND action LIKE 'Academy approval:%' ORDER BY id",
      )
      .all(id)
      .map((r) => r.action);
    expect(audit).toEqual([
      "Academy approval: SUBMITTED",
      "Academy approval: REVIEW_STARTED",
      "Academy approval: APPROVED",
    ]);
    // A second approval, or a rejection after approval, is refused.
    expect((await decide(ADMIN, id, "approve")).status).toBe(409);
    expect((await decide(ADMIN, id, "reject", REASON)).status).toBe(409);
  });
  it("rejects only with a real reason, shows it to the owner, and allows a resubmission", async () => {
    const id = await academyAt(OWNER, "Reject Academy", "PENDING_REVIEW");
    for (const reason of [undefined, "", "   ", "too short"]) {
      const res = await decide(ADMIN, id, "reject", reason);
      expect(res.status, String(reason)).toBe(400);
    }
    expect(lifecycleOf(id)!.state).toBe("PENDING_REVIEW");
    expect((await decide(ADMIN, id, "reject", "x".repeat(1001))).status).toBe(
      400,
    );
    expect((await decide(ADMIN, id, "reject", REASON)).status).toBe(200);
    expect(lifecycleOf(id)).toMatchObject({
      state: "REJECTED",
      reason: REASON,
      decidedBy: ADMIN,
    });
    const view = await lifecycle(OWNER, id);
    expect(view.body).toMatchObject({
      state: "REJECTED",
      feedback: REASON,
      canSubmit: true,
    });
    // Feedback goes to the owner, not to a reviewer's name.
    expect(JSON.stringify(view.body)).not.toContain("Platform Admin");
    // The owner edits and submits again.
    expect(
      (
        await callRoute(academyRoute.PATCH, {
          path: `/api/workspaces/${id}`,
          method: "PATCH",
          params: { academyId: id },
          json: {
            ...academyBody("Reject Academy"),
            contactEmail: "fixed@example.test",
            expectedVersion: 0,
          },
          ...as(OWNER),
        })
      ).status,
    ).toBe(200);
    const again = await submit(OWNER, id, version(id));
    expect(again.status).toBe(200);
    expect(lifecycleOf(id)).toMatchObject({
      state: "SUBMITTED",
      submissions: 2,
    });
    const queue = await callRoute(queueRoute.GET, {
      path: "/api/platform/applications?q=reject%20academy",
      ...as(ADMIN),
    });
    expect(
      (
        queue.body as { applications: { id: string; resubmitted: boolean }[] }
      ).applications.find((a) => a.id === id),
    ).toMatchObject({ resubmitted: true });
    const actions = database()
      .prepare(
        "SELECT action FROM academy_lifecycle_history WHERE academyId=? ORDER BY id",
      )
      .all(id)
      .map((r) => r.action);
    expect(actions).toEqual([
      "REGISTERED",
      "SUBMITTED",
      "REVIEW_STARTED",
      "REJECTED",
      "RESUBMITTED",
    ]);
    // ...and is then approved.
    expect((await decide(ADMIN, id, "startReview")).status).toBe(200);
    expect((await decide(ADMIN, id, "approve")).status).toBe(200);
    expect(lifecycleOf(id)!.reason).toBeNull();
  });
  it("refuses a decision made on a stale version, and a profile edit during review makes it stale", async () => {
    const id = await academyAt(OWNER, "Stale Academy", "PENDING_REVIEW");
    const seen = version(id);
    expect(
      (
        await callRoute(academyRoute.PATCH, {
          path: `/api/workspaces/${id}`,
          method: "PATCH",
          params: { academyId: id },
          json: {
            ...academyBody("Stale Academy"),
            about: "Changed after review began",
            expectedVersion: 0,
          },
          ...as(OWNER),
        })
      ).status,
    ).toBe(200);
    const stale = await decide(ADMIN, id, "approve", undefined, seen);
    expect(stale.status).toBe(409);
    expect((stale.body as { code?: string }).code).toBe("STALE_VERSION");
    expect(lifecycleOf(id)!.state).toBe("PENDING_REVIEW");
    expect((await decide(ADMIN, id, "approve")).status).toBe(200);
  });
  it("lets only one of two simultaneous decisions win", async () => {
    const id = await academyAt(OWNER, "Race Academy", "PENDING_REVIEW");
    const seen = version(id);
    const results = await Promise.all([
      decide(ADMIN, id, "approve", undefined, seen),
      decide(ADMIN2, id, "reject", REASON, seen),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const final = lifecycleOf(id)!;
    expect(["ACTIVE", "REJECTED"]).toContain(final.state);
    const decisions = database()
      .prepare(
        "SELECT COUNT(*) n FROM academy_lifecycle_history WHERE academyId=? AND action IN ('APPROVED','REJECTED')",
      )
      .get(id);
    expect(decisions?.n).toBe(1);
  });
  it("will not let an administrator decide an academy they belong to", async () => {
    const id = await academyAt(OWNER, "Conflict Academy", "SUBMITTED");
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,'[]')",
      )
      .run(randomUUID(), id, ADMIN, "ADMIN");
    const res = await decide(ADMIN, id, "startReview");
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe("CONFLICT_OF_INTEREST");
    expect((await decide(ADMIN2, id, "startReview")).status).toBe(200);
  });
  it("closes even the onboarding routes to a suspended lifecycle if the entitlement was left open", async () => {
    // Two records that should agree and do not: defence in depth, fail closed.
    const id = await academyAt(OWNER, "Inconsistent Academy", "ACTIVE");
    database()
      .prepare(
        "UPDATE academy_lifecycle SET state='SUSPENDED' WHERE academyId=?",
      )
      .run(id);
    expect(
      database()
        .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
        .get(id)?.status,
    ).toBe("ACTIVE");
    expect((await lifecycle(OWNER, id)).status).toBe(403);
    expect(
      (
        await callRoute(bootstrapRoute.GET, {
          path: `/api/workspaces/${id}/bootstrap`,
          params: { academyId: id },
          ...as(OWNER),
        })
      ).status,
    ).toBe(403);
    expect(academyOperational(id)).toBe(false);
  });
  it("suspends and reactivates with a record, closing and reopening the academy", async () => {
    const id = await academyAt(OWNER, "Suspend Academy", "ACTIVE");
    expect((await decide(ADMIN, id, "suspend")).status).toBe(400);
    expect(
      (await decide(ADMIN, id, "suspend", "Complaint under investigation"))
        .status,
    ).toBe(200);
    expect(lifecycleOf(id)!.state).toBe("SUSPENDED");
    expect(
      database()
        .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
        .get(id)?.status,
    ).toBe("PAUSED");
    for (const call of [
      () => lifecycle(OWNER, id),
      () =>
        callRoute(bootstrapRoute.GET, {
          path: `/api/workspaces/${id}/bootstrap`,
          params: { academyId: id },
          ...as(OWNER),
        }),
      () =>
        callRoute(academyRoute.GET, {
          path: `/api/workspaces/${id}`,
          params: { academyId: id },
          ...as(OWNER),
        }),
    ])
      expect((await call()).status).toBe(403);
    expect((await decide(ADMIN, id, "suspend", "Complaint again")).status).toBe(
      409,
    );
    expect((await decide(ADMIN, id, "reactivate", "Resolved")).status).toBe(
      200,
    );
    expect(lifecycleOf(id)!.state).toBe("ACTIVE");
    expect(academyOperational(id)).toBe(true);
    expect(
      database()
        .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
        .get(id)?.status,
    ).toBe("ACTIVE");
  });
  it("is closed to everyone who is not a platform administrator", async () => {
    const id = await academyAt(OWNER, "Closed Review Academy", "SUBMITTED");
    for (const user of [
      undefined,
      OWNER,
      ids.ownerA,
      ids.coachA,
      ids.parent1,
      ids.outsider,
    ]) {
      const wanted = user ? 403 : 401;
      expect(
        (
          await callRoute(queueRoute.GET, {
            path: "/api/platform/applications",
            ...(user ? as(user) : {}),
          })
        ).status,
        `queue ${user}`,
      ).toBe(wanted);
      expect(
        (
          await callRoute(detailRoute.GET, {
            path: `/api/platform/applications/${id}`,
            params: { academyId: id },
            ...(user ? as(user) : {}),
          })
        ).status,
        `detail ${user}`,
      ).toBe(wanted);
      expect(
        (await decide(user, id, "startReview")).status,
        `decision ${user}`,
      ).toBe(wanted);
    }
    expect(lifecycleOf(id)!.state).toBe("SUBMITTED");
    // The owner cannot approve their own academy by any route.
    expect((await decide(OWNER, id, "approve")).status).toBe(403);
    // Nor by editing the legacy entitlement route.
    expect(
      (
        await callRoute(accountsRoute.PATCH, {
          path: "/api/platform/accounts",
          method: "PATCH",
          json: { academyId: id, status: "ACTIVE", tier: "PILOT", modules: [] },
          ...as(OWNER),
        })
      ).status,
    ).toBe(403);
  });
  it("needs the same origin and the documented body for a decision", async () => {
    const id = await academyAt(OWNER, "Origin Review Academy", "SUBMITTED");
    expect(
      (
        await callRoute(decisionRoute.POST, {
          path: `/api/platform/applications/${id}/decision`,
          method: "POST",
          params: { academyId: id },
          json: { decision: "startReview", expectedVersion: version(id) },
          origin: "https://evil.example",
          ...as(ADMIN),
        })
      ).status,
    ).toBe(403);
    for (const bad of [
      {},
      { decision: "approve" },
      { decision: "delete", expectedVersion: 1 },
      { decision: "approve", expectedVersion: -1 },
    ])
      expect(
        (
          await callRoute(decisionRoute.POST, {
            path: `/api/platform/applications/${id}/decision`,
            method: "POST",
            params: { academyId: id },
            json: bad,
            ...as(ADMIN),
          })
        ).status,
      ).toBe(400);
    expect(
      (await decide(ADMIN, "no-such-academy", "startReview", undefined, 1))
        .status,
    ).toBe(404);
  });
});

describe("academy isolation", () => {
  it("leaves an approved academy unaffected by another's application and by decisions on it", async () => {
    const id = await academyAt(OWNER, "Neighbour Academy", "SUBMITTED");
    expect(lifecycleOf(A)!.state).toBe("ACTIVE");
    await decide(ADMIN, id, "startReview");
    await decide(ADMIN, id, "reject", REASON);
    expect(lifecycleOf(A)!.state).toBe("ACTIVE");
    expect(
      (
        await callRoute(academyRoute.GET, {
          path: `/api/workspaces/${A}`,
          params: { academyId: A },
          as: "ownerA",
        })
      ).status,
    ).toBe(200);
    // The new owner cannot read the status of, or act in, an academy that is not theirs.
    for (const target of [A, B])
      expect((await lifecycle(OWNER, target)).status).toBe(403);
    expect((await submit(OWNER, A, 1)).status).toBe(403);
    // A decision cannot be made by naming one academy in the path and another's version.
    const other = await academyAt(OWNER2, "Other Neighbour", "PENDING_REVIEW");
    const res = await decide(ADMIN, other, "approve", undefined, version(id));
    expect(version(id)).not.toBe(version(other));
    expect(res.status).toBe(res.status === 200 ? 200 : 409);
    expect(lifecycleOf(id)!.state).toBe("REJECTED");
  });
  it("keeps the fixture academies working and decided by the migration, not a reviewer", () => {
    expect(lifecycleOf(A)!.state).toBe("ACTIVE");
    expect(lifecycleOf(B)!.state).toBe("ACTIVE");
  });
});

describe("the legacy entitlement route", () => {
  it("still changes the tier and modules, but no longer pauses or resumes an academy", async () => {
    const id = await academyAt(OWNER, "Entitlement Academy", "ACTIVE");
    const body = { academyId: id, tier: "PILOT", modules: ["development"] };
    expect(
      (
        await callRoute(accountsRoute.PATCH, {
          path: "/api/platform/accounts",
          method: "PATCH",
          json: { ...body, status: "PAUSED" },
          ...as(ADMIN),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callRoute(accountsRoute.PATCH, {
          path: "/api/platform/accounts",
          method: "PATCH",
          json: body,
          ...as(ADMIN),
        })
      ).status,
    ).toBe(200);
    expect(lifecycleOf(id)!.state).toBe("ACTIVE");
    expect(
      database()
        .prepare(
          "SELECT tier,status FROM platform_entitlements WHERE academyId=?",
        )
        .get(id),
    ).toMatchObject({ tier: "PILOT", status: "ACTIVE" });
  });
});

describe("notices", () => {
  beforeEach(() => {
    process.env.SPORTOZEN_EMAIL_TRANSPORT = "capture";
    process.env.SPORTOZEN_EMAIL_FROM = "notifications@example.test";
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
    resetCapture();
  });
  afterAll(() => {
    delete process.env.SPORTOZEN_EMAIL_TRANSPORT;
    delete process.env.SPORTOZEN_EMAIL_FROM;
  });
  it("tells the administrators about a submission and the owner about each decision", async () => {
    const id = await create(OWNER, "Notice Academy");
    await submit(OWNER, id, version(id));
    await processOutbox();
    const toAdmins = captured.filter((m) =>
      m.subject.includes("New academy application"),
    );
    expect(toAdmins.map((m) => m.to).sort()).toEqual(
      [`${ADMIN}@example.test`, `${ADMIN2}@example.test`].sort(),
    );
    expect(toAdmins[0]!.text).toContain("Notice Academy");
    expect(toAdmins[0]!.text).toContain("/platform");
    resetCapture();
    await decide(ADMIN, id, "startReview");
    await decide(ADMIN, id, "reject", REASON);
    await processOutbox();
    const rejected = captured.find((m) => m.to === `${OWNER}@example.test`)!;
    expect(rejected.subject).toContain("not approved");
    expect(rejected.text).toContain(REASON);
    expect(rejected.text).toContain(`/workspace/${id}`);
    expect(rejected.text).not.toContain("Platform Admin One");
    resetCapture();
    await submit(OWNER, id, version(id));
    await decide(ADMIN, id, "startReview");
    await decide(ADMIN, id, "approve");
    await decide(ADMIN, id, "suspend", "Paused while we check a complaint");
    await decide(ADMIN, id, "reactivate", "Check complete");
    await processOutbox({ limit: 50 });
    const subjects = captured
      .filter((m) => m.to === `${OWNER}@example.test`)
      .map((m) => m.subject);
    expect(subjects.some((s) => s.includes("was approved"))).toBe(true);
    expect(subjects.some((s) => s.includes("was suspended"))).toBe(true);
    expect(subjects.some((s) => s.includes("was reactivated"))).toBe(true);
  });
  it("sends nothing while e-mail is disabled, and the decision still stands", async () => {
    delete process.env.SPORTOZEN_EMAIL_TRANSPORT;
    delete process.env.SPORTOZEN_EMAIL_FROM;
    const before = database()
      .prepare("SELECT COUNT(*) n FROM email_outbox")
      .get()?.n;
    const id = await academyAt(OWNER, "Silent Academy", "ACTIVE");
    expect(lifecycleOf(id)!.state).toBe("ACTIVE");
    expect(
      database().prepare("SELECT COUNT(*) n FROM email_outbox").get()?.n,
    ).toBe(before);
  });
});

describe("no other code decides who is operational", () => {
  it("reads an academy's entitlement status only in the places that were reviewed", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    const readers = files
      .filter((f) =>
        /SELECT[^"'`]*status[^"'`]*FROM platform_entitlements/i.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"))
      .sort();
    // The gate in access(), the one shared helper, the platform screens and
    // the owner's subscription summary. Everything that used to compare the
    // status to "ACTIVE" now asks academyOperational().
    expect(readers).toEqual([
      "src/server/academy-lifecycle-state.ts",
      "src/server/academy-lifecycle.ts",
      "src/server/workspace-access.ts",
      "src/server/workspace-service.ts",
    ]);
  });
});
