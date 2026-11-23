// P0-02 player lifecycle and P1-01 placement source of truth (decision D9):
// `player.squadId` is authoritative and a batch roster is derived from it.
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
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { saveRecord } from "@/server/workspace-service";
import { trainingAction } from "@/server/training-service";
import { financeAction, financeInvoiceProposal } from "@/server/finance-service";
import { resolveAnnouncement } from "@/server/batch-announcement-service";
import { homeSummary } from "@/server/home-summary-service";
import { playerSchema } from "@/server/workspace-schemas";
import {
  participates,
  transitionNeedsManager,
} from "@/domain/player-lifecycle";
import type { AcademyConfiguration, AcademyRole } from "@/domain/workspace";
import type { WorkspaceAccess } from "@/server/workspace-access";
import { activateAcademy } from "./helpers/lifecycle";

const filename = join(tmpdir(), `sportozen-lifecycle-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;

let academy: AcademyConfiguration;
function config(): AcademyConfiguration {
  const id = randomUUID();
  return {
    id,
    academyId: id,
    name: "Synthetic football academy",
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
    demo: false,
    onboardingStatus: "ACTIVE",
  };
}
function seed(cfg: AcademyConfiguration) {
  const db = database();
  db.exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,name TEXT NOT NULL);',
  );
  db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(
    cfg.id,
    JSON.stringify(cfg),
  );
  db.prepare(
    "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)",
  ).run(cfg.id, "TEST", JSON.stringify(cfg.modules), "ACTIVE");
  activateAcademy(db, cfg.id);
  for (const role of ["OWNER", "ADMIN", "COACH", "PARENT"] as const) {
    const userId = `${role}-${cfg.id}`;
    db.prepare(
      "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
    ).run(userId, cfg.id, userId, role, '["football"]');
    db.prepare("INSERT INTO user(id,name) VALUES(?,?)").run(userId, role);
  }
}
function actor(role: AcademyRole, cfg = academy): WorkspaceAccess {
  const userId = `${role}-${cfg.id}`;
  return {
    academy: cfg,
    membership: {
      id: userId,
      userId,
      academyId: cfg.id,
      role,
      active: true,
      sportIds: ["football"],
    },
    user: {
      id: userId,
      name: role,
      email: `${role}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: null,
    },
  };
}
const coachId = () => actor("COACH").user.id;
function act(
  ctx: WorkspaceAccess,
  action: string,
  data: unknown,
  extra: { id?: string; expectedVersion?: number } = {},
) {
  return trainingAction(ctx, { requestId: randomUUID(), action, data, ...extra });
}
function newPlayer(id: string, extra: Record<string, unknown> = {}) {
  return saveRecord(
    actor("OWNER"),
    "player",
    { name: `Synthetic ${id}`, coachId: coachId(), birthDate: "2014-05-05", ...extra },
    id,
  );
}
const stored = (id: string) => repo.find(academy.id, "player", id)!;
const roster = (squadId: string) =>
  repo.find(academy.id, "squad", squadId)!.playerIds;
function setStatus(
  ctx: WorkspaceAccess,
  id: string,
  status: string,
  expectedVersion = stored(id).recordVersion,
) {
  return saveRecord(
    ctx,
    "player",
    { name: stored(id).name, coachId: stored(id).coachId, status, expectedVersion },
    id,
  );
}
async function status(fn: () => unknown) {
  try {
    await fn();
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
  return 0;
}
function squad(id: string, name: string, playerIds: string[]) {
  return act(actor("OWNER"), "squad", { name, branchId: "branch", playerIds }, {
    id,
  }) as { id: string; version: number };
}

beforeEach(() => {
  academy = config();
  seed(academy);
  repo.save(academy.id, "branch", {
    id: "branch",
    academyId: academy.id,
    name: "Main branch",
    timezone: academy.timezone,
  });
});
afterAll(() => {
  // The open handle may still hold the file on Windows; the temp folder is
  // disposable, so a failed removal is not a test failure.
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* best effort */
    }
});

describe("lifecycle vocabulary", () => {
  it("accepts the five statuses and nothing else", () => {
    for (const s of ["ACTIVE", "TRIAL", "PAUSED", "INACTIVE", "ARCHIVED"])
      expect(
        playerSchema.safeParse({ name: "Player", coachId: "c", status: s })
          .success,
      ).toBe(true);
    expect(
      playerSchema.safeParse({ name: "Player", coachId: "c", status: "LEFT" })
        .success,
    ).toBe(false);
  });
  it("only ACTIVE, TRIAL and an unset status take part", () => {
    expect(
      [undefined, "ACTIVE", "TRIAL"].every((s) => participates(s)),
    ).toBe(true);
    expect(
      ["PAUSED", "INACTIVE", "ARCHIVED"].some((s) => participates(s)),
    ).toBe(false);
  });
  it("PAUSED and ARCHIVED changes need a manager; the coach's existing statuses do not", () => {
    expect(transitionNeedsManager("ACTIVE", "ARCHIVED")).toBe(true);
    expect(transitionNeedsManager("ARCHIVED", "ACTIVE")).toBe(true);
    expect(transitionNeedsManager("ACTIVE", "PAUSED")).toBe(true);
    expect(transitionNeedsManager("ACTIVE", "INACTIVE")).toBe(false);
    expect(transitionNeedsManager("TRIAL", "ACTIVE")).toBe(false);
    expect(transitionNeedsManager("PAUSED", "PAUSED")).toBe(false);
  });
});

describe("who may change a player's lifecycle", () => {
  it("owner and admin can pause, archive and restore, and each change is audited", () => {
    newPlayer("p1");
    setStatus(actor("ADMIN"), "p1", "PAUSED");
    setStatus(actor("OWNER"), "p1", "ARCHIVED");
    setStatus(actor("OWNER"), "p1", "ACTIVE");
    expect(stored("p1").status).toBe("ACTIVE");
    const entries = database()
      .prepare(
        "SELECT action FROM workspace_audit WHERE academyId=? AND resourceId=? AND action LIKE 'Player status changed%' ORDER BY id",
      )
      .all(academy.id, "p1")
      .map((r) => String(r.action));
    expect(entries).toEqual([
      "Player status changed from ACTIVE to PAUSED",
      "Player status changed from PAUSED to ARCHIVED",
      "Player status changed from ARCHIVED to ACTIVE",
    ]);
  });
  it("a coach cannot pause or archive even their own player", async () => {
    newPlayer("p2");
    expect(await status(() => setStatus(actor("COACH"), "p2", "ARCHIVED"))).toBe(
      403,
    );
    expect(await status(() => setStatus(actor("COACH"), "p2", "PAUSED"))).toBe(
      403,
    );
    expect(stored("p2").status).toBe("ACTIVE");
  });
  it("a coach keeps the limited controls they had: ACTIVE, TRIAL, INACTIVE", () => {
    newPlayer("p3");
    setStatus(actor("COACH"), "p3", "INACTIVE");
    expect(stored("p3").status).toBe("INACTIVE");
    setStatus(actor("COACH"), "p3", "ACTIVE");
    expect(stored("p3").status).toBe("ACTIVE");
  });
  it("a coach cannot restore an archived player", async () => {
    newPlayer("p4");
    setStatus(actor("OWNER"), "p4", "ARCHIVED");
    expect(await status(() => setStatus(actor("COACH"), "p4", "ACTIVE"))).toBe(
      403,
    );
    expect(stored("p4").status).toBe("ARCHIVED");
  });
  it("a parent cannot save a player at all", async () => {
    newPlayer("p5");
    expect(await status(() => setStatus(actor("PARENT"), "p5", "ARCHIVED"))).toBe(
      403,
    );
  });
});

describe("an archived profile accepts no new records", () => {
  it("rejects further edits until restored, then accepts them", async () => {
    newPlayer("a1");
    setStatus(actor("OWNER"), "a1", "ARCHIVED");
    expect(
      await status(() =>
        saveRecord(
          actor("OWNER"),
          "player",
          {
            name: "Renamed",
            coachId: coachId(),
            status: "ARCHIVED",
            expectedVersion: stored("a1").recordVersion,
          },
          "a1",
        ),
      ),
    ).toBe(409);
    expect(stored("a1").name).toBe("Synthetic a1");
    setStatus(actor("OWNER"), "a1", "ACTIVE");
    saveRecord(
      actor("OWNER"),
      "player",
      {
        name: "Renamed",
        coachId: coachId(),
        expectedVersion: stored("a1").recordVersion,
      },
      "a1",
    );
    expect(stored("a1").name).toBe("Renamed");
  });
  it("rejects a new legacy fee record, an invoice and a fee override for an archived player, and accepts them after restore", async () => {
    newPlayer("a2");
    const fee = {
      playerId: "a2",
      amountMinor: 1000,
      currency: "INR",
      label: "Kit",
    };
    const invoice = {
      playerId: "a2",
      label: "Monthly football",
      chargeMinor: 10000,
      currency: "INR",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      dueDate: "2026-10-20",
    };
    const submit = () =>
      financeAction(actor("OWNER"), {
        requestId: randomUUID(),
        action: "invoice",
        data: invoice,
      });
    setStatus(actor("OWNER"), "a2", "ARCHIVED");
    expect(await status(() => saveRecord(actor("OWNER"), "fee", fee))).toBe(409);
    expect(await status(submit)).toBe(409);
    setStatus(actor("OWNER"), "a2", "ACTIVE");
    expect(await status(() => saveRecord(actor("OWNER"), "fee", fee))).toBe(0);
    expect(await status(submit)).toBe(0);
  });
  it("history stays readable to the academy after archiving", () => {
    newPlayer("a3");
    setStatus(actor("OWNER"), "a3", "ARCHIVED");
    expect(repo.find(academy.id, "player", "a3")?.status).toBe("ARCHIVED");
  });
});

describe("a player who is not taking part", () => {
  it("is left off the roster of a new session, kept on the batch and on past sessions", () => {
    for (const id of ["r1", "r2", "r3", "r4"]) newPlayer(id);
    const batch = squad("b1", "U12", ["r1", "r2", "r3", "r4"]);
    expect(batch.id).toBe("b1");
    const draft = (start: string) => ({
      branchId: "branch",
      squadId: "b1",
      coachIds: [coachId()],
      timezone: academy.timezone,
      startLocal: `${start}T17:00`,
      endLocal: `${start}T18:00`,
    });
    const before = act(actor("OWNER"), "session", draft("2026-12-01")) as {
      id: string;
      roster: { playerId: string }[];
    };
    expect(before.roster.map((p) => p.playerId).sort()).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
    setStatus(actor("OWNER"), "r2", "PAUSED");
    setStatus(actor("OWNER"), "r3", "INACTIVE");
    setStatus(actor("OWNER"), "r4", "ARCHIVED");
    const after = act(actor("OWNER"), "session", draft("2026-12-08")) as {
      roster: { playerId: string }[];
    };
    expect(after.roster.map((p) => p.playerId)).toEqual(["r1"]);
    // The session created earlier keeps the roster it had, and the batch keeps
    // every placement so a restore returns the player to the same batch.
    expect(
      repo.find(academy.id, "session", before.id)!.roster.map((p) => p.playerId),
    ).toHaveLength(4);
    expect(roster("b1").sort()).toEqual(["r1", "r2", "r3", "r4"]);
    expect(stored("r4").squadId).toBe("b1");
  });
  it("gets no recurring fee suggestion while paused, inactive or archived", () => {
    newPlayer("f1");
    for (const s of ["PAUSED", "INACTIVE", "ARCHIVED"]) {
      setStatus(actor("OWNER"), "f1", s);
      const proposal = financeInvoiceProposal(actor("OWNER"), "f1", "2026-10-15");
      expect(proposal.available).toBe(false);
      expect(proposal.reason).toMatch(
        s === "ARCHIVED" ? /archived/i : /not currently taking part/i,
      );
      setStatus(actor("OWNER"), "f1", "ACTIVE");
    }
    // An active player is judged by the normal fee rules instead.
    expect(
      financeInvoiceProposal(actor("OWNER"), "f1", "2026-10-15").reason,
    ).not.toMatch(/taking part|archived/i);
  });
  it("is not addressed by a batch announcement and does not count as active", () => {
    for (const id of ["n1", "n2", "n3"]) newPlayer(id);
    squad("ann", "U10", ["n1", "n2", "n3"]);
    const draft = {
      batchIds: ["ann"],
      kind: "SCHEDULE_CHANGE",
      urgency: "NORMAL",
      body: "Training starts at five on Saturday.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as never;
    const unlinked = () =>
      resolveAnnouncement(actor("OWNER"), draft).preview.excluded.filter(
        (e) => e.reason === "Selected player has no linked guardian",
      ).length;
    expect(unlinked()).toBe(3);
    setStatus(actor("OWNER"), "n2", "PAUSED");
    setStatus(actor("OWNER"), "n3", "ARCHIVED");
    expect(unlinked()).toBe(1);
    expect(homeSummary(actor("OWNER")).activePlayers).toBe(1);
  });
});

describe("placement: player.squadId is the source of truth, rosters follow", () => {
  it("saving a roster places the players and takes them off any other batch", () => {
    for (const id of ["s1", "s2", "s3"]) newPlayer(id);
    squad("one", "Batch one", ["s1", "s2"]);
    expect(stored("s1")).toMatchObject({ squadId: "one", squad: "Batch one" });
    squad("two", "Batch two", ["s2", "s3"]);
    // s2 moved: one placement, one roster.
    expect(stored("s2")).toMatchObject({ squadId: "two", squad: "Batch two" });
    expect(roster("one")).toEqual(["s1"]);
    expect(roster("two")).toEqual(["s2", "s3"]);
    for (const p of repo.list(academy.id, "player")) {
      const holding = repo
        .list(academy.id, "squad")
        .filter((s) => s.playerIds.includes(p.id))
        .map((s) => s.id);
      expect(holding).toEqual(p.squadId ? [p.squadId] : []);
    }
  });
  it("removing a player from a roster clears their placement", () => {
    for (const id of ["m1", "m2"]) newPlayer(id);
    const saved = squad("keep", "Keep", ["m1", "m2"]);
    act(actor("OWNER"), "squad", { name: "Keep", branchId: "branch", playerIds: ["m1"] }, {
      id: "keep",
      expectedVersion: saved.version,
    });
    expect(stored("m2")).toMatchObject({ squadId: "", squad: "" });
    expect(stored("m1").squadId).toBe("keep");
  });
  it("removing a player from a roster does not clear a placement in a different batch (older, inconsistent data)", () => {
    newPlayer("v1");
    squad("home", "Home", ["v1"]);
    // Older data: a second roster also lists v1, but v1 is placed at "home".
    const elsewhere = squad("away", "Away", []);
    repo.save(academy.id, "squad", {
      ...repo.find(academy.id, "squad", "away")!,
      playerIds: ["v1"],
    });
    act(actor("OWNER"), "squad", { name: "Away", branchId: "branch", playerIds: [] }, {
      id: "away",
      expectedVersion: elsewhere.version,
    });
    expect(stored("v1")).toMatchObject({ squadId: "home", squad: "Home" });
  });
  it("renaming a batch keeps its players' labels in step", () => {
    newPlayer("t1");
    const saved = squad("ren", "Old name", ["t1"]);
    act(actor("OWNER"), "squad", { name: "New name", branchId: "branch", playerIds: ["t1"] }, {
      id: "ren",
      expectedVersion: saved.version,
    });
    expect(stored("t1").squad).toBe("New name");
  });
  it("cannot newly place an archived player", async () => {
    newPlayer("z1");
    setStatus(actor("OWNER"), "z1", "ARCHIVED");
    expect(await status(() => squad("arch", "Arch", ["z1"]))).toBe(409);
    expect(repo.find(academy.id, "squad", "arch")).toBeUndefined();
    expect(stored("z1").squadId).toBe("");
  });
  it("is atomic: a refused roster leaves every player and batch as it was", async () => {
    for (const id of ["y1", "y2"]) newPlayer(id);
    squad("first", "First", ["y1"]);
    setStatus(actor("OWNER"), "y2", "ARCHIVED");
    expect(await status(() => squad("second", "Second", ["y1", "y2"]))).toBe(409);
    expect(roster("first")).toEqual(["y1"]);
    expect(stored("y1").squadId).toBe("first");
  });
  it("stays consistent when a player is moved through the player form", () => {
    for (const id of ["w1", "w2"]) newPlayer(id);
    squad("left", "Left", ["w1"]);
    squad("right", "Right", []);
    saveRecord(
      actor("OWNER"),
      "player",
      {
        name: "Synthetic w1",
        coachId: coachId(),
        squadId: "right",
        placementReviewed: true,
        expectedVersion: stored("w1").recordVersion,
      },
      "w1",
    );
    expect(roster("left")).toEqual([]);
    expect(roster("right")).toEqual(["w1"]);
    expect(stored("w1").squadId).toBe("right");
  });
  it("only an owner or admin can save a roster, and never across academies", async () => {
    newPlayer("x1");
    expect(
      await status(() =>
        act(actor("COACH"), "squad", {
          name: "Coach batch",
          branchId: "branch",
          playerIds: ["x1"],
        }),
      ),
    ).toBe(403);
    const other = config();
    seed(other);
    repo.save(other.id, "branch", {
      id: "branch",
      academyId: other.id,
      name: "Other branch",
      timezone: other.timezone,
    });
    // Another academy's owner cannot place this academy's player.
    expect(
      await status(() =>
        act(actor("OWNER", other), "squad", {
          name: "Cross",
          branchId: "branch",
          playerIds: ["x1"],
        }),
      ),
    ).toBe(404);
    expect(stored("x1").squadId).toBe("");
  });
});
