import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({
  WorkspaceError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authenticatedUser: vi.fn(),
}));
import { authenticatedUser } from "@/server/auth";
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { acceptInvitation, invite } from "@/server/workspace-service";
import {
  confirmInvitationEmail,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from "@/server/membership-service";
import type { AcademyConfiguration } from "@/domain/workspace";
import type { WorkspaceAccess } from "@/server/workspace-access";
import { activateAcademy } from "./helpers/lifecycle";

const filename = join(tmpdir(), "sportozen-links-" + randomUUID() + ".sqlite");
process.env.SPORTOZEN_DATABASE_PATH = filename;
let academy: AcademyConfiguration, owner: WorkspaceAccess;

function seed() {
  const id = randomUUID();
  academy = {
    id,
    academyId: id,
    name: "Link Test Academy",
    contactEmail: "academy@example.test",
    country: "IN",
    language: "English",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    sportIds: ["football"],
    ageGroups: ["U12"],
    reviewFrequency: "Monthly",
    modules: ["development", "reports", "communication", "fees"],
    nutritionOptional: true,
    demo: true,
    onboardingStatus: "ACTIVE",
  };
  const db = database();
  // The sign-in account table normally comes from the authentication service.
  db.exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER)',
  );
  db.exec('DELETE FROM "user"');
  db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(
    id,
    JSON.stringify(academy),
  );
  db.prepare(
    "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)",
  ).run(id, "TEST", JSON.stringify(academy.modules), "ACTIVE");
  activateAcademy(db, id);
  db.prepare(
    "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
  ).run("owner-" + id, id, "owner-" + id, "OWNER", '["football"]');
  owner = {
    academy,
    membership: {
      id: "owner-" + id,
      userId: "owner-" + id,
      academyId: id,
      role: "OWNER",
      active: true,
      sportIds: ["football"],
    },
    user: {
      id: "owner-" + id,
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: null,
    },
  };
  for (const [playerId, name] of [
    ["asha", "Asha Rao"],
    ["dev", "Dev Rao"],
  ])
    repo.save(id, "player", {
      id: playerId,
      academyId: id,
      name,
      coachId: owner.user.id,
      sportIds: ["football"],
      squad: "",
      squadId: "",
      ageCategory: "U12",
      birthDate: "",
      position: "",
      status: "ACTIVE",
    });
}
const account = (id: string, email: string, verified = false) => {
  database()
    .prepare(
      'INSERT OR REPLACE INTO "user"(id,email,emailVerified) VALUES(?,?,?)',
    )
    .run(id, email, verified ? 1 : 0);
  return { id, email, emailVerified: verified } as Awaited<
    ReturnType<typeof authenticatedUser>
  >;
};
const verified = (id: string) =>
  Boolean(
    (
      database()
        .prepare('SELECT emailVerified FROM "user" WHERE id=?')
        .get(id) as { emailVerified: number }
    ).emailVerified,
  );
const link = (role: string, email: string, playerIds: string[] = []) =>
  invite(owner, { email, role, playerIds, guardianVerified: role !== "COACH" });

afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

describe("invitation links", () => {
  beforeEach(seed);

  it("shows the academy, the role and the invited address for a usable link", () => {
    const { token } = link("COACH", "Coach@Example.test");
    expect(previewInvitation(token)).toMatchObject({
      state: "OPEN",
      academyId: academy.id,
      academyName: "Link Test Academy",
      role: "COACH",
      email: "coach@example.test",
      playerNames: [],
      accountExists: false,
    });
  });

  it("names the linked children for a parent and says whether an account already exists", () => {
    account("existing-parent", "parent@example.test");
    const { token } = link("PARENT", "parent@example.test", ["asha", "dev"]);
    expect(previewInvitation(token)).toMatchObject({
      state: "OPEN",
      role: "PARENT",
      playerNames: ["Asha Rao", "Dev Rao"],
      accountExists: true,
    });
  });

  it("refuses to describe a link that is wrong, used, renewed or cancelled", async () => {
    expect(previewInvitation("not-a-token")).toEqual({ state: "INVALID" });
    expect(previewInvitation("0".repeat(64))).toEqual({ state: "INVALID" });
    const first = link("COACH", "coach@example.test");
    const renewed = resendInvitation(
      owner,
      database()
        .prepare("SELECT id FROM workspace_invitations WHERE academyId=?")
        .get(academy.id)!.id as string,
    );
    expect(previewInvitation(first.token)).toEqual({ state: "INVALID" });
    expect(previewInvitation(renewed.token).state).toBe("OPEN");
    vi.mocked(authenticatedUser).mockResolvedValue(
      account("coach-1", "coach@example.test"),
    );
    await acceptInvitation(new Headers(), renewed.token);
    expect(previewInvitation(renewed.token)).toEqual({ state: "USED" });
    const other = link("COACH", "other@example.test");
    const id = listInvitations(owner).invitations.find(
      (item) => item.email === "other@example.test",
    )!.id;
    revokeInvitation(owner, id);
    expect(previewInvitation(other.token)).toEqual({ state: "EXPIRED" });
  });

  it("confirms the invited address when the link is opened, and only that address", () => {
    const mine = account("u1", "coach@example.test");
    const stranger = account("u2", "stranger@example.test");
    const { token } = link("COACH", "coach@example.test");
    expect(confirmInvitationEmail(token)).toEqual({ confirmed: true });
    expect(verified(mine.id)).toBe(true);
    expect(verified(stranger.id)).toBe(false);
    expect(confirmInvitationEmail(token)).toEqual({ confirmed: false });
    expect(confirmInvitationEmail("1".repeat(64))).toEqual({
      confirmed: false,
    });
  });

  it("joining still needs a confirmed address, which opening the link just confirmed", async () => {
    const person = account("u3", "coach@example.test");
    const { token } = link("COACH", "coach@example.test");
    expect(confirmInvitationEmail(token)).toEqual({ confirmed: true });
    vi.mocked(authenticatedUser).mockResolvedValue({
      ...person,
      emailVerified: true,
    });
    await expect(acceptInvitation(new Headers(), token)).resolves.toEqual({
      academyId: academy.id,
    });
    expect(repo.membership(academy.id, person.id)?.role).toBe("COACH");
  });

  it("does not let a different account use someone else's link", async () => {
    const { token } = link("COACH", "coach@example.test");
    vi.mocked(authenticatedUser).mockResolvedValue(
      account("u4", "someone-else@example.test"),
    );
    await expect(acceptInvitation(new Headers(), token)).rejects.toMatchObject({
      status: 403,
    });
    expect(verified("u4")).toBe(false);
  });
});

describe("the WhatsApp number given when joining", () => {
  beforeEach(seed);
  const phoneOf = (userId: string) =>
    (
      database()
        .prepare("SELECT phone FROM member_phones WHERE academyId=? AND userId=?")
        .get(academy.id, userId) as { phone: string } | undefined
    )?.phone;
  const joinAs = (id: string, email: string) =>
    vi.mocked(authenticatedUser).mockResolvedValue(account(id, email, true));

  it("is saved with the membership, read in the academy's country", async () => {
    const { token } = link("PARENT", "mum@example.test", ["asha"]);
    joinAs("mum-phone", "mum@example.test");
    await acceptInvitation(new Headers(), token, "98765 43210");
    expect(phoneOf("mum-phone")).toBe("919876543210");
    expect(repo.membership(academy.id, "mum-phone")?.role).toBe("PARENT");
  });

  it("an unreadable number joins nobody and leaves the link usable", async () => {
    const { token } = link("PARENT", "dad@example.test", ["dev"]);
    joinAs("dad-phone", "dad@example.test");
    await expect(
      acceptInvitation(new Headers(), token, "12"),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.membership(academy.id, "dad-phone")).toBeUndefined();
    expect(phoneOf("dad-phone")).toBeUndefined();
    await acceptInvitation(new Headers(), token, "+44 7700 900123");
    expect(phoneOf("dad-phone")).toBe("447700900123");
  });

  it("joining without a number saves none", async () => {
    const { token } = link("COACH", "coach2@example.test");
    joinAs("coach-phone", "coach2@example.test");
    await acceptInvitation(new Headers(), token);
    expect(phoneOf("coach-phone")).toBeUndefined();
  });
});

describe("players are under 18 and do not sign in", () => {
  beforeEach(seed);

  it("refuses a player login invitation and creates nothing", () => {
    expect(() =>
      invite(owner, {
        email: "asha@example.test",
        role: "PLAYER",
        playerIds: ["asha"],
        guardianVerified: true,
      }),
    ).toThrow(/Coach or Parent/);
    expect(
      database()
        .prepare(
          "SELECT COUNT(*) n FROM workspace_invitations WHERE academyId=?",
        )
        .get(academy.id),
    ).toMatchObject({ n: 0 });
  });

  it("still invites a parent for their child, who sees that child only", async () => {
    const { token } = link("PARENT", "mum@example.test", ["asha"]);
    vi.mocked(authenticatedUser).mockResolvedValue(
      account("mum", "mum@example.test", true),
    );
    await acceptInvitation(new Headers(), token);
    const rows = database()
      .prepare(
        "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
      )
      .all(academy.id, "mum")
      .map((row) => String(row.playerId));
    expect(rows).toEqual(["asha"]);
    expect(
      database()
        .prepare("SELECT COUNT(*) n FROM player_self_login WHERE academyId=?")
        .get(academy.id),
    ).toMatchObject({ n: 0 });
  });
});
