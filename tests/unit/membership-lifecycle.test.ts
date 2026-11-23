// WP5/WP6: invitations and memberships over their whole life — who can accept,
// what an expired or revoked earlier membership leaves behind, and that every
// refusal leaves the data unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { registerTestUser } from "./helpers/mock-auth";
import {
  invite,
  acceptInvitation,
  revokeMembership,
} from "@/server/membership-service";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { access } from "@/server/workspace-access";
import { A, B, ids, contextFor, seedApiFixture } from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-members-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const as = (user: string) => new Headers({ "x-test-user": user });
const person = (id: string) => registerTestUser(id, `Synthetic ${id}`);
const owner = () => contextFor("ownerA");
const membership = (userId: string) =>
  database()
    .prepare("SELECT * FROM academy_memberships WHERE academyId=? AND userId=?")
    .get(A, userId);

describe("accepting an invitation", () => {
  it("works once, for the invited account only, and links the named players", async () => {
    person("new-parent");
    person("someone-else");
    const { token } = invite(owner(), {
      email: "new-parent@example.test",
      role: "PARENT",
      playerIds: [ids.p1],
      guardianVerified: true,
    });
    await expect(
      acceptInvitation(as("someone-else"), token),
    ).rejects.toMatchObject({ status: 403 });
    expect(membership("someone-else")).toBeUndefined();
    await acceptInvitation(as("new-parent"), token);
    expect(repo.membership(A, "new-parent")?.role).toBe("PARENT");
    expect(
      database()
        .prepare(
          "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
        )
        .all(A, "new-parent")
        .map((r) => r.playerId),
    ).toEqual([ids.p1]);
    await expect(
      acceptInvitation(as("new-parent"), token),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("is refused when it has expired or the token is wrong", async () => {
    person("late-coach");
    const { token } = invite(owner(), {
      email: "late-coach@example.test",
      role: "COACH",
    });
    database()
      .prepare(
        "UPDATE workspace_invitations SET expiresAt='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await expect(
      acceptInvitation(as("late-coach"), token),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      acceptInvitation(as("late-coach"), "0".repeat(64)),
    ).rejects.toMatchObject({ status: 403 });
    expect(membership("late-coach")).toBeUndefined();
  });
  it("cannot create a role the inviter was not allowed to offer", () => {
    for (const role of ["OWNER", "SUPPORT"])
      expect(() =>
        invite(owner(), { email: "x@example.test", role } as never),
      ).toThrow();
  });
  it("requires a verified guardian link for a parent, and none for staff", () => {
    expect(() =>
      invite(owner(), {
        email: "p@example.test",
        role: "PARENT",
        playerIds: [ids.p1],
      }),
    ).toThrow(/verify/i);
    expect(() =>
      invite(owner(), {
        email: "p@example.test",
        role: "PARENT",
        guardianVerified: true,
      }),
    ).toThrow(/verify/i);
    expect(() =>
      invite(owner(), {
        email: "c@example.test",
        role: "COACH",
        playerIds: [ids.p1],
      }),
    ).toThrow(/cannot create guardian/i);
    expect(() =>
      invite(owner(), {
        email: "p@example.test",
        role: "PARENT",
        playerIds: [ids.bPlayer],
        guardianVerified: true,
      }),
    ).toThrow();
  });
});

describe("a person who held an earlier membership", () => {
  it("gets a usable membership when invited again after revocation", async () => {
    person("returning-coach");
    const first = invite(owner(), {
      email: "returning-coach@example.test",
      role: "COACH",
    });
    await acceptInvitation(as("returning-coach"), first.token);
    revokeMembership(owner(), String(membership("returning-coach")!.id));
    expect(repo.membership(A, "returning-coach")).toBeUndefined();
    const again = invite(owner(), {
      email: "returning-coach@example.test",
      role: "COACH",
    });
    await acceptInvitation(as("returning-coach"), again.token);
    await expect(access(as("returning-coach"), A)).resolves.toMatchObject({
      membership: { role: "COACH" },
    });
  });
  it("is not left with an old expiry or sport restriction from a lapsed Support grant", async () => {
    person("former-support");
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,active,sportIds,expiresAt) VALUES(?,?,?,?,1,?,?)",
      )
      .run(
        randomUUID(),
        A,
        "former-support",
        "SUPPORT",
        '["cricket"]',
        "2000-01-01T00:00:00.000Z",
      );
    expect(repo.membership(A, "former-support")).toBeUndefined();
    const { token } = invite(owner(), {
      email: "former-support@example.test",
      role: "COACH",
    });
    await acceptInvitation(as("former-support"), token);
    const row = membership("former-support")!;
    expect(row.role).toBe("COACH");
    expect(row.expiresAt).toBeNull();
    expect(JSON.parse(String(row.sportIds))).toEqual([]);
    await expect(access(as("former-support"), A)).resolves.toMatchObject({
      membership: { role: "COACH" },
    });
  });
});

describe("revoking a membership", () => {
  it("is limited to this academy's owner and admins, and never touches the owner", () => {
    const ownerRow = String(membership(ids.ownerA)!.id),
      coachRow = String(membership(ids.coachA)!.id);
    expect(() => revokeMembership(contextFor("coachA"), coachRow)).toThrow(
      /role cannot perform/,
    );
    expect(() => revokeMembership(contextFor("parent1"), coachRow)).toThrow(
      /role cannot perform/,
    );
    expect(() => revokeMembership(contextFor("adminA"), ownerRow)).toThrow(
      /Owner transfer/,
    );
    expect(repo.membership(A, ids.ownerA)).toBeDefined();
  });
  it("cannot reach a membership in another academy", () => {
    const otherAcademy = String(
      database()
        .prepare(
          "SELECT id FROM academy_memberships WHERE academyId=? AND userId=?",
        )
        .get(B, ids.ownerB)!.id,
    );
    expect(() => revokeMembership(owner(), otherAcademy)).toThrow(/not found/i);
    expect(repo.membership(B, ids.ownerB)).toBeDefined();
  });
});
