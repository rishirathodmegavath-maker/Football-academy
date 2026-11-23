// WP4: the read-only integrity checker. A database built by the real services
// (players, batches, sessions, attendance, evidence, reports, invoices and
// payments) must be clean; each kind of broken link must be found; and
// checking must never change the file.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { checkDataIntegrity } from "@/server/data-integrity";
import { migrateIntegrityGuards } from "@/server/migrations/008-integrity-guards";
import { A, B, ids, seedApiFixture } from "./helpers/api-harness";
import { activateAcademy } from "./helpers/lifecycle";

const filename = join(tmpdir(), `sportozen-integrity-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const found = () => checkDataIntegrity(database());
const checks = () => found().map((f) => f.check);
const errors = () => found().filter((f) => f.severity === "ERROR");
const raw = (
  kind: string,
  id: string,
  body: Record<string, unknown>,
  playerId?: string,
) =>
  database()
    .prepare(
      "INSERT INTO workspace_records(academyId,kind,id,playerId,body) VALUES(?,?,?,?,?)",
    )
    .run(
      A,
      kind,
      id,
      playerId ?? null,
      JSON.stringify({ id, academyId: A, ...body }),
    );
const undo = (...recordIds: string[]) => {
  for (const id of recordIds)
    database()
      .prepare("DELETE FROM workspace_records WHERE academyId=? AND id=?")
      .run(A, id);
};
const finance = (
  kind: string,
  id: string,
  body: Record<string, unknown>,
  invoiceId?: string,
) =>
  database()
    .prepare(
      "INSERT INTO academy_finance_records(academyId,kind,id,playerId,invoiceId,body,version) VALUES(?,?,?,?,?,?,1)",
    )
    .run(
      A,
      kind,
      id,
      (body.playerId as string) ?? null,
      invoiceId ?? null,
      JSON.stringify({ id, academyId: A, ...body }),
    );
const undoFinance = (...recordIds: string[]) => {
  for (const id of recordIds)
    database()
      .prepare("DELETE FROM academy_finance_records WHERE id=?")
      .run(id);
};

describe("a database built by the real services", () => {
  it("has no integrity errors", () => {
    expect(errors()).toEqual([]);
  });
  it("is checked completely: the fixture really contains linked records", () => {
    const n = (sql: string) => Number(database().prepare(sql).get()?.n);
    expect(
      n("SELECT COUNT(*) n FROM workspace_records WHERE kind='attendance'"),
    ).toBeGreaterThan(0);
    expect(
      n("SELECT COUNT(*) n FROM workspace_records WHERE kind='evidence'"),
    ).toBeGreaterThan(0);
    expect(
      n("SELECT COUNT(*) n FROM workspace_records WHERE kind='report'"),
    ).toBeGreaterThan(0);
    expect(
      n("SELECT COUNT(*) n FROM academy_finance_records WHERE kind='invoice'"),
    ).toBeGreaterThan(0);
  });
});

describe("broken links are found", () => {
  const sessionId = () =>
    String(
      database()
        .prepare(
          "SELECT id FROM workspace_records WHERE kind='session' LIMIT 1",
        )
        .get()!.id,
    );
  it("attendance for a session that does not exist", () => {
    raw("attendance", "ghost:" + ids.p1, {
      sessionId: "ghost",
      playerId: ids.p1,
    });
    expect(checks()).toContain(
      "attendance refers to a session that does not exist",
    );
    undo("ghost:" + ids.p1);
  });
  it("attendance for someone who is not on the session roster", () => {
    // Choose a session and a real player missing from its roster without
    // assuming the fixture's order, and fail loudly if there is none.
    const players = [ids.p1, ids.p2, ids.p3];
    const rosterOf = (body: string) =>
      (JSON.parse(body).roster as { playerId: string }[]).map(
        (p) => p.playerId,
      );
    const pair = database()
      .prepare(
        "SELECT id,body FROM workspace_records WHERE kind='session' ORDER BY id",
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        outsider: players.find((p) => !rosterOf(String(row.body)).includes(p)),
      }))
      .find((candidate) => candidate.outsider);
    expect(
      pair,
      "fixture needs a session that omits one of the players",
    ).toBeDefined();
    const { id: s, outsider } = pair!;
    raw("attendance", `${s}:${outsider}`, {
      sessionId: s,
      playerId: outsider,
    });
    expect(checks()).toContain(
      "attendance is for a player who is not on the session roster",
    );
    undo(`${s}:${outsider}`);
  });
  it("attendance whose id could allow a duplicate for the same session and player", () => {
    const s = sessionId();
    raw("attendance", "another-id", { sessionId: s, playerId: ids.p1 });
    expect(checks()).toContain(
      "attendance id is not session:player (a duplicate could exist)",
    );
    undo("another-id");
  });
  it("records for a player that does not exist", () => {
    raw(
      "report",
      "orphan-report",
      { playerId: "nobody", status: "Draft" },
      "nobody",
    );
    expect(checks()).toContain("report refers to a player that does not exist");
    undo("orphan-report");
  });
  it("an approved report without its snapshot", () => {
    raw(
      "report",
      "no-snapshot",
      { playerId: ids.p1, status: "Approved" },
      ids.p1,
    );
    expect(checks()).toContain("approved report has no snapshot");
    undo("no-snapshot");
  });
  it("a batch listing a missing player, and a player in a missing batch", () => {
    raw("squad", "bad-squad", { branchId: ids.branch, playerIds: ["nobody"] });
    raw(
      "player",
      "bad-player",
      { squadId: "no-such-batch", coachId: ids.coachA },
      "bad-player",
    );
    expect(checks()).toEqual(
      expect.arrayContaining([
        "batch lists a player that does not exist",
        "player's batch does not exist",
      ]),
    );
    undo("bad-squad", "bad-player");
  });
  it("a record filed under the wrong academy (written around the guard)", () => {
    database().exec("DROP TRIGGER workspace_records_owner_insert");
    try {
      database()
        .prepare(
          "INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)",
        )
        .run(
          A,
          "note",
          "wrong-owner",
          JSON.stringify({ id: "wrong-owner", academyId: B }),
        );
      expect(checks()).toContain(
        "record body academyId differs from its row (tenant mismatch)",
      );
      undo("wrong-owner");
    } finally {
      migrateIntegrityGuards(database());
    }
  });
  it("a guardian link to a player that does not exist", () => {
    database()
      .prepare(
        "INSERT INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)",
      )
      .run(A, ids.parent1, "nobody");
    expect(checks()).toContain(
      "guardian_relationships row names a player that does not exist",
    );
    database()
      .prepare("DELETE FROM guardian_relationships WHERE playerId='nobody'")
      .run();
  });
});

describe("finance links and amounts", () => {
  const invoiceId = () =>
    String(
      database()
        .prepare(
          "SELECT id FROM academy_finance_records WHERE kind='invoice' AND playerId=? LIMIT 1",
        )
        .get(ids.p1)!.id,
    );
  const invoice = () =>
    JSON.parse(
      String(
        database()
          .prepare("SELECT body FROM academy_finance_records WHERE id=?")
          .get(invoiceId())!.body,
      ),
    );
  it("a payment or receipt that points at nothing", () => {
    finance(
      "payment",
      "pay-orphan",
      {
        playerId: ids.p1,
        invoiceId: "no-invoice",
        amountMinor: 100,
        status: "PENDING",
      },
      "no-invoice",
    );
    finance(
      "receipt",
      "rec-orphan",
      {
        playerId: ids.p1,
        invoiceId: invoiceId(),
        paymentId: "no-payment",
        amountMinor: 100,
      },
      invoiceId(),
    );
    expect(checks()).toEqual(
      expect.arrayContaining([
        "payment refers to an invoice that does not exist",
        "receipt refers to a payment that does not exist",
      ]),
    );
    undoFinance("pay-orphan", "rec-orphan");
  });
  it("a payment filed against another child's invoice", () => {
    finance(
      "payment",
      "pay-wrong-child",
      {
        playerId: ids.p2,
        invoiceId: invoiceId(),
        amountMinor: 100,
        status: "PENDING",
      },
      invoiceId(),
    );
    expect(checks()).toContain(
      "payment is for a different player than its invoice",
    );
    undoFinance("pay-wrong-child");
  });
  it("verified payments that exceed what was billed", () => {
    const billed = Number(invoice().chargeMinor);
    finance(
      "payment",
      "pay-too-much",
      {
        playerId: ids.p1,
        invoiceId: invoiceId(),
        amountMinor: billed + 1,
        status: "VERIFIED",
      },
      invoiceId(),
    );
    expect(checks()).toContain("verified payments exceed the amount billed");
    undoFinance("pay-too-much");
  });
  it("a receipt for a payment that is not verified, or whose amount differs", () => {
    finance(
      "payment",
      "pay-pending",
      {
        playerId: ids.p1,
        invoiceId: invoiceId(),
        amountMinor: 50,
        status: "PENDING",
      },
      invoiceId(),
    );
    finance(
      "receipt",
      "rec-early",
      {
        playerId: ids.p1,
        invoiceId: invoiceId(),
        paymentId: "pay-pending",
        amountMinor: 50,
      },
      invoiceId(),
    );
    expect(checks()).toContain(
      "receipt exists for a payment that is not verified",
    );
    undoFinance("pay-pending", "rec-early");
  });
  it("two invoices with the same number, and a negative amount", () => {
    const number = invoice().number;
    finance(
      "invoice",
      "inv-dup",
      { ...invoice(), id: "inv-dup", number },
      undefined,
    );
    finance(
      "payment",
      "pay-negative",
      {
        playerId: ids.p1,
        invoiceId: invoiceId(),
        amountMinor: -5,
        status: "PENDING",
      },
      invoiceId(),
    );
    expect(checks()).toEqual(
      expect.arrayContaining([
        "two invoices share a number",
        "payment amount is not a whole non-negative number",
      ]),
    );
    undoFinance("inv-dup", "pay-negative");
  });
  it("leaves the fixture clean again once the injected rows are removed", () => {
    expect(errors()).toEqual([]);
  });
});

describe("the approval lifecycle", () => {
  const restore = () =>
    database()
      .prepare("UPDATE academy_lifecycle SET state='ACTIVE' WHERE academyId=?")
      .run(A);
  it("reports an academy with no lifecycle record, which cannot operate", () => {
    database().prepare("DELETE FROM academy_lifecycle WHERE academyId=?").run(B);
    try {
      const finding = found().find((f) => f.check.includes("no approval lifecycle"));
      expect(finding).toMatchObject({ severity: "ERROR", examples: [B] });
    } finally {
      activateAcademy(database(), B);
    }
    expect(checks().some((c) => c.includes("no approval lifecycle"))).toBe(false);
  });
  it("warns when the lifecycle and the entitlement disagree", () => {
    database().prepare("UPDATE academy_lifecycle SET state='SUSPENDED' WHERE academyId=?").run(A);
    try {
      expect(checks()).toContain("approval lifecycle state disagrees with the platform entitlement");
    } finally {
      restore();
    }
    database().prepare("UPDATE academy_lifecycle SET state='CONFIGURING' WHERE academyId=?").run(A);
    try {
      expect(checks()).not.toContain("approval lifecycle state disagrees with the platform entitlement");
    } finally {
      restore();
    }
    expect(checks()).not.toContain("approval lifecycle state disagrees with the platform entitlement");
  });
});

describe("checking changes nothing", () => {
  it("opens the file read-only and leaves its contents unchanged", () => {
    database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const digest = () =>
      createHash("sha256").update(readFileSync(filename)).digest("hex");
    const before = digest();
    const readOnly = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(checkDataIntegrity(readOnly)).toBeDefined();
      expect(() => readOnly.exec("DELETE FROM workspace_records")).toThrow();
    } finally {
      readOnly.close();
    }
    expect(digest()).toBe(before);
  });
});

describe("placement disagreements are reported, never repaired (decision D9)", () => {
  const placement = [
    "player is placed in a batch whose roster does not list them",
    "batch lists a player who is placed in a different batch",
    "batch lists a player with no recorded placement (roster-only, older data)",
    "player is listed on more than one batch roster",
    "player has an unknown status",
  ];
  const branchId = () =>
    String(
      database()
        .prepare(
          "SELECT id FROM workspace_records WHERE academyId=? AND kind='branch' LIMIT 1",
        )
        .get(A)!.id,
    );
  const player = (id: string, extra: Record<string, unknown> = {}) =>
    raw("player", id, { name: id, sportIds: ["football"], coachId: "x", ...extra });
  const batch = (id: string, playerIds: string[]) =>
    raw("squad", id, { name: id, branchId: branchId(), sportId: "football", playerIds });
  const placementFindings = () =>
    found().filter((f) => placement.includes(f.check));
  it("the services never produce them", () => {
    expect(placementFindings()).toEqual([]);
  });
  it("a player whose batch roster does not list them", () => {
    batch("plc-a", []);
    player("plc-p", { squadId: "plc-a" });
    expect(placementFindings().map((f) => f.check)).toEqual([placement[0]]);
    undo("plc-a", "plc-p");
  });
  it("a roster that lists a player placed in another batch", () => {
    batch("plc-b1", ["plc-q"]);
    batch("plc-b2", ["plc-q"]);
    player("plc-q", { squadId: "plc-b2" });
    const checks = placementFindings().map((f) => f.check);
    expect(checks).toContain(placement[1]);
    // The same player is on two rosters, which is its own finding.
    expect(checks).toContain(placement[3]);
    undo("plc-b1", "plc-b2", "plc-q");
  });
  it("a roster-only placement from older data is a warning, not an error", () => {
    batch("plc-c", ["plc-r"]);
    player("plc-r");
    const finding = placementFindings().find((f) => f.check === placement[2]);
    expect(finding?.severity).toBe("WARNING");
    expect(errors()).toEqual([]);
    undo("plc-c", "plc-r");
  });
  it("an unknown player status", () => {
    player("plc-s", { status: "LEFT" });
    expect(placementFindings().map((f) => f.check)).toEqual([placement[4]]);
    undo("plc-s");
  });
  it("finding them changes nothing", () => {
    batch("plc-d", []);
    player("plc-t", { squadId: "plc-d" });
    const before = JSON.stringify(
      database()
        .prepare("SELECT * FROM workspace_records ORDER BY academyId,kind,id")
        .all(),
    );
    placementFindings();
    expect(
      JSON.stringify(
        database()
          .prepare("SELECT * FROM workspace_records ORDER BY academyId,kind,id")
          .all(),
      ),
    ).toBe(before);
    undo("plc-d", "plc-t");
  });
});
