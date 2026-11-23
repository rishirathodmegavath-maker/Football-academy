// Drill library, Stage 1 corrections. Each block answers one audited defect:
// complete immutable session snapshots (DL-001/DRL-DEF-01), frozen reports
// (DRL-DEF-05), no legacy duplicates (DL-007/DRL-DEF-02), revision history
// (DRL-DEF-04), Drill 13 age enforcement (DL-005), safety preserved through
// edits (DL-004), family-text limits (DL-006) and category validation (DL-008).
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
// A controlled catalogue: a test can publish a version 2 of a drill or retire
// one. Without an override the real, frozen catalogue answers.
const overrides = new Map<string, unknown | null>();
vi.mock("@/config/drills", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/config/drills")>();
  return {
    ...real,
    findUniversalDrill: (id: string) =>
      overrides.has(id)
        ? (overrides.get(id) ?? undefined)
        : real.findUniversalDrill(id),
    publishedDrills: () =>
      real
        .publishedDrills()
        .flatMap((d) =>
          overrides.has(d.id)
            ? overrides.get(d.id)
              ? [overrides.get(d.id)]
              : []
            : [d],
        ),
  };
});
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { assembleMonthly, periodAction } from "@/server/period-service";
import { monthlyReportSources } from "@/server/records-query";
import { approveReport, saveRecord } from "@/server/workspace-service";
import { trainingAction } from "@/server/training-service";
import {
  customiseDrill,
  drillHistory,
  isLegacyIncompleteSnapshot,
  resolveDrill,
  sessionDrillSnapshot,
  setDrillArchived,
  toAcademyContent,
  LEGACY_TEMPLATE_CATEGORY,
} from "@/server/drill-library-service";
import { visibleRecords } from "@/server/workspace-access";
import { operationalSports } from "@/config/sports/workspace-sports";
import { UNIVERSAL_CATALOGUE } from "@/config/drills";
import { PARENT_CUE_MAX, PARENT_PURPOSE_MAX } from "@/domain/drill-library";
import type { UniversalDrill } from "@/domain/drill-library";
import type { FootballSession } from "@/domain/training";
import type {
  AcademyConfiguration,
  AcademyRole,
  WorkspaceDrill,
  WorkspaceReport,
} from "@/domain/workspace";
import {
  actorFor,
  linkGuardian,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-drill-fixes-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* disposable */
    }
});

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const userOf = (role: AcademyRole) => memberId(role, academy);
const real = (id: string) => UNIVERSAL_CATALOGUE.find((d) => d.id === id)!;
const input = (over: Record<string, unknown> = {}) => ({
  name: "Synthetic passing box",
  category: "passing-combination-play",
  focusArea: "Passing",
  purpose: "Practise short passes in a small box.",
  cue: "Pass and move.",
  content: {
    description: "A small box for short passing.",
    steps: ["Pass to a teammate.", "Move to a new space."],
    safety: ["Keep the box clear of obstacles."],
  },
  ...over,
});
const create = (role: AcademyRole, over: Record<string, unknown> = {}) =>
  saveRecord(as(role), "drill", input(over)) as WorkspaceDrill;
const edit = (
  role: AcademyRole,
  drill: WorkspaceDrill,
  over: Record<string, unknown> = {},
) =>
  saveRecord(
    as(role),
    "drill",
    {
      name: drill.name,
      category: drill.category,
      focusArea: drill.focusArea,
      purpose: drill.purpose,
      cue: drill.cue,
      expectedVersion: drill.recordVersion,
      ...over,
    },
    drill.id,
  ) as WorkspaceDrill;
const act = (
  role: AcademyRole,
  action: string,
  data: unknown,
  extra: { id?: string; expectedVersion?: number } = {},
) =>
  trainingAction(as(role), { requestId: randomUUID(), action, data, ...extra });
const sessionData = (
  date: string,
  agenda: unknown[] = [],
  over: Record<string, unknown> = {},
) => ({
  branchId: "main",
  squadId: "squad-main",
  coachIds: [userOf("COACH")],
  timezone: academy.timezone,
  location: "Synthetic pitch",
  startLocal: `${date}T17:00`,
  endLocal: `${date}T18:00`,
  agenda,
  ...over,
});
const makeSession = (agenda: unknown[], date = "2026-12-10", over = {}) =>
  act("OWNER", "session", sessionData(date, agenda, over)) as FootballSession;
const player = (id: string, birthDate?: string) =>
  repo.save(academy.id, "player", {
    id,
    academyId: academy.id,
    name: `Player ${id}`,
    sportIds: ["football"],
    squad: "",
    squadId: "",
    coachId: userOf("COACH"),
    status: "ACTIVE",
    ...(birthDate ? { birthDate } : {}),
  });
const squadOf = (id: string, playerIds: string[]) =>
  act(
    "OWNER",
    "squad",
    { name: `Squad ${id}`, branchId: "main", playerIds },
    { id },
  );

/** Version 2 of Drill 16: every kind of content changes. */
function versionTwo(): UniversalDrill {
  const v2 = structuredClone(real("uni-016"));
  v2.contentVersion = 2;
  v2.purpose = "Version two purpose.";
  v2.cue = "Version two cue.";
  v2.content.equipment = ["V2 only equipment"];
  v2.content.setup = { layout: "V2 layout", dimensions: "V2 dimensions" };
  v2.content.steps = ["V2 only step"];
  v2.content.coachingPoints = ["V2 only coaching point"];
  v2.content.progressions = { easier: ["V2 easier"], harder: ["V2 harder"] };
  v2.content.safety = ["V2 only safety line"];
  v2.content.diagram = { ...v2.content.diagram, caption: "V2 only caption" };
  return v2;
}

beforeEach(() => {
  overrides.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T06:00:00Z"));
  academy = newAcademyConfig();
  seedAcademy(academy);
  repo.save(academy.id, "branch", {
    id: "main",
    academyId: academy.id,
    name: "Main branch",
    timezone: academy.timezone,
  });
  player("child");
  squadOf("squad-main", ["child"]);
  linkGuardian(academy, userOf("PARENT"), "child");
});

describe("DL-001 / DRL-DEF-01: a saved session reproduces the drill as it was", () => {
  it("a universal drill in a saved session is complete and independent of the catalogue", () => {
    const session = makeSession([{ drillId: "uni-016", duration: 15 }]);
    const drill = repo.find(academy.id, "session", session.id)!.agenda[0].drill;
    expect(drill.content).toEqual(toAcademyContent(real("uni-016")));
    expect(drill.content?.setup?.layout).toBeTruthy();
    expect(drill.content?.steps?.length).toBeGreaterThan(0);
    expect(drill.content?.coachingPoints?.length).toBeGreaterThan(0);
    expect(drill.content?.progressions?.easier?.length).toBeGreaterThan(0);
    expect(drill.content?.safety?.length).toBeGreaterThan(0);
    expect(drill.content?.diagram?.elements.length).toBeGreaterThan(0);
    expect(drill.snapshot).toMatchObject({
      source: "UNIVERSAL_CATALOGUE",
      contentVersion: 1,
      number: 16,
      objective: "Quick wall-passes and angle support.",
    });
    expect(drill.snapshot?.capturedAt).toMatch(/^2026-12-01T/);
    expect(isLegacyIncompleteSnapshot(drill)).toBe(false);
  });

  it("version 1 is reproduced exactly after the catalogue moves to version 2", () => {
    const session = makeSession([{ drillId: "uni-016", duration: 15 }]);
    const before = structuredClone(
      repo.find(academy.id, "session", session.id)!,
    );
    overrides.set("uni-016", versionTwo());
    // The live catalogue now answers with version 2 ...
    expect(resolveDrill(as("OWNER"), "uni-016").content?.steps).toEqual([
      "V2 only step",
    ]);
    // ... but the historical session still holds version 1, exactly.
    const after = visibleRecords(as("OWNER"), "session").find(
      (s) => s.id === session.id,
    )!;
    expect(after).toEqual(before);
    const text = JSON.stringify(after);
    for (const marker of [
      "V2 only step",
      "V2 only safety line",
      "V2 layout",
      "V2 only equipment",
      "V2 only coaching point",
      "V2 only caption",
      "Version two purpose.",
    ])
      expect(text).not.toContain(marker);
    // A coach assigned to the session reads the same snapshot.
    const asCoach = visibleRecords(as("COACH"), "session").find(
      (s) => s.id === session.id,
    )!;
    expect(asCoach.agenda[0].drill.content).toEqual(
      before.agenda[0].drill.content,
    );
    // A NEW session captures version 2.
    const fresh = makeSession(
      [{ drillId: "uni-016", duration: 15 }],
      "2026-12-11",
    );
    expect(fresh.agenda[0].drill.content?.steps).toEqual(["V2 only step"]);
    expect(fresh.agenda[0].drill.snapshot?.contentVersion).toBe(2);
    expect(fresh.agenda[0].drillVersion).toBe(2);
  });

  it("re-saving a draft keeps the snapshot it holds; only the duration follows", () => {
    const session = makeSession([{ drillId: "uni-016", duration: 15 }]);
    overrides.set("uni-016", versionTwo());
    const saved = act(
      "OWNER",
      "session",
      sessionData("2026-12-10", [{ drillId: "uni-016", duration: 25 }]),
      { id: session.id, expectedVersion: session.version },
    ) as FootballSession;
    expect(saved.agenda[0].duration).toBe(25);
    expect(saved.agenda[0].drill.content?.steps).not.toEqual(["V2 only step"]);
    expect(saved.agenda[0].drill.snapshot?.contentVersion).toBe(1);
  });

  it("a retired catalogue drill leaves history intact and is refused for new work", async () => {
    const session = makeSession([{ drillId: "uni-016", duration: 15 }]);
    const before = structuredClone(
      repo.find(academy.id, "session", session.id)!,
    );
    overrides.set("uni-016", null);
    expect(await statusOf(() => resolveDrill(as("OWNER"), "uni-016"))).toBe(
      404,
    );
    expect(
      await statusOf(() =>
        makeSession([{ drillId: "uni-016", duration: 15 }], "2026-12-12"),
      ),
    ).toBe(404);
    expect(
      visibleRecords(as("OWNER"), "session").find((s) => s.id === session.id),
    ).toEqual(before);
  });

  it("an academy drill in a saved session survives later edits and archiving", () => {
    const own = create("OWNER", {
      content: {
        description: "V1 description",
        steps: ["V1 step"],
        safety: ["V1 safety"],
      },
    });
    const session = makeSession([{ drillId: own.id, duration: 20 }]);
    const before = structuredClone(
      repo.find(academy.id, "session", session.id)!,
    );
    expect(before.agenda[0].drill.content).toMatchObject({
      description: "V1 description",
      steps: ["V1 step"],
      safety: ["V1 safety"],
    });
    expect(before.agenda[0].drill.snapshot?.source).toBe("ACADEMY_DRILL");
    const v2 = edit("OWNER", own, {
      purpose: "Changed purpose.",
      content: {
        description: "V2 description",
        steps: ["V2 step"],
        safety: ["V2 safety"],
      },
    });
    setDrillArchived(as("OWNER"), own.id, true, v2.recordVersion);
    const after = visibleRecords(as("OWNER"), "session").find(
      (s) => s.id === session.id,
    )!;
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("V2 step");
  });

  it("a customised copy keeps its snapshot after the copy and the catalogue change", () => {
    const { drill: copy } = customiseDrill(as("OWNER"), "uni-016");
    const session = makeSession([{ drillId: copy.id, duration: 15 }]);
    const before = structuredClone(
      repo.find(academy.id, "session", session.id)!,
    );
    edit("OWNER", copy, { content: { steps: ["Our own step"] } });
    overrides.set("uni-016", versionTwo());
    expect(
      visibleRecords(as("OWNER"), "session").find((s) => s.id === session.id),
    ).toEqual(before);
  });

  it("an older slim snapshot is kept as it is, labelled, and never filled from today's catalogue", () => {
    const slim: WorkspaceDrill = {
      id: "uni-016",
      academyId: academy.id,
      sportId: "football",
      name: "Three-Player Passing Triangles",
      focusArea: "Passing",
      purpose: "Old purpose",
      cue: "Old cue",
      ownership: "UNIVERSAL_CATALOGUE",
      templateId: "uni-016",
      category: "passing-combination-play",
      status: "ACTIVE",
      universalVersion: 1,
    };
    repo.save(academy.id, "session", {
      id: "legacy-session",
      academyId: academy.id,
      sportId: "football",
      version: 1,
      updatedAt: "2026-11-01T00:00:00.000Z",
      updatedBy: userOf("OWNER"),
      branchId: "main",
      squadId: "squad-main",
      location: "Pitch",
      coachIds: [userOf("COACH")],
      timezone: academy.timezone,
      startLocal: "2026-12-20T17:00",
      endLocal: "2026-12-20T18:00",
      startAt: "2026-12-20T11:30:00.000Z",
      endAt: "2026-12-20T12:30:00.000Z",
      theme: "",
      status: "DRAFT",
      roster: [{ playerId: "child", name: "Player child" }],
      agenda: [{ drill: slim, duration: 15, drillVersion: 1 }],
      objectives: [],
    } as FootballSession);
    const read = visibleRecords(as("OWNER"), "session").find(
      (s) => s.id === "legacy-session",
    )!;
    expect(isLegacyIncompleteSnapshot(read.agenda[0].drill)).toBe(true);
    expect(read.agenda[0].drill.content).toBeUndefined();
    // Re-saving the draft preserves the legacy record: nothing is fabricated.
    const saved = act(
      "OWNER",
      "session",
      sessionData("2026-12-20", [{ drillId: "uni-016", duration: 20 }]),
      { id: "legacy-session", expectedVersion: 1 },
    ) as FootballSession;
    expect(saved.agenda[0].drill.content).toBeUndefined();
    expect(saved.agenda[0].drill.snapshot).toBeUndefined();
    expect(saved.agenda[0].drill.purpose).toBe("Old purpose");
  });

  it("a snapshot taken from a copy cannot be changed through the copy's record", () => {
    const own = create("OWNER");
    const snap = sessionDrillSnapshot(
      as("OWNER"),
      resolveDrill(as("OWNER"), own.id),
    );
    snap.content!.steps!.push("tamper");
    expect(repo.find(academy.id, "drill", own.id)!.content!.steps).toHaveLength(
      2,
    );
  });
});

describe("DRL-DEF-05: an approved report is frozen", () => {
  function completedSession() {
    const universal = sessionDrillSnapshot(
      as("OWNER"),
      resolveDrill(as("OWNER"), "uni-016"),
    );
    repo.save(academy.id, "session", {
      id: "past-session",
      academyId: academy.id,
      sportId: "football" as const,
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      updatedBy: userOf("OWNER"),
      branchId: "main",
      squadId: "squad-main",
      location: "Synthetic pitch",
      coachIds: [userOf("COACH")],
      timezone: academy.timezone,
      startLocal: "2026-10-10T17:00",
      endLocal: "2026-10-10T18:00",
      startAt: "2026-10-10T11:30:00.000Z",
      endAt: "2026-10-10T12:30:00.000Z",
      theme: "Passing",
      status: "COMPLETED" as const,
      roster: [{ playerId: "child", name: "Player child" }],
      agenda: [{ drill: universal, duration: 15, drillVersion: 1 }],
      objectives: [],
    });
    repo.save(academy.id, "attendance", {
      id: "past-session:child",
      academyId: academy.id,
      sportId: "football",
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      updatedBy: userOf("OWNER"),
      sessionId: "past-session",
      playerId: "child",
      status: "PRESENT",
      correctionReason: "",
    });
  }
  it("a monthly report built later still carries the purpose and cue the session was saved with", () => {
    completedSession();
    const first = assembleMonthly(as("OWNER"), "child", "2026-10");
    overrides.set("uni-016", versionTwo());
    const second = assembleMonthly(as("OWNER"), "child", "2026-10");
    expect(second.model.activities).toEqual(first.model.activities);
    expect(JSON.stringify(second.model)).not.toContain("Version two");
  });
  it("the sources behind an approved report never resolve the live catalogue", () => {
    completedSession();
    const monthly = assembleMonthly(as("OWNER"), "child", "2026-10");
    const approved = {
      id: "report-1",
      status: "Approved",
      playerId: "child",
      monthlySources: {
        sessionIds: ["past-session"],
        evidenceIds: [],
        model: monthly.model,
      },
    } as unknown as WorkspaceReport;
    const focus = real("uni-016").focusArea;
    const sources = (r: WorkspaceReport) =>
      monthlyReportSources(as("OWNER"), r).drills;
    expect(sources(approved)).toEqual([{ id: "uni-016", focusArea: focus }]);
    // The drill changes focus in the catalogue, then is retired entirely.
    overrides.set("uni-016", { ...versionTwo(), focusArea: "Dribbling" });
    expect(sources(approved)).toEqual([{ id: "uni-016", focusArea: focus }]);
    overrides.set("uni-016", null);
    expect(sources(approved)).toEqual([{ id: "uni-016", focusArea: focus }]);
    // A draft report with a drill that no saved session holds is the only case
    // that consults the catalogue; the approved one never does.
    const planOnly = {
      ...approved,
      monthlySources: {
        ...approved.monthlySources!,
        sessionIds: [],
        model: {
          ...monthly.model,
          activities: [{ ...monthly.model.activities[0] }],
        },
      },
    } as unknown as WorkspaceReport;
    overrides.delete("uni-016");
    expect(
      sources({ ...planOnly, status: "Draft" } as WorkspaceReport),
    ).toEqual([{ id: "uni-016", focusArea: focus }]);
    expect(sources(planOnly)).toEqual([]);
  });
});

// Acceptance preparation, item 3: an approved report must not depend on the
// CURRENT academy drill record either (the earlier tests cover the catalogue).
describe("an approved report is frozen against later changes to an academy drill", () => {
  const month = "2026-10";
  // A completed October session with attendance, holding this drill's snapshot.
  function sessionWith(drill: WorkspaceDrill, sessionId: string) {
    repo.save(academy.id, "session", {
      id: sessionId,
      academyId: academy.id,
      sportId: "football" as const,
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      updatedBy: userOf("OWNER"),
      branchId: "main",
      squadId: "squad-main",
      location: "Synthetic pitch",
      coachIds: [userOf("COACH")],
      timezone: academy.timezone,
      startLocal: "2026-10-10T17:00",
      endLocal: "2026-10-10T18:00",
      startAt: "2026-10-10T11:30:00.000Z",
      endAt: "2026-10-10T12:30:00.000Z",
      theme: "Passing",
      status: "COMPLETED" as const,
      roster: [{ playerId: "child", name: "Player child" }],
      agenda: [
        {
          drill: sessionDrillSnapshot(
            as("OWNER"),
            resolveDrill(as("OWNER"), drill.id),
          ),
          duration: 15,
          drillVersion: 1,
        },
      ],
      objectives: [],
    });
    repo.save(academy.id, "attendance", {
      id: `${sessionId}:child`,
      academyId: academy.id,
      sportId: "football",
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      updatedBy: userOf("OWNER"),
      sessionId,
      playerId: "child",
      status: "PRESENT",
      correctionReason: "",
    });
  }
  const period = (
    action: string,
    data: unknown,
    extra: { id?: string; expectedVersion?: number } = {},
  ) =>
    periodAction(as("OWNER"), {
      requestId: randomUUID(),
      action,
      data,
      ...extra,
    });
  function prepareAndApprove() {
    const [prepared] = period("monthlyPrepare", {
      playerIds: ["child"],
      month,
    }) as WorkspaceReport[];
    const saved = repo.find(academy.id, "report", prepared.id)!;
    period(
      "monthlyEdit",
      {
        observation: "",
        closingNote: "",
        nextStep: "Keep practising short passes.",
      },
      { id: saved.id, expectedVersion: saved.recordVersion },
    );
    const draft = repo.find(academy.id, "report", prepared.id)!;
    approveReport(as("OWNER"), draft.id, true, draft.recordVersion);
    return repo.find(academy.id, "report", prepared.id)!;
  }
  const focusOf = (report: WorkspaceReport) =>
    monthlyReportSources(as("OWNER"), report).drills;

  it("an academy drill's focus area stays as approved after the drill is edited, then archived", () => {
    // 1. Create an academy drill. 2. Create and approve a report referencing it.
    const drill = create("OWNER", { focusArea: "Passing" });
    sessionWith(drill, "frozen-1");
    const approved = prepareAndApprove();
    expect(approved.status).toBe("Approved");
    expect(
      approved.monthlySources!.model.activities.map((a) => a.drillId),
    ).toEqual([drill.id]);
    expect(focusOf(approved)).toEqual([{ id: drill.id, focusArea: "Passing" }]);
    // 3. Change the current academy drill's focus area.
    const changed = edit("OWNER", drill, { focusArea: "Dribbling" });
    expect(repo.find(academy.id, "drill", drill.id)!.focusArea).toBe(
      "Dribbling",
    );
    expect(changed.focusArea).toBe("Dribbling");
    // 4. Retrieve the approved report: 5. it still uses the approved value.
    const reread = repo.find(academy.id, "report", approved.id)!;
    expect(focusOf(reread)).toEqual([{ id: drill.id, focusArea: "Passing" }]);
    // The stored frozen value itself is what answers, not a lookup.
    expect(reread.monthlySources!.drillFocus).toEqual([
      { id: drill.id, focusArea: "Passing" },
    ]);
    // Archiving the drill changes nothing either.
    setDrillArchived(
      as("OWNER"),
      drill.id,
      true,
      repo.find(academy.id, "drill", drill.id)!.recordVersion,
    );
    expect(focusOf(repo.find(academy.id, "report", approved.id)!)).toEqual([
      { id: drill.id, focusArea: "Passing" },
    ]);
  });

  it("the frozen value answers even when no visible session holds the drill", () => {
    const drill = create("OWNER", { focusArea: "Passing" });
    sessionWith(drill, "frozen-2");
    const approved = prepareAndApprove();
    edit("OWNER", drill, { focusArea: "Dribbling" });
    const withoutSessions = {
      ...approved,
      monthlySources: { ...approved.monthlySources!, sessionIds: [] },
    } as WorkspaceReport;
    expect(focusOf(withoutSessions)).toEqual([
      { id: drill.id, focusArea: "Passing" },
    ]);
  });

  it("an approved report saved before the frozen value existed never reads the live academy drill", () => {
    const drill = create("OWNER", { focusArea: "Passing" });
    sessionWith(drill, "frozen-3");
    const approved = prepareAndApprove();
    edit("OWNER", drill, { focusArea: "Dribbling" });
    const { drillFocus: _frozen, ...legacySources } = approved.monthlySources!;
    void _frozen;
    // No frozen value and no session to read: nothing is invented from today's record.
    const legacy = {
      ...approved,
      monthlySources: { ...legacySources, sessionIds: [] },
    } as WorkspaceReport;
    expect(focusOf(legacy)).toEqual([]);
    // With its saved session the session's own snapshot answers.
    expect(
      focusOf({
        ...approved,
        monthlySources: legacySources,
      } as WorkspaceReport),
    ).toEqual([{ id: drill.id, focusArea: "Passing" }]);
  });

  it("a draft report may still show today's value (only an approved one is frozen)", () => {
    const drill = create("OWNER", { focusArea: "Passing" });
    sessionWith(drill, "frozen-4");
    const [prepared] = period("monthlyPrepare", {
      playerIds: ["child"],
      month,
    }) as WorkspaceReport[];
    const draft = repo.find(academy.id, "report", prepared.id)!;
    edit("OWNER", drill, { focusArea: "Dribbling" });
    const noSessions = {
      ...draft,
      monthlySources: {
        ...draft.monthlySources!,
        sessionIds: [],
        drillFocus: undefined,
      },
    } as WorkspaceReport;
    expect(focusOf(noSessions)).toEqual([
      { id: drill.id, focusArea: "Dribbling" },
    ]);
  });
});

describe("DL-007 / DRL-DEF-02: a legacy template can no longer make duplicates", () => {
  const template = operationalSports.football.templates[0];
  const request = (role: AcademyRole = "COACH") =>
    saveRecord(as(role), "drill", {
      ...template,
      sportId: "football",
      templateId: template.id,
    }) as WorkspaceDrill;
  it("every legacy template has a category, so none can be created uncategorised", () => {
    for (const t of operationalSports.football.templates)
      expect(LEGACY_TEMPLATE_CATEGORY[t.id], t.id).toBeTruthy();
  });
  it("repeated, refreshed and concurrent requests return one categorised drill", async () => {
    const first = request();
    expect(first.id).toBe(`from-tpl-${template.id}`);
    expect(first.category).toBe("ball-control-dribbling");
    const results = await Promise.all(
      Array.from({ length: 6 }, async (_, i) =>
        request(i % 2 ? "COACH" : "OWNER"),
      ),
    );
    for (const r of results) expect(r.id).toBe(first.id);
    expect(
      repo
        .list(academy.id, "drill")
        .filter((d) => d.templateId === template.id),
    ).toHaveLength(1);
    expect(
      database()
        .prepare(
          "SELECT COUNT(*) AS n FROM workspace_records WHERE academyId=? AND kind='drillrevision' AND json_extract(body,'$.drillId')=?",
        )
        .get(academy.id, first.id)?.n,
    ).toBe(1);
  });
  it("records made the old way stay readable, editable and unchanged", () => {
    repo.save(academy.id, "drill", {
      id: "older-random-copy",
      academyId: academy.id,
      sportId: "football",
      name: template.name,
      focusArea: template.focusArea,
      purpose: template.purpose,
      cue: template.cue,
      ownership: "ACADEMY_CURRICULUM",
      templateId: template.id,
    } as WorkspaceDrill);
    const seen = visibleRecords(as("OWNER"), "drill").find(
      (d) => d.id === "older-random-copy",
    )!;
    expect(seen.category).toBeUndefined();
    // Editing it keeps its own id; it is not remapped to the deterministic one.
    const edited = edit("OWNER", seen, { category: "ball-control-dribbling" });
    expect(edited.id).toBe("older-random-copy");
    expect(
      repo.find(academy.id, "drill", `from-tpl-${template.id}`),
    ).toBeUndefined();
  });
  it("the Development Plan screen no longer offers the copy button", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "src/features/workspaces/plan-and-report.tsx",
      "utf8",
    );
    expect(source).not.toContain("Copy drill template");
  });
});

describe("DL-008: a new drill needs a valid category", () => {
  it("is refused with a field-specific message, over every input shape", async () => {
    const { category: _c, ...withoutCategory } = input();
    void _c;
    const missing = await (async () => {
      try {
        saveRecord(as("OWNER"), "drill", withoutCategory);
      } catch (e) {
        return e as Error & { status: number };
      }
    })();
    expect(missing?.status).toBe(400);
    expect(missing?.message).toMatch(/^Category:/);
    expect(await statusOf(() => create("OWNER", { category: "" }))).toBe(400);
    expect(await statusOf(() => create("OWNER", { category: "agility" }))).toBe(
      400,
    );
    expect(repo.list(academy.id, "drill")).toHaveLength(0);
  });
  it("a legacy record without a category still reads as legacy", () => {
    repo.save(academy.id, "drill", {
      id: "legacy",
      academyId: academy.id,
      sportId: "football",
      name: "Old",
      focusArea: "Passing",
      purpose: "p",
      cue: "c",
      ownership: "ACADEMY_CURRICULUM",
    } as WorkspaceDrill);
    expect(visibleRecords(as("OWNER"), "drill")[0].category).toBeUndefined();
  });
});

describe("DL-006: family-facing text limits are enforced for every drill", () => {
  const message = async (over: Record<string, unknown>) => {
    try {
      create("OWNER", over);
    } catch (e) {
      return e as Error & { status: number };
    }
  };
  it("refuses a purpose or cue over the limit, with a field message and no truncation", async () => {
    const longPurpose = await message({
      purpose: "x".repeat(PARENT_PURPOSE_MAX + 1),
    });
    expect(longPurpose?.status).toBe(400);
    expect(longPurpose?.message).toMatch(/^Purpose:.*160/);
    const longCue = await message({ cue: "y".repeat(PARENT_CUE_MAX + 1) });
    expect(longCue?.status).toBe(400);
    expect(longCue?.message).toMatch(/^Coaching cue:.*120/);
    expect(
      (await message({ purpose: "z".repeat(5000), cue: "z".repeat(5000) }))
        ?.status,
    ).toBe(400);
    expect(repo.list(academy.id, "drill")).toHaveLength(0);
  });
  it("accepts exactly the limit and stores it untouched", () => {
    const purpose = "p".repeat(PARENT_PURPOSE_MAX),
      cue = "c".repeat(PARENT_CUE_MAX);
    const saved = create("OWNER", { purpose, cue });
    expect(saved.purpose).toBe(purpose);
    expect(saved.cue).toBe(cue);
  });
  it("applies to edits, and an over-long edit changes nothing", async () => {
    const drill = create("OWNER");
    expect(
      await statusOf(() => edit("OWNER", drill, { purpose: "x".repeat(300) })),
    ).toBe(400);
    expect(repo.find(academy.id, "drill", drill.id)!.purpose).toBe(
      drill.purpose,
    );
  });
  it("holds for every published catalogue drill, so a customised copy is always valid", () => {
    for (const d of UNIVERSAL_CATALOGUE.filter(
      (u) => u.status === "PUBLISHED",
    )) {
      expect(d.purpose.length, `drill ${d.number} purpose`).toBeLessThanOrEqual(
        PARENT_PURPOSE_MAX,
      );
      expect(d.cue.length, `drill ${d.number} cue`).toBeLessThanOrEqual(
        PARENT_CUE_MAX,
      );
    }
    expect(() => customiseDrill(as("OWNER"), "uni-013")).not.toThrow();
  });
});

describe("DL-004: safety guidance cannot be erased by an edit", () => {
  for (const [number, id] of [
    [13, "uni-013"],
    [34, "uni-034"],
    [43, "uni-043"],
  ] as const) {
    it(`Drill ${number}: a partial or blank edit of the copy keeps every inherited safety line`, () => {
      const catalogueSafety = real(id).content.safety;
      const { drill: copy } = customiseDrill(as("OWNER"), id);
      expect(copy.lockedSafety).toEqual(catalogueSafety);
      expect(copy.content?.safety).toEqual(catalogueSafety);
      // 1. A partial edit that does not mention safety.
      const partial = edit("OWNER", copy, {
        content: { description: "Our wording." },
      });
      expect(partial.content?.safety).toEqual(catalogueSafety);
      expect(partial.content?.steps).toEqual(real(id).content.steps);
      expect(partial.content?.description).toBe("Our wording.");
      // 2. A blank safety list.
      const blank = edit("OWNER", partial, { content: { safety: [] } });
      expect(blank.content?.safety).toEqual(catalogueSafety);
      // 3. An edit that drops some lines and adds one of its own.
      const changed = edit("OWNER", blank, {
        content: { safety: ["Our extra line."] },
      });
      expect(changed.content?.safety).toEqual([
        ...catalogueSafety,
        "Our extra line.",
      ]);
      // The locked lines never change and the extra can later be removed.
      const removed = edit("OWNER", changed, { content: { safety: [] } });
      expect(removed.content?.safety).toEqual(catalogueSafety);
      expect(removed.lockedSafety).toEqual(catalogueSafety);
    });
  }
  it("a partial edit keeps every field it does not name", () => {
    const drill = create("OWNER");
    const next = edit("OWNER", drill, {
      content: { description: "Only this changes." },
    });
    expect(next.content).toMatchObject({
      description: "Only this changes.",
      steps: ["Pass to a teammate.", "Move to a new space."],
      safety: ["Keep the box clear of obstacles."],
    });
  });
  it("an academy-created drill cannot be left with no safety line", async () => {
    const drill = create("OWNER");
    const blank = async (content: unknown) => {
      try {
        edit("OWNER", drill, { content });
      } catch (e) {
        return e as Error & { status: number };
      }
    };
    for (const content of [{ safety: [] }, { description: "x", safety: [] }]) {
      const error = await blank(content);
      expect(error?.status).toBe(400);
      expect(error?.message).toMatch(/^Safety:/);
    }
    expect(
      (
        await (async () => {
          try {
            create("OWNER", { content: { description: "no safety" } });
          } catch (e) {
            return e as { status: number };
          }
        })()
      )?.status,
    ).toBe(400);
    expect(repo.find(academy.id, "drill", drill.id)!.content!.safety).toEqual([
      "Keep the box clear of obstacles.",
    ]);
  });
  it("a copy made before safety lines were stored regains them from its source", () => {
    const { drill: copy } = customiseDrill(as("OWNER"), "uni-034");
    const { lockedSafety: _l, ...older } = copy;
    void _l;
    repo.save(academy.id, "drill", {
      ...older,
      content: { ...older.content, safety: ["Only mine."] },
    });
    const stored = repo.find(academy.id, "drill", copy.id)!;
    const next = edit("OWNER", stored, { content: { description: "Edited." } });
    expect(next.lockedSafety).toEqual(real("uni-034").content.safety);
    expect(next.content?.safety).toEqual([
      ...real("uni-034").content.safety,
      "Only mine.",
    ]);
  });
});

describe("DL-005: Drill 13 minimum age is enforced on the server", () => {
  beforeEach(() => {
    // A player belongs to one squad, so each squad has its own players.
    for (const id of ["ok12", "ok12b", "ok12c", "ok12d"])
      player(id, "2014-06-01"); // 12 on 10 Dec 2026
    player("p11", "2015-06-01"); // 11
    player("pNone"); // no date of birth
    player("pBad", "not-a-date");
    squadOf("sq-12", ["ok12"]);
    squadOf("sq-11", ["ok12b", "p11"]);
    squadOf("sq-none", ["ok12c", "pNone"]);
    squadOf("sq-bad", ["ok12d", "pBad"]);
  });
  const drill13 = [{ drillId: "uni-013", duration: 10 }];
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as Error & { status: number };
    }
  };
  it("allows a roster in which every player is 12 or over", () => {
    const s = makeSession(drill13, "2026-12-10", { squadId: "sq-12" });
    expect(s.roster.map((p) => p.playerId)).toEqual(["ok12"]);
    expect(s.agenda[0].drill.minimumAge).toEqual({
      years: 12,
      basis: "INTERNAL_PRODUCT_POLICY",
    });
  });
  it("blocks a roster with a player under 12, naming the rule and the player", () => {
    const e = refusal(() =>
      makeSession(drill13, "2026-12-10", { squadId: "sq-11" }),
    );
    expect(e?.status).toBe(409);
    expect(e?.message).toContain("Blindfold Soccer Movements");
    expect(e?.message).toContain("Player p11 (age 11)");
    expect(e?.message).toContain("internal Sportozen safeguarding rule");
    expect(e?.message).toContain("not an association rule");
  });
  it("blocks a missing or unreadable date of birth: it is not assumed", () => {
    expect(
      refusal(() => makeSession(drill13, "2026-12-10", { squadId: "sq-none" }))
        ?.message,
    ).toContain("no valid date of birth recorded");
    expect(
      refusal(() => makeSession(drill13, "2026-12-10", { squadId: "sq-bad" }))
        ?.message,
    ).toContain("no valid date of birth recorded");
  });
  it("judges age on the session date, not on today", () => {
    player("turns12", "2014-12-20");
    squadOf("sq-turns", ["turns12"]);
    expect(
      refusal(() => makeSession(drill13, "2026-12-10", { squadId: "sq-turns" }))
        ?.status,
    ).toBe(409);
    expect(
      makeSession(drill13, "2026-12-21", { squadId: "sq-turns" }).id,
    ).toBeTruthy();
  });
  it("nothing was saved by a blocked attempt", () => {
    const before = repo.list(academy.id, "session").length;
    refusal(() => makeSession(drill13, "2026-12-11", { squadId: "sq-11" }));
    expect(repo.list(academy.id, "session")).toHaveLength(before);
  });
  it("a copy of Drill 13 keeps the rule, and an edit cannot remove it", () => {
    const { drill: copy } = customiseDrill(as("OWNER"), "uni-013");
    expect(copy.minimumAge).toEqual({
      years: 12,
      basis: "INTERNAL_PRODUCT_POLICY",
    });
    const edited = edit("OWNER", copy, { content: { description: "Ours." } });
    expect(edited.minimumAge).toEqual(copy.minimumAge);
    expect(
      refusal(() =>
        makeSession([{ drillId: copy.id, duration: 10 }], "2026-12-12", {
          squadId: "sq-11",
        }),
      )?.status,
    ).toBe(409);
    expect(
      makeSession([{ drillId: copy.id, duration: 10 }], "2026-12-13", {
        squadId: "sq-12",
      }).id,
    ).toBeTruthy();
    // Even a copy stored without the field is judged by its source.
    const { minimumAge: _m, ...bare } = edited;
    void _m;
    repo.save(academy.id, "drill", bare);
    expect(
      refusal(() =>
        makeSession([{ drillId: copy.id, duration: 10 }], "2026-12-14", {
          squadId: "sq-11",
        }),
      )?.status,
    ).toBe(409);
  });
  it("scheduling or starting re-checks a draft whose player data changed", () => {
    const draft = makeSession(drill13, "2026-12-15", { squadId: "sq-12" });
    // The recorded date of birth is corrected to a younger child.
    player("ok12", "2016-01-01");
    const e = refusal(() =>
      act(
        "OWNER",
        "status",
        { status: "SCHEDULED" },
        { id: draft.id, expectedVersion: draft.version },
      ),
    );
    expect(e?.message).toContain("aged 12 or over");
    expect(e?.status).toBe(409);
    expect(repo.find(academy.id, "session", draft.id)!.status).toBe("DRAFT");
  });
  it("a recurring series is blocked by the same rule", () => {
    const body = (squadId: string) => ({
      branchId: "main",
      squadId,
      location: "Synthetic pitch",
      coachIds: [userOf("COACH")],
      timezone: academy.timezone,
      weekdays: [1, 3],
      startDate: "2026-12-14",
      endDate: "2026-12-30",
      startTime: "17:00",
      endTime: "18:00",
      theme: "Balance",
      agenda: drill13,
      exclusions: [],
    });
    const e = refusal(() =>
      act("OWNER", "series", body("sq-11"), { id: randomUUID() }),
    );
    expect(e?.status).toBe(409);
    expect(
      repo.list(academy.id, "session").filter((s) => s.seriesId),
    ).toHaveLength(0);
    expect(() =>
      act("OWNER", "series", body("sq-12"), { id: randomUUID() }),
    ).not.toThrow();
  });
  it("a development plan for a child under 12 cannot use it", () => {
    const plan = (playerId: string) => ({
      playerId,
      sportId: "football",
      coachId: userOf("COACH"),
      focus: "Receiving",
      reason: "Reviewed comparable attempts.",
      drillIds: ["uni-013"],
      observe: "Observe balance.",
      homePractice: "",
      reviewDate: "2026-12-31",
      nextStep: "Review",
      status: "ACTIVE",
      privateNote: "",
    });
    expect(
      refusal(() => saveRecord(as("OWNER"), "plan", plan("p11")))?.status,
    ).toBe(409);
    expect(
      refusal(() => saveRecord(as("OWNER"), "plan", plan("pNone")))?.status,
    ).toBe(409);
    expect(
      refusal(() => saveRecord(as("OWNER"), "plan", plan("ok12"))),
    ).toBeUndefined();
  });
  it("other drills are unaffected", () => {
    expect(
      makeSession([{ drillId: "uni-016", duration: 10 }], "2026-12-16", {
        squadId: "sq-11",
      }).id,
    ).toBeTruthy();
  });
});

describe("DRL-DEF-04: academy drill revision history", () => {
  it("records creation, edits, archiving and restoring in order", () => {
    const drill = create("COACH");
    const edited = edit("COACH", drill, { purpose: "A clearer purpose." });
    const archived = setDrillArchived(
      as("COACH"),
      drill.id,
      true,
      edited.recordVersion,
    );
    setDrillArchived(as("OWNER"), drill.id, false, archived.recordVersion);
    const { revisions } = drillHistory(as("COACH"), drill.id);
    expect(revisions.map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(revisions.map((r) => r.context)).toEqual([
      "Restored",
      "Archived",
      "Edited",
      "Created",
    ]);
    expect(revisions[3].before).toBeNull();
    expect(revisions[2].before?.purpose).toBe(drill.purpose);
    expect(revisions[2].after.purpose).toBe("A clearer purpose.");
    expect(revisions[2].changedFields).toEqual(["purpose"]);
    expect(revisions[0].actorId).toBe(userOf("OWNER"));
    expect(revisions[0].actorRole).toBe("OWNER");
    expect(revisions[1].changedFields).toEqual(["status"]);
    expect(
      revisions.every((r) => r.id.startsWith(`${drill.id}:`) && !!r.at),
    ).toBe(true);
  });
  it("records the content that changed and what it was before", () => {
    const drill = create("OWNER");
    edit("OWNER", drill, { content: { steps: ["Only step."] } });
    const latest = drillHistory(as("OWNER"), drill.id).revisions[0];
    expect(latest.changedFields).toEqual(["content.steps"]);
    expect(latest.before?.content?.steps).toEqual([
      "Pass to a teammate.",
      "Move to a new space.",
    ]);
    expect(latest.after.content?.steps).toEqual(["Only step."]);
  });
  it("a customised copy starts with a revision naming its source", () => {
    const { drill } = customiseDrill(as("COACH"), "uni-016");
    const [first] = drillHistory(as("COACH"), drill.id).revisions;
    expect(first.context).toBe(
      "Customised from universal Drill 16 (content version 1)",
    );
    customiseDrill(as("COACH"), "uni-016");
    expect(drillHistory(as("COACH"), drill.id).revisions).toHaveLength(1);
  });
  it("a drill that existed before history gets a baseline, so the start is never lost", () => {
    repo.save(academy.id, "drill", {
      id: "old",
      academyId: academy.id,
      sportId: "football",
      name: "Old drill",
      focusArea: "Passing",
      purpose: "Old purpose",
      cue: "Old cue",
      ownership: "ACADEMY_CURRICULUM",
      category: "passing-combination-play",
    } as WorkspaceDrill);
    const old = repo.find(academy.id, "drill", "old")!;
    edit("OWNER", old, { purpose: "New purpose" });
    const revisions = drillHistory(as("OWNER"), "old").revisions;
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(revisions[1].context).toMatch(/^Baseline/);
    expect(revisions[1].after.purpose).toBe("Old purpose");
    expect(revisions[0].before?.purpose).toBe("Old purpose");
  });
  it("earlier revisions are never rewritten by later activity", () => {
    const drill = create("OWNER");
    const snapshot = () =>
      database()
        .prepare(
          "SELECT id,body FROM workspace_records WHERE academyId=? AND kind='drillrevision' ORDER BY id",
        )
        .all(academy.id)
        .map((r) => `${r.id}=${r.body}`);
    const first = snapshot();
    const v2 = edit("OWNER", drill, { purpose: "Two." });
    edit("OWNER", v2, { purpose: "Three." });
    expect(snapshot().slice(0, first.length)).toEqual(first);
    // The table itself refuses a second row with the same revision id.
    expect(() =>
      database()
        .prepare(
          "INSERT INTO workspace_records(academyId,kind,id,sportId,playerId,body,version) VALUES (?,?,?,?,NULL,?,1)",
        )
        .run(
          academy.id,
          "drillrevision",
          `${drill.id}:000001`,
          "football",
          "{}",
        ),
    ).toThrow();
  });
  it("a failed or refused edit leaves no revision", async () => {
    const drill = create("OWNER");
    const count = () => drillHistory(as("OWNER"), drill.id).revisions.length;
    const before = count();
    expect(
      await statusOf(() => edit("COACH", drill, { purpose: "Not yours." })),
    ).toBe(403);
    expect(
      await statusOf(() =>
        edit("OWNER", { ...drill, recordVersion: 99 }, { purpose: "Stale." }),
      ),
    ).toBe(409);
    expect(
      await statusOf(() => edit("OWNER", drill, { purpose: "z".repeat(400) })),
    ).toBe(400);
    expect(count()).toBe(before);
  });
  it("only the owner, an admin and the creating coach can read it", async () => {
    const mine = create("COACH");
    for (const role of ["OWNER", "ADMIN", "COACH"] as const)
      expect(drillHistory(as(role), mine.id).revisions).toHaveLength(1);
    expect(await statusOf(() => drillHistory(as("PARENT"), mine.id))).toBe(403);
    const ownersDrill = create("OWNER");
    expect(
      await statusOf(() => drillHistory(as("COACH"), ownersDrill.id)),
    ).toBe(403);
    expect(await statusOf(() => drillHistory(as("OWNER"), "uni-016"))).toBe(
      403,
    );
    expect(await statusOf(() => drillHistory(as("OWNER"), "missing"))).toBe(
      404,
    );
    expect(await statusOf(() => drillHistory(as("OWNER"), "../x"))).toBe(404);
  });
  it("the generic record routes cannot reach a revision", () => {
    const drill = create("OWNER");
    expect(() =>
      repo.find(academy.id, "drill", `${drill.id}:000001`),
    ).not.toThrow();
    expect(
      repo.find(academy.id, "drill", `${drill.id}:000001`),
    ).toBeUndefined();
  });
});
