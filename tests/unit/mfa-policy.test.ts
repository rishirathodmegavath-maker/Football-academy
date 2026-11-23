// WP6: who must use two-step verification (SPORTOZEN_MFA), enforced where access
// is decided, for Owner, Admin, Coach, Parent, Platform Administrator and
// Support. Better Auth is replaced by the API harness's test double; the real
// membership checks, policy and route handlers run.
import {
  afterAll,
  afterEach,
  beforeAll,
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
import { mfaPolicy, mfaRequiredFor } from "@/server/mfa-policy";
import * as accountsRoute from "@/app/api/platform/accounts/route";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as listRoute from "@/app/api/workspaces/route";
import {
  A,
  B,
  ids,
  callRoute,
  seedApiFixture,
  users,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-mfa-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const PLATFORM = "mfa-platform-admin",
  SUPPORT = "mfa-support-agent";
let platformUser: { twoFactorEnabled: boolean };
let supportUser: { twoFactorEnabled: boolean };
beforeAll(() => {
  seedApiFixture();
  platformUser = registerTestUser(PLATFORM, "Synthetic Platform Admin");
  supportUser = registerTestUser(SUPPORT, "Synthetic Support Agent");
  const db = database();
  for (const id of [PLATFORM, SUPPORT])
    db.prepare("INSERT INTO platform_administrators(userId) VALUES(?)").run(id);
  // A live support grant for one child, as the owner's grant would create.
  db.prepare(
    "INSERT INTO academy_memberships(id,academyId,userId,role,active,expiresAt) VALUES(?,?,?,?,1,?)",
  ).run(
    "m-support",
    A,
    SUPPORT,
    "SUPPORT",
    new Date(Date.now() + 3.6e6).toISOString(),
  );
  db.prepare(
    "INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)",
  ).run(A, SUPPORT, ids.p1);
});
afterEach(() => {
  delete process.env.SPORTOZEN_MFA;
  for (const user of Object.values(users)) user.twoFactorEnabled = false;
  platformUser.twoFactorEnabled = false;
  supportUser.twoFactorEnabled = false;
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const academy = (persona: Persona, id = A) =>
  callRoute(workspaceRoute.GET, {
    path: `/api/workspaces/${id}`,
    as: persona,
    params: { academyId: id },
  });
const asUser = (user: string, path: string, handler: unknown, params = {}) =>
  callRoute(handler, { path, headers: { "x-test-user": user }, params });
const platform = (user = PLATFORM) =>
  asUser(user, "/api/platform/accounts", accountsRoute.GET);
const support = () =>
  asUser(SUPPORT, `/api/workspaces/${A}/records/player`, recordsRoute.GET, {
    academyId: A,
    kind: "player",
  });
const body = (r: { body: unknown }) =>
  r.body as { error?: string; code?: string };

describe("policy values", () => {
  it("defaults to off and accepts only off, staff or all", () => {
    expect(mfaPolicy({})).toBe("off");
    expect(mfaPolicy({ SPORTOZEN_MFA: " Staff " })).toBe("staff");
    expect(() => mfaPolicy({ SPORTOZEN_MFA: "yes" })).toThrow(
      /off, staff or all/,
    );
    expect(mfaRequiredFor("OWNER", "off")).toBe(false);
    expect(mfaRequiredFor("PARENT", "staff")).toBe(false);
    expect(mfaRequiredFor("COACH", "staff")).toBe(true);
    expect(mfaRequiredFor("SUPPORT", "staff")).toBe(true);
    expect(mfaRequiredFor("PLATFORM", "staff")).toBe(true);
    expect(mfaRequiredFor("PARENT", "all")).toBe(true);
  });
});

describe("policy off (the default) changes nothing", () => {
  it("every role works without two-step verification", async () => {
    for (const persona of ["ownerA", "adminA", "coachA", "parent1"] as const)
      expect((await academy(persona)).status, persona).toBe(200);
    expect((await platform()).status).toBe(200);
    expect((await support()).status).toBe(200);
  });
});

describe("policy staff", () => {
  it("stops Owner, Admin, Coach, Platform Administrator and Support until they enrol, and never stops a Parent", async () => {
    process.env.SPORTOZEN_MFA = "staff";
    for (const persona of ["ownerA", "adminA", "coachA"] as const) {
      const res = await academy(persona);
      expect(res.status, persona).toBe(403);
      expect(body(res).code, persona).toBe("MFA_REQUIRED");
      expect(body(res).error).toMatch(/two-step verification/i);
    }
    const platformRes = await platform();
    expect(platformRes.status).toBe(403);
    expect(body(platformRes).code).toBe("MFA_REQUIRED");
    const supportRes = await support();
    expect(supportRes.status).toBe(403);
    expect(body(supportRes).code).toBe("MFA_REQUIRED");
    expect((await academy("parent1")).status).toBe(200);
  });
  it("lets each of them in once two-step verification is on", async () => {
    process.env.SPORTOZEN_MFA = "staff";
    for (const persona of ["ownerA", "adminA", "coachA"] as const) {
      users[persona].twoFactorEnabled = true;
      expect((await academy(persona)).status, persona).toBe(200);
    }
    platformUser.twoFactorEnabled = true;
    supportUser.twoFactorEnabled = true;
    expect((await platform()).status).toBe(200);
    expect((await support()).status).toBe(200);
  });
  it("does not weaken the academy boundary or reveal anything to an outsider", async () => {
    process.env.SPORTOZEN_MFA = "staff";
    users.ownerB.twoFactorEnabled = true;
    users.outsider.twoFactorEnabled = true;
    // A second-step owner of academy B still cannot read academy A, and an
    // outsider hears the membership refusal, not the policy.
    for (const persona of ["ownerB", "outsider"] as const) {
      const res = await academy(persona, A);
      expect(res.status, persona).toBe(403);
      expect(body(res).code, persona).toBeUndefined();
      expect(body(res).error).toMatch(/membership/i);
    }
    expect((await academy("ownerB", B)).status).toBe(200);
    // An outsider without it is not told about two-step verification either.
    users.outsider.twoFactorEnabled = false;
    const res = await academy("outsider", A);
    expect(body(res).code).toBeUndefined();
  });
  it("applies to creating an academy, because that makes the person an Owner", async () => {
    process.env.SPORTOZEN_MFA = "staff";
    const refused = await callRoute(listRoute.POST, {
      path: "/api/workspaces",
      method: "POST",
      as: "outsider",
      json: {},
    });
    expect(refused.status).toBe(403);
    expect(body(refused).code).toBe("MFA_REQUIRED");
    users.outsider.twoFactorEnabled = true;
    const reached = await callRoute(listRoute.POST, {
      path: "/api/workspaces",
      method: "POST",
      as: "outsider",
      json: {},
    });
    // Past the policy: now it is the (empty) request that is refused.
    expect(reached.status).toBe(400);
  });
  it("reports to the account screen whether the person needs it and has it", async () => {
    process.env.SPORTOZEN_MFA = "staff";
    const status = async (persona: Persona) =>
      (
        await callRoute(listRoute.GET, {
          path: "/api/workspaces",
          as: persona,
        })
      ).body as {
        account: { required: boolean; enabled: boolean; policy: string };
      };
    expect((await status("coachA")).account).toEqual({
      policy: "staff",
      required: true,
      enabled: false,
    });
    // Until it is set up, no academy details are listed at all.
    const listed = async (persona: Persona) =>
      (
        (
          await callRoute(listRoute.GET, {
            path: "/api/workspaces",
            as: persona,
          })
        ).body as { workspaces: unknown[] }
      ).workspaces.length;
    expect(await listed("coachA")).toBe(0);
    users.coachA.twoFactorEnabled = true;
    expect(await listed("coachA")).toBe(1);
    expect((await status("coachA")).account.enabled).toBe(true);
    expect((await status("parent1")).account.required).toBe(false);
  });
});

describe("policy all", () => {
  it("also stops a Parent until they enrol", async () => {
    process.env.SPORTOZEN_MFA = "all";
    const res = await academy("parent1");
    expect(res.status).toBe(403);
    expect(body(res).code).toBe("MFA_REQUIRED");
    users.parent1.twoFactorEnabled = true;
    expect((await academy("parent1")).status).toBe(200);
  });
});
