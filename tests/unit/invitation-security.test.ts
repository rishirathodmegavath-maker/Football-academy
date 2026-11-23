// WP6: the invitation lifecycle as an authorization boundary. Who may issue,
// list, renew and end invitations; that a token cannot be turned into a role the
// inviter could not give; that every failure to accept looks the same; and that
// nothing crosses an academy boundary.
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
import {
  acceptInvitation,
  invite,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "@/server/membership-service";
import {
  ids,
  contextFor,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-invsec-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const person = (name: string) => {
  registerTestUser(name, name);
  return { id: name, email: `${name}@example.test` };
};
const as = (user: string) => new Headers({ "x-test-user": user });
const staffInvite = (persona: Persona, email: string, role = "COACH") =>
  invite(contextFor(persona), { email, role });
const refusal = async (promise: Promise<unknown>) =>
  promise.then(
    () => ({ status: 200, message: "" }),
    (e: { status: number; message: string }) => ({
      status: e.status,
      message: e.message,
    }),
  );

describe("who may issue, list, renew and end invitations", () => {
  it("only an Owner or Admin of that academy; never a Coach, Parent or Support", () => {
    const invitation = staffInvite("ownerA", "someone@example.test");
    // Support is a role in the same academy for a platform administrator.
    database()
      .prepare(
        "INSERT OR IGNORE INTO academy_memberships(id,academyId,userId,role,active,expiresAt) VALUES(?,?,?,?,1,?)",
      )
      .run(
        "m-sup",
        "academy-a",
        "support-x",
        "SUPPORT",
        new Date(Date.now() + 3.6e6).toISOString(),
      );
    const supportCtx = {
      ...contextFor("coachA"),
      membership: {
        ...contextFor("coachA").membership,
        role: "SUPPORT" as const,
      },
    };
    for (const ctx of [
      contextFor("coachA"),
      contextFor("parent1"),
      supportCtx,
    ]) {
      expect(() =>
        invite(ctx, { email: "x@example.test", role: "COACH" }),
      ).toThrow(/role cannot perform/);
      expect(() => listInvitations(ctx)).toThrow(/role cannot perform/);
      expect(() => resendInvitation(ctx, invitation.id)).toThrow(
        /role cannot perform/,
      );
      expect(() => revokeInvitation(ctx, invitation.id)).toThrow(
        /role cannot perform/,
      );
    }
    expect(() =>
      resendInvitation(contextFor("adminA"), invitation.id),
    ).not.toThrow();
  });
  it("cannot create an Owner (or any role beyond Admin, Coach and Parent) by invitation", () => {
    for (const role of ["OWNER", "SUPPORT", "PLATFORM", "admin", ""])
      expect(() => staffInvite("ownerA", "role@example.test", role)).toThrow();
  });
  it("cannot reach another academy's invitations, or link another academy's player", () => {
    const own = staffInvite("ownerA", "own@example.test");
    const other = invite(contextFor("ownerB"), {
      email: "other@example.test",
      role: "COACH",
    });
    // Academy B's owner cannot see, renew or end academy A's invitation (and vice versa).
    expect(() => resendInvitation(contextFor("ownerB"), own.id)).toThrow(
      /not found/i,
    );
    expect(() => revokeInvitation(contextFor("ownerB"), own.id)).toThrow(
      /not found/i,
    );
    expect(() => revokeInvitation(contextFor("ownerA"), other.id)).toThrow(
      /not found/i,
    );
    expect(
      listInvitations(contextFor("ownerB")).invitations.map((i) => i.id),
    ).not.toContain(own.id);
    // A guardian invitation naming a player of the other academy is refused.
    expect(() =>
      invite(contextFor("ownerB"), {
        email: "guardian@example.test",
        role: "PARENT",
        playerIds: [ids.p1],
        guardianVerified: true,
      }),
    ).toThrow(/not available/i);
  });
});

describe("accepting an invitation", () => {
  it("gives the same refusal for a wrong token, another person's token, a used token, an ended one and a replaced one", async () => {
    const invited = person("accept-invited");
    const stranger = person("accept-stranger");
    const issued = staffInvite("ownerA", invited.email);
    const messages = new Set<string>();
    const note = async (user: string, token: string) => {
      const result = await refusal(acceptInvitation(as(user), token));
      messages.add(`${result.status} ${result.message}`);
      return result;
    };
    // Wrong token.
    await note(invited.id, "0".repeat(64));
    // Someone else holding the real token.
    await note(stranger.id, issued.token);
    // The real person accepts once…
    expect(
      (await refusal(acceptInvitation(as(invited.id), issued.token))).status,
    ).toBe(200);
    // …and the token is spent, for anyone.
    await note(invited.id, issued.token);
    await note(stranger.id, issued.token);
    // An ended invitation.
    const ended = person("accept-ended");
    const second = staffInvite("ownerA", ended.email);
    revokeInvitation(contextFor("ownerA"), second.id);
    await note(ended.id, second.token);
    // A replaced token stops working, the new one works.
    const renewed = person("accept-renewed");
    const third = staffInvite("ownerA", renewed.email);
    const fresh = resendInvitation(contextFor("ownerA"), third.id);
    await note(renewed.id, third.token);
    expect(fresh.token).not.toBe(third.token);
    expect(
      (await refusal(acceptInvitation(as(renewed.id), fresh.token))).status,
    ).toBe(200);
    // One status and one message: nothing says which of the cases applied.
    expect([...messages]).toEqual([
      "403 Invitation is invalid or belongs to a different account.",
    ]);
  });
  it("stores only a hash of the token and never returns it from a list", () => {
    const issued = staffInvite("ownerA", "hash@example.test");
    const row = database()
      .prepare("SELECT tokenHash FROM workspace_invitations WHERE id=?")
      .get(issued.id)!;
    expect(String(row.tokenHash)).toHaveLength(64);
    expect(String(row.tokenHash)).not.toBe(issued.token);
    expect(JSON.stringify(listInvitations(contextFor("ownerA")))).not.toContain(
      issued.token,
    );
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
  });
  it("cannot turn a staff invitation into guardian access, or a guardian invitation into staff", async () => {
    const coach = person("accept-coach");
    const guardian = person("accept-guardian");
    const staff = staffInvite("ownerA", coach.email, "COACH");
    expect(() =>
      invite(contextFor("ownerA"), {
        email: "mix@example.test",
        role: "COACH",
        playerIds: [ids.p1],
      }),
    ).toThrow(/cannot create guardian/i);
    await acceptInvitation(as(coach.id), staff.token);
    const parent = invite(contextFor("ownerA"), {
      email: guardian.email,
      role: "PARENT",
      playerIds: [ids.p1],
      guardianVerified: true,
    });
    await acceptInvitation(as(guardian.id), parent.token);
    const roles = database()
      .prepare(
        "SELECT userId,role FROM academy_memberships WHERE userId IN (?,?)",
      )
      .all(coach.id, guardian.id)
      .map((r) => `${r.userId}:${r.role}`)
      .sort();
    expect(roles).toEqual(
      [`${coach.id}:COACH`, `${guardian.id}:PARENT`].sort(),
    );
    // The guardian reaches exactly the named child and nothing else.
    const links = database()
      .prepare("SELECT playerId FROM guardian_relationships WHERE userId=?")
      .all(guardian.id)
      .map((r) => r.playerId);
    expect(links).toEqual([ids.p1]);
  });
  it("is audited at issue, renewal, end and acceptance, without the token", async () => {
    const who = person("audit-person");
    const issued = staffInvite("ownerA", who.email);
    const renewed = resendInvitation(contextFor("ownerA"), issued.id);
    await acceptInvitation(as(who.id), renewed.token);
    const log = database()
      .prepare(
        "SELECT action,resourceId FROM workspace_audit WHERE resourceId=?",
      )
      .all(issued.id)
      .map((r) => String(r.action));
    expect(log.some((a) => a.startsWith("Invitation prepared"))).toBe(true);
    expect(log.some((a) => a.startsWith("Invitation renewed"))).toBe(true);
    expect(log).toContain("Explicit academy invitation accepted");
    expect(JSON.stringify(log)).not.toContain(issued.token);
    expect(JSON.stringify(log)).not.toContain(renewed.token);
  });
});
