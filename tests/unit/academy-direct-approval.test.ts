// The deployment setting SPORTOZEN_ACADEMY_APPROVAL. Unset, or any value other
// than "direct", keeps the platform administrator's review (the workflow tested
// in academy-approval.test.ts). "direct" approves a new academy when it is
// created, in the same transaction, and leaves a history row saying so.
// docs/ACADEMY_APPROVAL.md
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { callRoute, seedApiFixture } from "./helpers/api-harness";
import {
  academyOperational,
  lifecycleOf,
} from "@/server/academy-lifecycle-state";
import { academyApprovalMode } from "@/server/academy-lifecycle";
import { checkDataIntegrity } from "@/server/data-integrity";
import * as workspacesRoute from "@/app/api/workspaces/route";
import * as queueRoute from "@/app/api/platform/applications/route";
import * as decisionRoute from "@/app/api/platform/applications/[academyId]/decision/route";

const filename = join(tmpdir(), `sportozen-direct-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const ADMIN = "platform-admin",
  OWNER = "direct-owner";
const as = (user: string) => ({ headers: { "x-test-user": user } });

beforeAll(() => {
  database().exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT)',
  );
  seedApiFixture();
  for (const [id, name] of [
    [ADMIN, "Platform Admin"],
    [OWNER, "Direct Owner"],
  ] as const) {
    registerTestUser(id, name);
    database()
      .prepare('INSERT OR REPLACE INTO "user"(id,name,email) VALUES(?,?,?)')
      .run(id, name, `${id}@example.test`);
  }
  database()
    .prepare("INSERT INTO platform_administrators(userId) VALUES(?)")
    .run(ADMIN);
});
beforeEach(() => {
  database().exec("DELETE FROM request_rate_limits");
});
afterEach(() => {
  delete process.env.SPORTOZEN_ACADEMY_APPROVAL;
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const body = (name: string) => ({
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
async function create(name: string) {
  const res = await callRoute(workspacesRoute.POST, {
    path: "/api/workspaces",
    method: "POST",
    json: body(name),
    ...as(OWNER),
  });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}
const history = (academyId: string) =>
  database()
    .prepare(
      "SELECT action,fromState,toState,actorKind FROM academy_lifecycle_history WHERE academyId=? ORDER BY id",
    )
    .all(academyId)
    .map((r) => ({ ...r }));

describe("academy approval mode", () => {
  it.each(["required", "REQUIRED", "  required  "])(
    "keeps the platform review only when the setting is %j",
    async (value) => {
    process.env.SPORTOZEN_ACADEMY_APPROVAL = value;
    expect(academyApprovalMode()).toBe("required");
    const id = await create("Review Required Academy");
    expect(lifecycleOf(id)?.state).toBe("CONFIGURING");
    expect(academyOperational(id)).toBe(false);
    expect(history(id).map((h) => h.action)).toEqual(["REGISTERED"]);
    },
  );

  it.each([undefined, "", "direct", "DIRECT", "  direct  ", "off", "true", "dirct"])(
    "approves a new academy at creation by default (setting %j)",
    async (value) => {
      if (value === undefined) delete process.env.SPORTOZEN_ACADEMY_APPROVAL;
      else process.env.SPORTOZEN_ACADEMY_APPROVAL = value;
      expect(academyApprovalMode()).toBe("direct");
      const id = await create("Default Direct Academy");
      expect(lifecycleOf(id)?.state).toBe("ACTIVE");
      expect(academyOperational(id)).toBe(true);
    },
  );

  it.each(["direct", "DIRECT", "  direct  "])(
    "approves a new academy at creation when the setting is %j",
    async (value) => {
      process.env.SPORTOZEN_ACADEMY_APPROVAL = value;
      expect(academyApprovalMode()).toBe("direct");
      const id = await create("Direct Academy");
      expect(lifecycleOf(id)?.state).toBe("ACTIVE");
      expect(academyOperational(id)).toBe(true);
      expect(history(id)).toEqual([
        {
          action: "REGISTERED",
          fromState: null,
          toState: "CONFIGURING",
          actorKind: "OWNER",
        },
        {
          action: "APPROVED",
          fromState: "CONFIGURING",
          toState: "ACTIVE",
          actorKind: "SYSTEM",
        },
      ]);
    },
  );

  it("shows a directly approved academy as active and not waiting for review", async () => {
    process.env.SPORTOZEN_ACADEMY_APPROVAL = "direct";
    const id = await create("Not Queued Academy");
    const res = await callRoute(queueRoute.GET, {
      path: "/api/platform/applications",
      ...as(ADMIN),
    });
    expect(res.status).toBe(200);
    const queue = res.body as {
      applications: { id: string; state: string }[];
      waiting: number;
    };
    expect(queue.applications.find((a) => a.id === id)?.state).toBe("ACTIVE");
    expect(queue.waiting).toBe(0);
  });

  it("leaves its entitlement and the data checks consistent", async () => {
    process.env.SPORTOZEN_ACADEMY_APPROVAL = "direct";
    const id = await create("Consistent Academy");
    const entitlement = database()
      .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
      .get(id) as { status: string };
    expect(entitlement.status).toBe("ACTIVE");
    const findings = JSON.stringify(checkDataIntegrity(database()));
    expect(findings).not.toContain(id);
  });

  it("still lets a platform administrator suspend and reactivate it", async () => {
    process.env.SPORTOZEN_ACADEMY_APPROVAL = "direct";
    const id = await create("Suspendable Academy");
    const decide = (decision: string, reason?: string) =>
      callRoute(decisionRoute.POST, {
        path: `/api/platform/applications/${id}/decision`,
        method: "POST",
        params: { academyId: id },
        json: { decision, reason, expectedVersion: lifecycleOf(id)!.version },
        ...as(ADMIN),
      });
    const suspended = await decide(
      "suspend",
      "Suspended for the test of direct approval.",
    );
    expect(suspended.status).toBe(200);
    expect(academyOperational(id)).toBe(false);
    expect((await decide("reactivate")).status).toBe(200);
    expect(academyOperational(id)).toBe(true);
  });

  it("changes only academies created afterwards", async () => {
    process.env.SPORTOZEN_ACADEMY_APPROVAL = "required";
    const waiting = await create("Created Before");
    process.env.SPORTOZEN_ACADEMY_APPROVAL = "direct";
    const direct = await create("Created After");
    expect(lifecycleOf(waiting)?.state).toBe("CONFIGURING");
    expect(lifecycleOf(direct)?.state).toBe("ACTIVE");
  });
});
