// P1-05: enquiries before a player record exists. Owner and admin only; one
// enquiry converts into exactly one trial player; nothing is invoiced.
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
import { convertEnquiry, saveRecord, workspace } from "@/server/workspace-service";
import { visibleRecords } from "@/server/workspace-access";
import { trainingAction } from "@/server/training-service";
import { checkDataIntegrity } from "@/server/data-integrity";
import type { AcademyConfiguration, AcademyRole, WorkspaceEnquiry } from "@/domain/workspace";
import {
  actorFor,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-enquiries-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const form = (over: Record<string, unknown> = {}) => ({
  childName: "Fictional Prospect",
  guardianName: "Fictional Guardian",
  contact: "+910000000000",
  source: "Website",
  notes: "Asked about weekend batches.",
  followUpDate: "2026-12-05",
  ...over,
});
const create = (role: AcademyRole = "OWNER", over: Record<string, unknown> = {}) =>
  saveRecord(as(role), "enquiry", form(over)) as WorkspaceEnquiry;
const coach = () => memberId("COACH", academy);
const players = () => repo.list(academy.id, "player");

beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
});

describe("recording an enquiry", () => {
  it("owner and admin can record one", () => {
    const made = create("OWNER");
    expect(made).toMatchObject({
      childName: "Fictional Prospect",
      status: "OPEN",
      followUpDate: "2026-12-05",
      recordVersion: 1,
    });
    expect(create("ADMIN").status).toBe("OPEN");
  });
  it("coach, parent and support cannot record one", async () => {
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => create(role))).toBe(403);
    expect(repo.list(academy.id, "enquiry")).toEqual([]);
  });
  it("validates names, contact, date and the reason for closing", async () => {
    for (const bad of [
      { childName: "A" },
      { guardianName: "" },
      { contact: "12" },
      { followUpDate: "5 Dec" },
      { status: "CONVERTED" },
      { status: "CLOSED" },
      { notes: "x".repeat(2001) },
    ])
      expect(await statusOf(() => create("OWNER", bad))).toBe(-1);
    expect(create("OWNER", { status: "CLOSED", closedReason: "Moved away" }).closedReason).toBe(
      "Moved away",
    );
  });
  it("can be edited with its version, and a stale edit is refused", async () => {
    const made = create();
    const edited = saveRecord(
      as("OWNER"),
      "enquiry",
      form({ status: "WAITLIST", expectedVersion: made.recordVersion }),
      made.id,
    ) as WorkspaceEnquiry;
    expect(edited).toMatchObject({ status: "WAITLIST", recordVersion: 2 });
    expect(
      await statusOf(() =>
        saveRecord(as("ADMIN"), "enquiry", form({ expectedVersion: 1 }), made.id),
      ),
    ).toBe(409);
    expect(
      await statusOf(() => saveRecord(as("ADMIN"), "enquiry", form(), made.id)),
    ).toBe(409);
  });
});

describe("who can read enquiries", () => {
  it("owner and admin only: a child's name and a guardian's contact stay private", () => {
    const made = create();
    expect(visibleRecords(as("OWNER"), "enquiry").map((e) => e.id)).toEqual([made.id]);
    expect(visibleRecords(as("ADMIN"), "enquiry").map((e) => e.id)).toEqual([made.id]);
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const) {
      expect(visibleRecords(as(role), "enquiry")).toEqual([]);
      expect(JSON.stringify(workspace(as(role)))).not.toContain("Fictional Prospect");
    }
    expect(JSON.stringify(workspace(as("OWNER")))).toContain("Fictional Prospect");
  });
  it("never crosses academies", async () => {
    const made = create();
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(visibleRecords(actorFor("OWNER", other), "enquiry")).toEqual([]);
    expect(
      await statusOf(() =>
        convertEnquiry(actorFor("OWNER", other), made.id, { coachId: memberId("COACH", other), birthDate: "2015-03-02" }),
      ),
    ).toBe(404);
    expect(players()).toEqual([]);
  });
});

describe("converting an enquiry", () => {
  it("creates exactly one trial player for the chosen coach and links it", () => {
    const made = create();
    const result = convertEnquiry(as("OWNER"), made.id, {
      coachId: coach(),
      ageCategory: "U12",
      birthDate: "2015-03-02",
    });
    expect(result.created).toBe(true);
    expect(result.player).toMatchObject({
      name: "Fictional Prospect",
      status: "TRIAL",
      coachId: coach(),
      ageCategory: "U12",
      birthDate: "2015-03-02",
    });
    expect(result.enquiry).toMatchObject({
      status: "CONVERTED",
      convertedPlayerId: result.player.id,
    });
    expect(players()).toHaveLength(1);
  });
  it("is idempotent: converting again returns the same player and creates nothing", () => {
    const made = create();
    const first = convertEnquiry(as("OWNER"), made.id, { coachId: coach(), birthDate: "2015-03-02" });
    const second = convertEnquiry(as("ADMIN"), made.id, { coachId: coach(), birthDate: "2015-03-02" });
    expect(second.created).toBe(false);
    expect(second.player.id).toBe(first.player.id);
    expect(players()).toHaveLength(1);
  });
  it("can place the player in a batch in the same step", () => {
    repo.save(academy.id, "branch", {
      id: "b",
      academyId: academy.id,
      name: "Main",
      timezone: academy.timezone,
    });
    trainingAction(as("OWNER"), {
      requestId: randomUUID(),
      action: "squad",
      id: "sq",
      data: { name: "U12", branchId: "b", playerIds: [] },
    });
    const made = create();
    const { player } = convertEnquiry(as("OWNER"), made.id, { coachId: coach(), squadId: "sq", birthDate: "2015-03-02" });
    expect(player.squadId).toBe("sq");
    expect(repo.find(academy.id, "squad", "sq")!.playerIds).toEqual([player.id]);
  });
  it("is refused for a closed enquiry until it is reopened, and an edited converted one is locked", async () => {
    const closed = create("OWNER", { status: "CLOSED", closedReason: "Not interested" });
    expect(
      await statusOf(() => convertEnquiry(as("OWNER"), closed.id, { coachId: coach(), birthDate: "2015-03-02" })),
    ).toBe(409);
    saveRecord(
      as("OWNER"),
      "enquiry",
      form({ expectedVersion: closed.recordVersion }),
      closed.id,
    );
    const done = convertEnquiry(as("OWNER"), closed.id, { coachId: coach(), birthDate: "2015-03-02" });
    expect(
      await statusOf(() =>
        saveRecord(
          as("OWNER"),
          "enquiry",
          form({ expectedVersion: done.enquiry.recordVersion }),
          closed.id,
        ),
      ),
    ).toBe(409);
  });
  it("needs an owner or admin, an academy staff member as coach, and changes nothing otherwise", async () => {
    const made = create();
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const)
      expect(
        await statusOf(() => convertEnquiry(as(role), made.id, { coachId: coach(), birthDate: "2015-03-02" })),
      ).toBe(403);
    for (const coachId of [memberId("PARENT", academy), "nobody"])
      expect(
        await statusOf(() => convertEnquiry(as("OWNER"), made.id, { coachId, birthDate: "2015-03-02" })),
      ).toBe(400);
    expect(await statusOf(() => convertEnquiry(as("OWNER"), made.id, {}))).toBe(-1);
    expect(players()).toEqual([]);
    expect(repo.find(academy.id, "enquiry", made.id)!.status).toBe("OPEN");
  });
  it("is audited, and the converted player passes the integrity check", () => {
    const made = create();
    convertEnquiry(as("OWNER"), made.id, { coachId: coach(), birthDate: "2015-03-02" });
    const actions = database()
      .prepare("SELECT action FROM workspace_audit WHERE academyId=? AND resourceId=?")
      .all(academy.id, made.id)
      .map((r) => String(r.action));
    expect(actions).toContain("Enquiry converted to a trial player");
    expect(
      checkDataIntegrity(database()).filter(
        (f) => f.severity === "ERROR" && f.examples.some((e) => e.startsWith(academy.id)),
      ),
    ).toEqual([]);
  });
  it("the integrity check reports a converted enquiry whose player is missing", () => {
    database()
      .prepare("INSERT INTO workspace_records(academyId,kind,id,body) VALUES(?,?,?,?)")
      .run(
        academy.id,
        "enquiry",
        "orphan",
        JSON.stringify({
          id: "orphan",
          academyId: academy.id,
          status: "CONVERTED",
          convertedPlayerId: "ghost",
          childName: "x",
          guardianName: "y",
          contact: "z",
          source: "",
          notes: "",
          createdAt: "",
          updatedAt: "",
        }),
      );
    expect(
      checkDataIntegrity(database())
        .filter((f) => f.check === "converted enquiry points at a player that does not exist")
        .map((f) => f.examples[0]),
    ).toEqual([`${academy.id}/enquiry/orphan`]);
  });
});
