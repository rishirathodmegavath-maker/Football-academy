import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      public headers: Record<string, string> = {},
      public code?: string,
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
import {
  createPlayerLink,
  decideSelfPlayer,
  listSelfPlayers,
  selfPlayerStatus,
  submitSelfPlayer,
  viewerOf,
} from "@/server/player-link-service";
import { financeView } from "@/server/finance-service";
import { previewMessage } from "@/server/messaging-service";
import { reply, saveRecord } from "@/server/workspace-service";
import type { AcademyConfiguration } from "@/domain/workspace";
import type { WorkspaceAccess } from "@/server/workspace-access";
import { activateAcademy } from "./helpers/lifecycle";

// "Add player with invitation link": one link, any email, one use; the player fills in their own details; the academy confirms them.
const filename = join(tmpdir(), "sportozen-player-links-" + randomUUID() + ".sqlite");
process.env.SPORTOZEN_DATABASE_PATH = filename;
// Player links are off unless the operator switches them on (see the switch tests below); these tests run with it on.
process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";
let academy: AcademyConfiguration, owner: WorkspaceAccess;

const ctxFor = (role: "OWNER" | "COACH" | "PARENT", userId: string): WorkspaceAccess => ({
  academy,
  membership: {
    id: "m-" + userId,
    userId,
    academyId: academy.id,
    role,
    active: true,
    sportIds: ["football"],
  },
  user: {
    id: userId,
    name: userId,
    email: userId + "@example.test",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    image: null,
  },
});
function seed() {
  const id = randomUUID();
  academy = {
    id,
    academyId: id,
    name: "Player Link Academy",
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
    modules: ["development", "reports", "communication", "fees", "update"],
    nutritionOptional: true,
    demo: true,
    onboardingStatus: "ACTIVE",
  };
  const db = database();
  db.exec('CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER,name TEXT)');
  db.exec('DELETE FROM "user"');
  db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(id, JSON.stringify(academy));
  db.prepare("INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)").run(
    id,
    "TEST",
    JSON.stringify(academy.modules),
    "ACTIVE",
  );
  activateAcademy(db, id);
  for (const [userId, role] of [
    ["owner", "OWNER"],
    ["coach", "COACH"],
    ["mum", "PARENT"],
  ])
    db.prepare("INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)").run(
      id + "-" + userId,
      id,
      userId,
      role,
      '["football"]',
    );
  for (const userId of ["owner", "coach", "mum"]) account(userId, userId + "@example.test");
  owner = ctxFor("OWNER", "owner");
  repo.save(id, "player", {
    id: "asha",
    academyId: id,
    name: "Asha Rao",
    coachId: "owner",
    sportIds: ["football"],
    squad: "",
    squadId: "",
    ageCategory: "U12",
    birthDate: "2016-04-04",
    position: "",
    status: "ACTIVE",
  });
  db.prepare("INSERT INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)").run(id, "mum", "asha");
}
const account = (id: string, email: string, verified = true) => {
  database()
    .prepare('INSERT OR REPLACE INTO "user"(id,email,emailVerified,name) VALUES(?,?,?,?)')
    .run(id, email, verified ? 1 : 0, id);
  return { id, email, emailVerified: verified } as Awaited<ReturnType<typeof authenticatedUser>>;
};
const openLink = async (token: string, userId: string, email: string) => {
  vi.mocked(authenticatedUser).mockResolvedValue(account(userId, email));
  return acceptInvitation(new Headers(), token);
};
const status = async (fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    // The API answers invalid input (a ZodError) with 400, as apiError in src/server/http.ts does.
    if ((error as { name?: string }).name === "ZodError") return 400;
    return (error as { status?: number }).status ?? 500;
  }
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: academy.timezone }).format(new Date());
const years = (n: number) => `${Number(today().slice(0, 4)) - n}${today().slice(4)}`;
const players = () => repo.list(academy.id, "player");
const pending = (userId: string) =>
  database().prepare("SELECT COUNT(*) n FROM player_self_pending WHERE academyId=? AND userId=?").get(academy.id, userId);
const good = { name: "Kiran Kumar", birthDate: "2014-03-03", position: "Midfield", guardianAware: true };

afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
});
beforeEach(seed);

describe("making the link", () => {
  it("is for the owner and admin only", async () => {
    expect(createPlayerLink(owner, {}).token).toMatch(/^[0-9a-f]{64}$/);
    expect(await status(() => createPlayerLink(ctxFor("COACH", "coach"), {}))).toBe(403);
    expect(await status(() => createPlayerLink(ctxFor("PARENT", "mum"), {}))).toBe(403);
  });

  it("names a real staff member, never a parent or a stranger", async () => {
    expect(createPlayerLink(owner, { coachId: "coach" }).id).toBeTruthy();
    expect(await status(() => createPlayerLink(owner, { coachId: "mum" }))).toBe(400);
    expect(await status(() => createPlayerLink(owner, { coachId: "nobody" }))).toBe(400);
  });

  it("stores only the fingerprint, sends nothing, and shows as a player link that is not tied to an address", () => {
    const { token, id } = createPlayerLink(owner, {});
    const row = database().prepare("SELECT * FROM workspace_invitations WHERE id=?").get(id) as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.email).not.toContain("@");
    expect(database().prepare("SELECT COUNT(*) n FROM email_outbox").get()).toMatchObject({ n: 0 });
    const listed = listInvitations(owner).invitations[0];
    expect(listed).toMatchObject({ role: "PLAYER", open: true, email: "", state: "PENDING" });
  });

  it("does not remove the email invitations: a coach and a parent are still invited by address", () => {
    expect(invite(owner, { email: "c2@example.test", role: "COACH", playerIds: [], guardianVerified: false }).token).toBeTruthy();
    expect(
      invite(owner, { email: "p2@example.test", role: "PARENT", playerIds: ["asha"], guardianVerified: true }).token,
    ).toBeTruthy();
  });

  it("an invitation by address still cannot be made for the Player role", () => {
    expect(() =>
      invite(owner, { email: "x@example.test", role: "PLAYER", playerIds: ["asha"], guardianVerified: true }),
    ).toThrow(/Coach or Parent/);
  });
});

describe("using the link", () => {
  it("works for any email address, and the account has no player until they fill in their details", async () => {
    const { token } = createPlayerLink(owner, {});
    expect(previewInvitation(token)).toMatchObject({ state: "OPEN", open: true, email: "", accountExists: false });
    await openLink(token, "kid", "whatever.address@example.test");
    expect(repo.membership(academy.id, "kid")).toMatchObject({ role: "PARENT", active: true });
    expect(pending("kid")).toMatchObject({ n: 1 });
    expect(selfPlayerStatus(ctxFor("PARENT", "kid"))).toEqual({ state: "details", playerLogin: false });
    expect(players()).toHaveLength(1);
    expect(database().prepare("SELECT COUNT(*) n FROM guardian_relationships WHERE userId='kid'").get()).toMatchObject({ n: 0 });
  });

  it("works exactly once, for anyone", async () => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    expect(await status(() => openLink(token, "other", "other@example.test"))).toBe(403);
    expect(await status(() => openLink(token, "kid", "kid@example.test"))).toBe(403);
    expect(previewInvitation(token)).toEqual({ state: "USED" });
    expect(repo.membership(academy.id, "other")).toBeUndefined();
  });

  // "Cannot be claimed twice at the same moment" is tested with real processes in tests/unit/player-link-race.test.ts:
  // one JavaScript process cannot interleave two synchronous claims, so a test here could not prove it.

  it("is refused after it expires or is cancelled, and a renewed link replaces the old one", async () => {
    const a = createPlayerLink(owner, {});
    revokeInvitation(owner, a.id);
    expect(await status(() => openLink(a.token, "k1", "k1@example.test"))).toBe(403);
    const b = createPlayerLink(owner, {});
    const renewed = resendInvitation(owner, b.id);
    expect(renewed.status).toBe("NOT_SENT");
    expect(await status(() => openLink(b.token, "k2", "k2@example.test"))).toBe(403);
    await openLink(renewed.token, "k2", "k2@example.test");
    expect(repo.membership(academy.id, "k2")).toBeTruthy();
    const c = createPlayerLink(owner, {});
    database().prepare("UPDATE workspace_invitations SET expiresAt=? WHERE id=?").run("2000-01-01T00:00:00.000Z", c.id);
    expect(await status(() => openLink(c.token, "k3", "k3@example.test"))).toBe(403);
  });

  it("is refused to someone who already belongs to the academy: staff, a parent, or another player", async () => {
    const { token } = createPlayerLink(owner, {});
    expect(await status(() => openLink(token, "coach", "coach@example.test"))).toBe(409);
    expect(await status(() => openLink(token, "mum", "mum@example.test"))).toBe(409);
    expect(await status(() => openLink(token, "owner", "owner@example.test"))).toBe(409);
    expect(pending("mum")).toMatchObject({ n: 0 });
    // None of those attempts used the link up.
    await openLink(token, "kid", "kid@example.test");
    expect(repo.membership(academy.id, "kid")).toBeTruthy();
  });

  it("never confirms anyone's address (it proves nothing about an address)", async () => {
    const { token } = createPlayerLink(owner, {});
    account("someone", "someone@example.test", false);
    expect(confirmInvitationEmail(token)).toEqual({ confirmed: false });
    expect(database().prepare('SELECT emailVerified FROM "user" WHERE id=?').get("someone")).toMatchObject({ emailVerified: 0 });
  });
});

describe("filling in their own details: nothing exists until the academy confirms", () => {
  const joined = async (coachId?: string) => {
    const { token } = createPlayerLink(owner, coachId ? { coachId } : {});
    await openLink(token, "kid", "kid@example.test");
    return ctxFor("PARENT", "kid");
  };
  const waiting = () =>
    database().prepare("SELECT COUNT(*) n FROM player_self_submission WHERE academyId=? AND userId='kid'").get(academy.id);

  it("sends the details to wait: no player record, no links, and the account still sees no player", async () => {
    const kid = await joined("coach");
    expect(submitSelfPlayer(kid, good)).toEqual({ state: "waiting" });
    expect(players()).toHaveLength(1);
    expect(database().prepare("SELECT COUNT(*) n FROM guardian_relationships WHERE userId='kid'").get()).toMatchObject({ n: 0 });
    expect(database().prepare("SELECT COUNT(*) n FROM player_self_login WHERE userId='kid'").get()).toMatchObject({ n: 0 });
    expect(pending("kid")).toMatchObject({ n: 0 });
    expect(waiting()).toMatchObject({ n: 1 });
    expect(selfPlayerStatus(kid)).toEqual({ state: "waiting", playerLogin: false });
    expect(viewerOf(kid)).toEqual({ id: "kid", name: "kid" });
  });

  it("can be sent once; a second send is refused and does not replace the first", async () => {
    const kid = await joined();
    submitSelfPlayer(kid, good);
    expect(await status(() => submitSelfPlayer(kid, { ...good, name: "Someone Else" }))).toBe(409);
    expect(listSelfPlayers(owner).items.map((x) => x.name)).toEqual(["Kiran Kumar"]);
  });

  it("applies the same under-18 rule as every other way of adding a player, and stores nothing when it refuses", async () => {
    const kid = await joined();
    const refusal = async (input: unknown) => status(() => submitSelfPlayer(kid, input));
    expect(await refusal({ ...good, birthDate: "" })).toBe(400);
    expect(await refusal({ ...good, birthDate: "not-a-date" })).toBe(400);
    expect(await refusal({ ...good, birthDate: "2999-01-01" })).toBe(400);
    expect(await refusal({ ...good, birthDate: years(18) })).toBe(400);
    expect(await refusal({ ...good, birthDate: years(30) })).toBe(400);
    expect(await refusal({ ...good, name: "K" })).toBe(400);
    expect(await refusal({ ...good, guardianAware: false })).toBe(400);
    expect(await refusal({ name: good.name, birthDate: good.birthDate })).toBe(400);
    expect(waiting()).toMatchObject({ n: 0 });
    expect(pending("kid")).toMatchObject({ n: 1 });
    expect(submitSelfPlayer(kid, { ...good, birthDate: years(17) })).toEqual({ state: "waiting" });
  });

  it("is for an account that used a link: others have nothing to send", async () => {
    expect(selfPlayerStatus(ctxFor("PARENT", "mum"))).toEqual({ state: "none", playerLogin: false });
    expect(await status(() => submitSelfPlayer(ctxFor("PARENT", "mum"), good))).toBe(409);
    expect(await status(() => submitSelfPlayer(ctxFor("COACH", "coach"), good))).toBe(403);
    expect(await status(() => submitSelfPlayer(owner, good))).toBe(403);
    expect(selfPlayerStatus(ctxFor("COACH", "coach"))).toEqual({ state: "none", playerLogin: false });
  });
});

describe("the academy confirms or declines", () => {
  const sent = async (coachId?: string) => {
    const { token } = createPlayerLink(owner, coachId ? { coachId } : {});
    await openLink(token, "kid", "kid@example.test");
    const kid = ctxFor("PARENT", "kid");
    submitSelfPlayer(kid, good);
    return kid;
  };
  const approve = (consentOnFile?: boolean) =>
    decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile });

  it("lists the waiting details for the owner and admin only, without an email address", async () => {
    await sent("coach");
    const listed = listSelfPlayers(owner);
    expect(listed.items).toEqual([
      expect.objectContaining({ userId: "kid", name: "Kiran Kumar", birthDate: "2014-03-03", position: "Midfield", coachName: "coach" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("@");
    expect(await status(() => listSelfPlayers(ctxFor("COACH", "coach")))).toBe(403);
    expect(await status(() => listSelfPlayers(ctxFor("PARENT", "mum")))).toBe(403);
  });

  it("will not confirm without the statement that a parent or guardian has agreed, and creates nothing", async () => {
    await sent();
    expect(await status(() => approve())).toBe(400);
    expect(await status(() => approve(false))).toBe(400);
    expect(players()).toHaveLength(1);
    expect(listSelfPlayers(owner).items).toHaveLength(1);
  });

  it("confirms: the player exists, is linked to this account only, looked after by the person named", async () => {
    const kid = await sent("coach");
    const { playerId } = approve(true) as { playerId: string };
    expect(repo.find(academy.id, "player", playerId)).toMatchObject({
      name: "Kiran Kumar",
      birthDate: "2014-03-03",
      position: "Midfield",
      status: "ACTIVE",
      coachId: "coach",
      squadId: "",
      sportIds: ["football"],
    });
    expect(
      database().prepare("SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId='kid'").all(academy.id),
    ).toEqual([{ playerId }]);
    expect(database().prepare("SELECT COUNT(*) n FROM player_self_login WHERE academyId=? AND userId='kid'").get(academy.id)).toMatchObject({ n: 1 });
    expect(listSelfPlayers(owner).items).toHaveLength(0);
    expect(selfPlayerStatus(kid)).toEqual({ state: "none", playerLogin: true });
    expect(viewerOf(kid)).toEqual({ id: "kid", name: "kid", playerLogin: true });
    // A parent's account is not marked as a player's.
    expect(viewerOf(ctxFor("PARENT", "mum"))).toEqual({ id: "mum", name: "mum" });
    expect(selfPlayerStatus(kid)).toEqual({ state: "none", playerLogin: true });
  });

  it("can be confirmed once; a second confirm is refused", async () => {
    await sent();
    approve(true);
    expect(await status(() => approve(true))).toBe(409);
    expect(players()).toHaveLength(2);
  });

  it("is for the owner and admin: a coach or a parent cannot confirm or decline", async () => {
    await sent();
    for (const who of [ctxFor("COACH", "coach"), ctxFor("PARENT", "mum"), ctxFor("PARENT", "kid")]) {
      expect(await status(() => decideSelfPlayer(who, { userId: "kid", decision: "approve", consentOnFile: true }))).toBe(403);
      expect(await status(() => decideSelfPlayer(who, { userId: "kid", decision: "decline" }))).toBe(403);
    }
    expect(players()).toHaveLength(1);
    expect(listSelfPlayers(owner).items).toHaveLength(1);
  });

  it("checks the date of birth again at confirmation, and the player turning 18 in the meantime is refused", async () => {
    await sent();
    database().prepare("UPDATE player_self_submission SET birthDate=? WHERE userId='kid'").run(years(18));
    expect(await status(() => approve(true))).toBe(400);
    expect(players()).toHaveLength(1);
  });

  it("declines: nothing is created and the account loses its access", async () => {
    await sent();
    expect(decideSelfPlayer(owner, { userId: "kid", decision: "decline" })).toEqual({ declined: true });
    expect(players()).toHaveLength(1);
    expect(database().prepare("SELECT active FROM academy_memberships WHERE academyId=? AND userId='kid'").get(academy.id)).toMatchObject({ active: 0 });
    expect(listSelfPlayers(owner).items).toHaveLength(0);
    expect(await status(() => decideSelfPlayer(owner, { userId: "kid", decision: "decline" }))).toBe(409);
  });

  it("does not list or confirm a request whose account was revoked in the meantime", async () => {
    await sent();
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId='kid'").run(academy.id);
    expect(listSelfPlayers(owner).items).toHaveLength(0);
    expect(await status(() => approve(true))).toBe(409);
  });

  it("falls back to the owner if the named staff member has lost access before confirmation", async () => {
    await sent("coach");
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId='coach'").run(academy.id);
    const { playerId } = approve(true) as { playerId: string };
    expect(repo.find(academy.id, "player", playerId)!.coachId).toBe("owner");
  });

  it("keeps only name, date of birth and position from the player: nothing else they send is kept", async () => {
    const { token } = createPlayerLink(owner, { coachId: "coach" });
    await openLink(token, "kid", "kid@example.test");
    submitSelfPlayer(ctxFor("PARENT", "kid"), {
      ...good,
      coachId: "owner",
      status: "TRIAL",
      squadId: "x",
      squad: "Elite",
      id: "asha",
      academyId: "other",
    });
    const { playerId } = approve(true) as { playerId: string };
    const record = repo.find(academy.id, "player", playerId)!;
    expect(record).toMatchObject({ coachId: "coach", status: "ACTIVE", squadId: "" });
    expect(record.id).not.toBe("asha");
    expect(repo.find(academy.id, "player", "asha")!.name).toBe("Asha Rao");
  });
});

describe("what a player's own login can reach", () => {
  const confirmed = async () => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    const kid = ctxFor("PARENT", "kid");
    submitSelfPlayer(kid, good);
    const { playerId } = decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile: true }) as { playerId: string };
    return { kid, playerId };
  };

  it("sees only their own record, the same scope a guardian has, and a parent keeps seeing only their child", async () => {
    const { playerId } = await confirmed();
    const linked = (userId: string) =>
      database()
        .prepare("SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?")
        .all(academy.id, userId)
        .map((r) => String(r.playerId));
    expect(linked("kid")).toEqual([playerId]);
    expect(linked("mum")).toEqual(["asha"]);
  });

  it("cannot start or continue a private conversation with staff; a parent still can", async () => {
    const { kid, playerId } = await confirmed();
    expect(await status(() => saveRecord(kid, "conversation", { playerId, guardianId: "kid", subject: "Hello coach" }))).toBe(403);
    expect(await status(() => reply(kid, "any-conversation", { body: "Hi" }))).toBe(403);
    const mum = ctxFor("PARENT", "mum");
    const made = saveRecord(mum, "conversation", { playerId: "asha", guardianId: "mum", subject: "About Asha" }) as { id: string };
    expect(made.id).toBeTruthy();
  });

  it("is refused fees on the server (403), while a parent is not refused for that reason", async () => {
    const { kid } = await confirmed();
    expect(() => financeView(kid)).toThrow(/handled by your parent or guardian/);
    expect(await status(() => financeView(kid))).toBe(403);
    expect(() => financeView(ctxFor("PARENT", "mum"))).not.toThrow(/handled by your parent or guardian/);
  });

  it("is never a recipient of staff messages: staff reach the parent of a player, not a child's own login", async () => {
    await confirmed();
    const draft = {
      subject: "Training update",
      body: "Practice is at five.",
      playerIds: [],
      batchIds: [],
      allBatches: true,
      channels: ["PORTAL", "EMAIL", "WHATSAPP"],
      templateId: null,
    };
    const preview = previewMessage(owner, draft);
    expect(preview.recipients.map((r) => r.userId)).toEqual(["mum"]);
    expect(preview.audience.players).toBe(2);
    expect(preview.audience.playersWithParent).toBe(1);
  });
});

describe("possible duplicates: the owner is warned, nothing is merged", () => {
  const request = async (details: Record<string, unknown>) => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    submitSelfPlayer(ctxFor("PARENT", "kid"), { ...good, ...details });
  };
  const approve = (extra: Record<string, unknown> = {}) =>
    decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile: true, ...extra });
  const duplicatesOf = () => listSelfPlayers(owner).items[0].possibleDuplicates;

  it("spots the same name in another order, case and spacing, with the same date of birth", async () => {
    await request({ name: "  RAO   asha ", birthDate: "2016-04-04" });
    expect(duplicatesOf()).toEqual([
      expect.objectContaining({ id: "asha", name: "Asha Rao", reason: "Same name and date of birth" }),
    ]);
  });

  it("ignores accents when comparing names", async () => {
    repo.save(academy.id, "player", {
      ...(repo.find(academy.id, "player", "asha") as object),
      id: "jose",
      name: "José Núñez",
      birthDate: "2015-05-05",
    } as never);
    await request({ name: "jose nunez", birthDate: "2015-05-05" });
    expect(duplicatesOf().map((d) => d.id)).toEqual(["jose"]);
  });

  it("refuses to confirm until the owner says this is a different player, and creates nothing", async () => {
    await request({ name: "Asha Rao", birthDate: "2016-04-04" });
    expect(await status(() => approve())).toBe(409);
    expect(await status(() => approve({ differentPlayer: false }))).toBe(409);
    let failure: { code?: string; message?: string } = {};
    try {
      approve();
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure.message).toContain("Asha Rao");
    expect(failure.message).toContain("Nothing is merged");
    expect(players()).toHaveLength(1);
    expect(listSelfPlayers(owner).items).toHaveLength(1);
    expect(database().prepare("SELECT COUNT(*) n FROM player_link_login WHERE academyId=?").get(academy.id)).toMatchObject({ n: 0 });
  });

  it("makes a separate player when the owner says so, and leaves the existing one exactly as it was", async () => {
    const before = JSON.stringify(repo.find(academy.id, "player", "asha"));
    const guardiansBefore = database().prepare("SELECT userId FROM guardian_relationships WHERE academyId=? AND playerId='asha'").all(academy.id);
    await request({ name: "Asha Rao", birthDate: "2016-04-04" });
    const { playerId } = approve({ differentPlayer: true }) as { playerId: string };
    expect(playerId).not.toBe("asha");
    expect(players()).toHaveLength(2);
    expect(JSON.stringify(repo.find(academy.id, "player", "asha"))).toBe(before);
    expect(database().prepare("SELECT userId FROM guardian_relationships WHERE academyId=? AND playerId='asha'").all(academy.id)).toEqual(guardiansBefore);
    expect(database().prepare("SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId='kid'").all(academy.id)).toEqual([{ playerId }]);
  });

  it("warns on the same name with a different date of birth, and on the same date of birth with the same first name", async () => {
    await request({ name: "Asha Rao", birthDate: "2014-01-01" });
    expect(duplicatesOf()).toEqual([expect.objectContaining({ id: "asha", reason: "Same name" })]);
    database().exec("DELETE FROM player_self_submission");
    database().prepare("INSERT OR REPLACE INTO player_self_pending(academyId,userId,invitationId,coachId,createdAt) VALUES(?,?,?,?,?)").run(academy.id, "kid", "x", "owner", new Date().toISOString());
    submitSelfPlayer(ctxFor("PARENT", "kid"), { ...good, name: "Asha Menon", birthDate: "2016-04-04" });
    expect(duplicatesOf()).toEqual([expect.objectContaining({ id: "asha", reason: "Same date of birth and first name" })]);
  });

  it("does not warn about a different person, and confirms without the extra tick", async () => {
    await request({});
    expect(duplicatesOf()).toEqual([]);
    expect(approve()).toMatchObject({ declined: false });
  });

  it("includes archived players: a returning player is the usual case", async () => {
    repo.save(academy.id, "player", { ...(repo.find(academy.id, "player", "asha") as object), status: "ARCHIVED" } as never);
    await request({ name: "Asha Rao", birthDate: "2016-04-04" });
    expect(duplicatesOf()).toEqual([expect.objectContaining({ id: "asha", status: "ARCHIVED" })]);
    expect(await status(() => approve())).toBe(409);
  });

  it("looks again inside the confirmation, so a player added after the list was shown is seen", async () => {
    await request({});
    expect(duplicatesOf()).toEqual([]);
    repo.save(academy.id, "player", {
      ...(repo.find(academy.id, "player", "asha") as object),
      id: "kiran-2",
      name: "Kumar Kiran",
      birthDate: "2014-03-03",
    } as never);
    expect(await status(() => approve())).toBe(409);
    expect(players()).toHaveLength(2);
  });

  it("never warns the other way: declining needs no tick", async () => {
    await request({ name: "Asha Rao", birthDate: "2016-04-04" });
    expect(decideSelfPlayer(owner, { userId: "kid", decision: "decline" })).toEqual({ declined: true });
  });
});

describe("player links are switched off until the operator switches them on", () => {
  afterEach(() => {
    process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";
  });
  const off = () => {
    process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "";
  };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { status?: number; code?: string }).code;
    }
  };

  it("is off unless the value is exactly 1", async () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      if (value === undefined) delete process.env.SPORTOZEN_PLAYER_LINKS_ENABLED;
      else process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = value;
      expect(await status(() => createPlayerLink(owner, {}))).toBe(403);
    }
    process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";
    expect(createPlayerLink(owner, {}).token).toBeTruthy();
  });

  it("refuses to make a link and says why", () => {
    const links = () => database().prepare("SELECT COUNT(*) n FROM workspace_invitations WHERE academyId=?").get(academy.id);
    off();
    expect(codeOf(() => createPlayerLink(owner, {}))).toBe("PLAYER_LINKS_DISABLED");
    expect(links()).toMatchObject({ n: 0 });
  });

  it("refuses to open a link that was made earlier, and does not use it up", async () => {
    const { token } = createPlayerLink(owner, {});
    off();
    expect(await status(() => openLink(token, "kid", "kid@example.test"))).toBe(403);
    expect(repo.membership(academy.id, "kid")).toBeUndefined();
    process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";
    await openLink(token, "kid", "kid@example.test");
    expect(repo.membership(academy.id, "kid")).toBeTruthy();
  });

  it("refuses to send details and to confirm, but still lets the owner decline", async () => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    off();
    expect(await status(() => submitSelfPlayer(ctxFor("PARENT", "kid"), good))).toBe(403);
    process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";
    submitSelfPlayer(ctxFor("PARENT", "kid"), good);
    off();
    expect(
      await status(() => decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile: true })),
    ).toBe(403);
    expect(players()).toHaveLength(1);
    expect(decideSelfPlayer(owner, { userId: "kid", decision: "decline" })).toEqual({ declined: true });
  });

  it("tells the owner's screen, so it can hide the button instead of offering one that fails", () => {
    expect(listSelfPlayers(owner).enabled).toBe(true);
    off();
    expect(listSelfPlayers(owner).enabled).toBe(false);
  });

  it("does not stop the existing way to add a player or to invite a parent", () => {
    off();
    expect(
      invite(owner, { email: "p3@example.test", role: "PARENT", playerIds: ["asha"], guardianVerified: true }).token,
    ).toBeTruthy();
  });
});

describe("which accounts the limits apply to", () => {
  const confirmedKid = async () => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    const kid = ctxFor("PARENT", "kid");
    submitSelfPlayer(kid, good);
    decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile: true });
    return kid;
  };

  it("marks a login only when the owner confirms, and records who confirmed and when", async () => {
    const { token } = createPlayerLink(owner, {});
    await openLink(token, "kid", "kid@example.test");
    submitSelfPlayer(ctxFor("PARENT", "kid"), good);
    expect(database().prepare("SELECT COUNT(*) n FROM player_link_login WHERE academyId=?").get(academy.id)).toMatchObject({ n: 0 });
    decideSelfPlayer(owner, { userId: "kid", decision: "approve", consentOnFile: true });
    expect(
      database().prepare("SELECT userId,confirmedBy FROM player_link_login WHERE academyId=?").all(academy.id),
    ).toEqual([{ userId: "kid", confirmedBy: "owner" }]);
  });

  it("leaves an older own-login account exactly as it was: fees, private messages and recipient lists included", async () => {
    // An account made by the older route: a row in player_self_login and no marker.
    database().prepare("INSERT INTO player_self_login(academyId,userId,playerId) VALUES(?,?,?)").run(academy.id, "mum", "asha");
    const older = ctxFor("PARENT", "mum");
    expect(viewerOf(older)).toEqual({ id: "mum", name: "mum" });
    expect(() => financeView(older)).not.toThrow(/handled by your parent or guardian/);
    expect(
      (saveRecord(older, "conversation", { playerId: "asha", guardianId: "mum", subject: "About Asha" }) as { id: string }).id,
    ).toBeTruthy();
    const draft = { subject: "Training update", body: "Practice is at five.", playerIds: [], batchIds: [], allBatches: true, channels: ["PORTAL"], templateId: null };
    expect(previewMessage(owner, draft).recipients.map((r) => r.userId)).toEqual(["mum"]);
  });

  it("cannot be used to accept a guardian invitation while it is a player login (no extra links, no wider reading)", async () => {
    const kid = await confirmedKid();
    const { token } = invite(owner, { email: "kid@example.test", role: "PARENT", playerIds: ["asha"], guardianVerified: true });
    expect(await status(() => openLink(token, "kid", "kid@example.test"))).toBe(409);
    expect(
      database().prepare("SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId='kid'").all(academy.id),
    ).toHaveLength(1);
    expect(viewerOf(kid)).toMatchObject({ playerLogin: true });
  });

  it("drops the limits when the account is given a new membership, for example as a guardian", async () => {
    const kid = await confirmedKid();
    expect(viewerOf(kid)).toMatchObject({ playerLogin: true });
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId='kid'").run(academy.id);
    const { token } = invite(owner, { email: "kid@example.test", role: "PARENT", playerIds: ["asha"], guardianVerified: true });
    await openLink(token, "kid", "kid@example.test");
    expect(database().prepare("SELECT COUNT(*) n FROM player_link_login WHERE academyId=? AND userId='kid'").get(academy.id)).toMatchObject({ n: 0 });
    expect(viewerOf(ctxFor("PARENT", "kid"))).toEqual({ id: "kid", name: "kid" });
  });
});
