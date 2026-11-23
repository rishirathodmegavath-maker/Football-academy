// P1-10: an approved report can be withdrawn from families, with a reason, by
// an owner or admin; it stops being visible to parents at once, the update
// published from it is pulled back, and the withdrawal is recorded.
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
import { withdrawReport } from "@/server/workspace-service";
import { visibleRecords } from "@/server/workspace-access";
import type {
  AcademyConfiguration,
  WorkspaceReport,
  WorkspaceUpdate,
} from "@/domain/workspace";
import type { ReportViewModel } from "@/domain/report";
import {
  actorFor,
  linkGuardian,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-withdraw-${randomUUID()}.sqlite`);
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
const reason = "The attendance figures were wrong for two sessions.";
function seedApproved() {
  repo.save(academy.id, "player", {
    id: "child",
    academyId: academy.id,
    name: "Synthetic child",
    sportIds: ["football"],
    squad: "",
    squadId: "",
    coachId: memberId("COACH", academy),
  });
  linkGuardian(academy, memberId("PARENT", academy), "child");
  repo.save(academy.id, "report", {
    id: "rep",
    academyId: academy.id,
    sportId: "football",
    playerId: "child",
    planId: "",
    period: "2026-09",
    observation: "Reviewed observation.",
    evidenceType: "COACH_OBSERVATION",
    nextStep: "Practise receiving.",
    closingNote: "",
    status: "Approved",
    externalDeliveryStatus: "NOT_SENT",
    snapshot: {
      reportId: "rep",
      playerId: "child",
      academy: academy.name,
      player: "Synthetic child",
      period: "2026-09",
      status: "Approved",
      focus: "Receiving",
      practised: "Receiving drill",
      activities: [{ name: "Receiving drill", purpose: "Control", cue: "Soft touch" }],
      evidence: [{ text: "Reviewed observation.", source: "Coach" }],
      nextStep: "Practise receiving.",
    } as unknown as ReportViewModel,
    approvedPlan: undefined,
  } as WorkspaceReport);
  repo.save(academy.id, "update", {
    id: "upd",
    academyId: academy.id,
    sportId: "football",
    playerId: "child",
    planId: "",
    sourceReportId: "rep",
    type: "DEVELOPMENT",
    messageBody: "Reviewed update.",
    approvedBody: "Reviewed update.",
    approvalStatus: "APPROVED",
    inAppPublicationStatus: "PUBLISHED",
    externalDeliveryStatus: "NOT_SENT",
    version: 1,
    publishedGuardianIds: [memberId("PARENT", academy)],
  } as WorkspaceUpdate);
  database()
    .prepare(
      "INSERT INTO delivery_jobs(id,academyId,playerId,guardianId,type,sourceId,sourceVersion,period,correction,dueAt,expiresAt,state,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)",
    )
    .run(
      randomUUID(),
      academy.id,
      "child",
      memberId("PARENT", academy),
      "DEVELOPMENT",
      "upd",
      1,
      "2026-09",
      "",
      "2026-10-01T00:00:00Z",
      "2099-01-01T00:00:00Z",
      "QUEUED",
    );
}
const parentSees = (kind: "report" | "update") =>
  visibleRecords(actorFor("PARENT", academy), kind).map((r) => r.id);
const jobState = () =>
  String(
    database()
      .prepare("SELECT state FROM delivery_jobs WHERE academyId=? AND sourceId='upd'")
      .get(academy.id)?.state,
  );
beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
  seedApproved();
});

describe("withdrawing an approved report", () => {
  it("parents see the approved report and its update before the withdrawal", () => {
    expect(parentSees("report")).toEqual(["rep"]);
    expect(parentSees("update")).toEqual(["upd"]);
  });
  it("owner and admin can withdraw it; families stop seeing the report and its update at once", () => {
    const result = withdrawReport(actorFor("ADMIN", academy), "rep", { reason });
    expect(result.status).toBe("Revision Requested");
    expect(result.snapshot).toBeUndefined();
    expect(result.withdrawal).toMatchObject({
      reason,
      by: memberId("ADMIN", academy),
    });
    expect(parentSees("report")).toEqual([]);
    expect(parentSees("update")).toEqual([]);
    const update = repo.find(academy.id, "update", "upd")!;
    expect(update).toMatchObject({
      approvalStatus: "REJECTED",
      inAppPublicationStatus: "UNPUBLISHED",
    });
    expect(update.publishedGuardianIds).toEqual([]);
    expect(jobState()).toBe("CANCELLED");
  });
  it("records the withdrawal in the audit log, which keeps the reason", () => {
    withdrawReport(actorFor("OWNER", academy), "rep", { reason });
    const actions = database()
      .prepare("SELECT action FROM workspace_audit WHERE academyId=? AND resourceId=?")
      .all(academy.id, "rep")
      .map((r) => String(r.action));
    expect(actions).toContain(`Approved report withdrawn from families: ${reason}`);
  });
  it("needs a real reason", async () => {
    for (const bad of [{}, { reason: "" }, { reason: "too short" }, { reason: "x".repeat(1001) }])
      expect(
        await statusOf(() => withdrawReport(actorFor("OWNER", academy), "rep", bad)),
      ).toBe(-1); // a validation error, not an HTTP error
    expect(parentSees("report")).toEqual(["rep"]);
  });
  it("coach, parent and support cannot withdraw", async () => {
    for (const role of ["COACH", "PARENT", "SUPPORT"] as const)
      expect(
        await statusOf(() =>
          withdrawReport(actorFor(role, academy), "rep", { reason }),
        ),
      ).toBe(403);
    expect(parentSees("report")).toEqual(["rep"]);
  });
  it("only an approved report can be withdrawn, and not twice", async () => {
    withdrawReport(actorFor("OWNER", academy), "rep", { reason });
    expect(
      await statusOf(() =>
        withdrawReport(actorFor("OWNER", academy), "rep", { reason }),
      ),
    ).toBe(409);
  });
  it("refuses a stale version", async () => {
    const version = repo.find(academy.id, "report", "rep")!.recordVersion!;
    expect(
      await statusOf(() =>
        withdrawReport(actorFor("OWNER", academy), "rep", {
          reason,
          expectedVersion: version + 1,
        }),
      ),
    ).toBe(409);
    expect(parentSees("report")).toEqual(["rep"]);
  });
  it("never reaches another academy's report", async () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(
      await statusOf(() =>
        withdrawReport(actorFor("OWNER", other), "rep", { reason }),
      ),
    ).toBe(404);
    expect(parentSees("report")).toEqual(["rep"]);
  });
  it("never shows the internal withdrawal note to a family, even on an approved report that carries one", () => {
    repo.save(academy.id, "report", {
      ...repo.find(academy.id, "report", "rep")!,
      recordVersion: undefined,
      withdrawal: { at: "2026-10-01T00:00:00Z", by: "x", reason },
    } as WorkspaceReport);
    const seen = visibleRecords(actorFor("PARENT", academy), "report");
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(reason);
  });
  it("leaves unrelated updates alone", () => {
    repo.save(academy.id, "update", {
      ...repo.find(academy.id, "update", "upd")!,
      id: "other-upd",
      sourceReportId: "another-report",
    } as WorkspaceUpdate);
    withdrawReport(actorFor("OWNER", academy), "rep", { reason });
    expect(repo.find(academy.id, "update", "other-upd")).toMatchObject({
      approvalStatus: "APPROVED",
      inAppPublicationStatus: "PUBLISHED",
    });
  });
});
