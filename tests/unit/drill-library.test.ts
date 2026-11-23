// Drill library: who may do what, academy isolation, the immutable universal
// catalogue, deterministic academy copies, archive and restore, optimistic
// concurrency, session / series / plan integration, historical snapshots and
// what families never see.
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
import {
  assembleMonthly,
} from "@/server/period-service";
import { saveRecord, workspace } from "@/server/workspace-service";
import { trainingAction } from "@/server/training-service";
import {
  customiseDrill,
  drillCatalogue,
  resolveDrill,
  setDrillArchived,
} from "@/server/drill-library-service";
import { visibleRecords } from "@/server/workspace-access";
import {
  UNIVERSAL_CATALOGUE,
  findUniversalDrill,
} from "@/config/drills";
import type { FootballSeries, FootballSession } from "@/domain/training";
import type {
  AcademyConfiguration,
  AcademyRole,
  WorkspaceDrill,
} from "@/domain/workspace";
import {
  actorFor,
  linkGuardian,
  memberId,
  newAcademyConfig,
  seedAcademy,
  statusOf,
} from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-drills-${randomUUID()}.sqlite`);
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
const as = (role: AcademyRole, cfg = academy) => actorFor(role, cfg);
const userOf = (role: AcademyRole) => memberId(role, academy);
const SENTINEL = "ZZ-STAFF-ONLY-SENTINEL";
const drillInput = (over: Record<string, unknown> = {}) => ({
  name: "Synthetic passing box",
  category: "passing-combination-play",
  focusArea: "Passing",
  purpose: "Practise short passes in a small box.",
  cue: "Pass and move.",
  content: {
    description: "A small box for short passing.",
    steps: ["Pass to a teammate.", "Move to a new space."],
    safety: [SENTINEL],
  },
  ...over,
});
const create = (role: AcademyRole, over: Record<string, unknown> = {}, cfg = academy) =>
  saveRecord(as(role, cfg), "drill", drillInput(over)) as WorkspaceDrill;
const edit = (
  role: AcademyRole,
  drill: WorkspaceDrill,
  over: Record<string, unknown> = {},
) =>
  saveRecord(
    as(role),
    "drill",
    drillInput({ expectedVersion: drill.recordVersion, ...over }),
    drill.id,
  ) as WorkspaceDrill;
const act = (
  role: AcademyRole,
  action: string,
  data: unknown,
  extra: { id?: string; expectedVersion?: number } = {},
) =>
  trainingAction(as(role), { requestId: randomUUID(), action, data, ...extra });
const sessionData = (date: string, agenda: unknown[] = [], over: Record<string, unknown> = {}) => ({
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
const makeSession = (agenda: unknown[], role: AcademyRole = "OWNER") =>
  act(role, "session", sessionData("2026-12-10", agenda)) as FootballSession;
const auditActions = () =>
  database()
    .prepare("SELECT action FROM workspace_audit WHERE academyId=?")
    .all(academy.id)
    .map((r) => String(r.action));

beforeEach(() => {
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
  repo.save(academy.id, "player", {
    id: "child",
    academyId: academy.id,
    name: "Synthetic child",
    sportIds: ["football"],
    squad: "",
    squadId: "",
    coachId: userOf("COACH"),
    status: "ACTIVE",
  });
  act("OWNER", "squad", { name: "Main U12", branchId: "main", playerIds: ["child"] }, {
    id: "squad-main",
  });
  linkGuardian(academy, userOf("PARENT"), "child");
});

describe("who may create and read drills", () => {
  it("owner, admin and coach create; parent and Support cannot", async () => {
    for (const role of ["OWNER", "ADMIN", "COACH"] as const)
      expect(create(role).createdBy).toBe(userOf(role));
    for (const role of ["PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => create(role))).toBe(403);
  });
  it("only staff read the catalogue, and only with the development module", async () => {
    for (const role of ["OWNER", "ADMIN", "COACH"] as const)
      expect(drillCatalogue(as(role)).drills).toHaveLength(49);
    for (const role of ["PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => drillCatalogue(as(role)))).toBe(403);
    const noModule = newAcademyConfig({ modules: ["reports"] });
    seedAcademy(noModule);
    expect(await statusOf(() => drillCatalogue(as("OWNER", noModule)))).toBe(403);
    expect(await statusOf(() => customiseDrill(as("OWNER", noModule), "uni-008"))).toBe(403);
  });
  it("parents and Support see no drill records at all", () => {
    create("OWNER");
    expect(visibleRecords(as("PARENT"), "drill")).toEqual([]);
    expect(visibleRecords(as("SUPPORT"), "drill")).toEqual([]);
    expect(JSON.stringify(workspace(as("PARENT")))).not.toContain(SENTINEL);
  });
  it("the catalogue is read-only: it is frozen and there is no write path", () => {
    expect(Object.isFrozen(UNIVERSAL_CATALOGUE)).toBe(true);
    const before = JSON.stringify(UNIVERSAL_CATALOGUE);
    customiseDrill(as("OWNER"), "uni-008");
    expect(JSON.stringify(UNIVERSAL_CATALOGUE)).toBe(before);
  });
});

describe("editing is limited to the owner, admins and a coach's own drills", () => {
  it("owner and admin edit any drill", () => {
    const mine = create("COACH");
    expect(edit("OWNER", mine, { name: "Owner edit" }).name).toBe("Owner edit");
    const again = repo.find(academy.id, "drill", mine.id)!;
    expect(edit("ADMIN", again, { name: "Admin edit" }).name).toBe("Admin edit");
  });
  it("a coach edits only a drill they created", async () => {
    const own = create("COACH");
    expect(edit("COACH", own, { name: "My own change" }).name).toBe("My own change");
    const owners = create("OWNER");
    expect(await statusOf(() => edit("COACH", owners))).toBe(403);
    expect(repo.find(academy.id, "drill", owners.id)!.name).toBe(owners.name);
  });
  it("a coach cannot edit another coach's drill or an older drill with no creator", async () => {
    const other = create("ADMIN");
    expect(await statusOf(() => edit("COACH", other))).toBe(403);
    // An older drill (name, focus, purpose, cue only; no category or creator).
    repo.save(academy.id, "drill", {
      id: "legacy",
      academyId: academy.id,
      sportId: "football",
      name: "Older drill",
      focusArea: "Passing",
      purpose: "Older purpose.",
      cue: "Older cue.",
      ownership: "ACADEMY_CURRICULUM",
    });
    const legacy = repo.find(academy.id, "drill", "legacy")!;
    expect(legacy.category).toBeUndefined();
    expect(await statusOf(() => edit("COACH", legacy))).toBe(403);
  });
  it("shows an older drill as uncategorised until it is edited with a category", async () => {
    repo.save(academy.id, "drill", {
      id: "legacy",
      academyId: academy.id,
      sportId: "football",
      name: "Older drill",
      focusArea: "Passing",
      purpose: "Older purpose.",
      cue: "Older cue.",
      ownership: "ACADEMY_CURRICULUM",
    });
    const legacy = repo.find(academy.id, "drill", "legacy")!;
    expect(
      await statusOf(() => edit("OWNER", legacy, { category: undefined })),
    ).toBe(400);
    const saved = edit("OWNER", legacy, { category: "defending-pressing" });
    expect(saved.category).toBe("defending-pressing");
  });
  it("needs the version the editor saw (optimistic concurrency)", async () => {
    const drill = create("OWNER");
    expect(
      await statusOf(() => saveRecord(as("OWNER"), "drill", drillInput(), drill.id)),
    ).toBe(409);
    expect(await statusOf(() => edit("OWNER", { ...drill, recordVersion: 99 }))).toBe(409);
    const saved = edit("OWNER", drill, { name: "Version two" });
    expect(saved.recordVersion).toBe((drill.recordVersion ?? 1) + 1);
    // A second editor holding the old version is refused, not overwritten.
    expect(await statusOf(() => edit("ADMIN", drill, { name: "Stale" }))).toBe(409);
    expect(repo.find(academy.id, "drill", drill.id)!.name).toBe("Version two");
  });
  it("rejects a seventh category, unknown fields and bad content", async () => {
    // Stage 1: validation failures are answered with a field-specific 400
    // (they used to surface as a bare schema error); they are still refused.
    expect(await statusOf(() => create("OWNER", { category: "agility" }))).toBe(400);
    expect(
      await statusOf(() => create("OWNER", { content: { steps: ["ok"], extra: 1 } })),
    ).toBe(400);
    expect(
      await statusOf(() =>
        create("OWNER", { content: { players: { min: 9, max: 2 } } }),
      ),
    ).toBe(400);
    expect(await statusOf(() => create("OWNER", { focusArea: "Juggling hurdles" }))).toBe(400);
  });
  it("keeps the staff-only content out of the stored record's family fields", () => {
    const drill = create("OWNER");
    expect(drill.purpose).not.toContain(SENTINEL);
    expect(drill.cue).not.toContain(SENTINEL);
    expect(JSON.stringify(drill.content)).toContain(SENTINEL);
  });
});

describe("the catalogue's ids belong to the catalogue", () => {
  it("nobody can write a universal id or invent a copy", async () => {
    for (const role of ["OWNER", "ADMIN", "COACH"] as const) {
      expect(
        await statusOf(() => saveRecord(as(role), "drill", drillInput(), "uni-008")),
      ).toBe(403);
      expect(
        await statusOf(() => saveRecord(as(role), "drill", drillInput(), "from-uni-008")),
      ).toBe(403);
    }
    expect(repo.find(academy.id, "drill", "uni-008")).toBeUndefined();
    expect(repo.find(academy.id, "drill", "from-uni-008")).toBeUndefined();
  });
  it("a forged template link is ignored, so it cannot pose as a copy", () => {
    const drill = create("OWNER", { templateId: "uni-008" });
    expect(drill.templateId).toBeUndefined();
    const legacy = create("OWNER", { templateId: "football-close-control" });
    expect(legacy.templateId).toBe("football-close-control");
  });
  it("archive and restore refuse a universal id", async () => {
    expect(await statusOf(() => setDrillArchived(as("OWNER"), "uni-008", true))).toBe(403);
  });
});

describe("customising a universal drill", () => {
  it("makes one deterministic academy copy and returns it on repeat", () => {
    const first = customiseDrill(as("COACH"), "uni-008");
    expect(first.created).toBe(true);
    expect(first.drill.id).toBe("from-uni-008");
    expect(first.drill).toMatchObject({
      name: "Wall-Kicks / Wall Passing",
      templateId: "uni-008",
      category: "ball-control-dribbling",
      ownership: "ACADEMY_CURRICULUM",
      status: "ACTIVE",
      createdBy: userOf("COACH"),
      universalVersion: 1,
    });
    const second = customiseDrill(as("OWNER"), "uni-008");
    expect(second.created).toBe(false);
    expect(second.drill.id).toBe(first.drill.id);
    expect(second.drill.createdBy).toBe(userOf("COACH"));
    const copies = repo
      .list(academy.id, "drill")
      .filter((d) => d.templateId === "uni-008");
    expect(copies).toHaveLength(1);
    expect(auditActions().filter((a) => /customised/.test(a))).toHaveLength(1);
  });
  it("is repeatable under repeated calls and never duplicates", () => {
    for (let i = 0; i < 5; i++) customiseDrill(as("ADMIN"), "uni-025");
    expect(repo.list(academy.id, "drill").filter((d) => d.templateId === "uni-025")).toHaveLength(1);
  });
  it("copies the whole content, independently of the catalogue", () => {
    const { drill } = customiseDrill(as("OWNER"), "uni-034");
    const source = findUniversalDrill("uni-034")!;
    expect(drill.content?.steps).toEqual(source.content.steps);
    expect(drill.content?.diagram?.archetype).toBe("shooting-lane");
    expect(drill.content?.steps).not.toBe(source.content.steps);
  });
  it("changing the copy never changes the universal drill", () => {
    const before = JSON.stringify(findUniversalDrill("uni-008"));
    const { drill } = customiseDrill(as("OWNER"), "uni-008");
    const saved = edit("OWNER", drill, {
      name: "Our wall drill",
      content: { steps: ["Our own step."] },
    });
    expect(saved.name).toBe("Our wall drill");
    expect(saved.templateId).toBe("uni-008");
    expect(JSON.stringify(findUniversalDrill("uni-008"))).toBe(before);
    expect(findUniversalDrill("uni-008")!.name).toBe("Wall-Kicks / Wall Passing");
    // The copy still has its diagram: an edit without a diagram keeps it.
    expect(saved.content?.diagram?.archetype).toBe("wall-lane");
  });
  it("an edit that picks a predefined layout replaces the copy's diagram", () => {
    const { drill } = customiseDrill(as("OWNER"), "uni-008");
    const saved = edit("OWNER", drill, { content: { diagramPreset: "triangle" } });
    expect(saved.content?.diagramPreset).toBe("triangle");
    expect(saved.content?.diagram).toBeUndefined();
  });
  it("a coach edits the copy only if they made it", async () => {
    const { drill } = customiseDrill(as("COACH"), "uni-008");
    expect(edit("COACH", drill, { name: "Coach's version" }).name).toBe("Coach's version");
    const other = customiseDrill(as("OWNER"), "uni-009").drill;
    expect(await statusOf(() => edit("COACH", other))).toBe(403);
  });
  it("refuses a parent, Support, a non-catalogue id, an unknown drill and the draft", async () => {
    for (const role of ["PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => customiseDrill(as(role), "uni-008"))).toBe(403);
    expect(await statusOf(() => customiseDrill(as("OWNER"), "drill-1"))).toBe(400);
    expect(await statusOf(() => customiseDrill(as("OWNER"), "uni-999"))).toBe(404);
    expect(await statusOf(() => customiseDrill(as("OWNER"), "uni-049"))).toBe(404);
    expect(repo.find(academy.id, "drill", "from-uni-049")).toBeUndefined();
  });
  it("returns the archived copy rather than making another", () => {
    const { drill } = customiseDrill(as("OWNER"), "uni-008");
    setDrillArchived(as("OWNER"), drill.id, true);
    const again = customiseDrill(as("OWNER"), "uni-008");
    expect(again.created).toBe(false);
    expect(again.drill.status).toBe("ARCHIVED");
  });
});

describe("archive and restore", () => {
  it("owner and admin archive any drill; a coach only their own", async () => {
    const own = create("COACH"),
      theirs = create("OWNER");
    expect(setDrillArchived(as("COACH"), own.id, true).status).toBe("ARCHIVED");
    expect(await statusOf(() => setDrillArchived(as("COACH"), theirs.id, true))).toBe(403);
    expect(setDrillArchived(as("ADMIN"), theirs.id, true).status).toBe("ARCHIVED");
    expect(setDrillArchived(as("OWNER"), own.id, false).status).toBe("ACTIVE");
    for (const role of ["PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => setDrillArchived(as(role), own.id, true))).toBe(403);
  });
  it("is idempotent, audited once per change and keeps the record", () => {
    const drill = create("OWNER");
    setDrillArchived(as("OWNER"), drill.id, true);
    const archived = setDrillArchived(as("OWNER"), drill.id, true);
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedBy).toBe(userOf("OWNER"));
    expect(auditActions().filter((a) => a === "Academy drill archived")).toHaveLength(1);
    setDrillArchived(as("OWNER"), drill.id, false);
    expect(repo.find(academy.id, "drill", drill.id)).toMatchObject({
      status: "ACTIVE",
      name: drill.name,
    });
    expect(auditActions().filter((a) => a === "Academy drill restored")).toHaveLength(1);
  });
  it("refuses a stale version and an edit while archived", async () => {
    const drill = create("OWNER");
    expect(
      await statusOf(() => setDrillArchived(as("OWNER"), drill.id, true, 99)),
    ).toBe(409);
    const archived = setDrillArchived(as("OWNER"), drill.id, true);
    expect(await statusOf(() => edit("OWNER", archived))).toBe(409);
  });
  it("an unknown drill is 404", async () => {
    expect(await statusOf(() => setDrillArchived(as("OWNER"), "missing", true))).toBe(404);
  });
});

describe("academy isolation", () => {
  it("another academy cannot read, edit or archive this academy's drill", async () => {
    const drill = create("OWNER");
    const other = newAcademyConfig();
    seedAcademy(other);
    expect(await statusOf(() => resolveDrill(as("OWNER", other), drill.id))).toBe(404);
    expect(await statusOf(() => setDrillArchived(as("OWNER", other), drill.id, true))).toBe(404);
    expect(visibleRecords(as("OWNER", other), "drill")).toEqual([]);
    // Saving under the same id there makes that academy's own record.
    const theirs = saveRecord(as("OWNER", other), "drill", drillInput({ name: "Theirs" }), drill.id) as WorkspaceDrill;
    expect(theirs.name).toBe("Theirs");
    expect(repo.find(academy.id, "drill", drill.id)!.name).toBe(drill.name);
  });
  it("each academy has its own copy of a universal drill", () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    customiseDrill(as("OWNER"), "uni-008");
    expect(repo.find(other.id, "drill", "from-uni-008")).toBeUndefined();
    customiseDrill(as("OWNER", other), "uni-008");
    expect(repo.find(other.id, "drill", "from-uni-008")?.createdBy).toBe(
      memberId("OWNER", other),
    );
  });
  it("a universal drill resolves identically in every academy", () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    const a = resolveDrill(as("OWNER"), "uni-016"),
      b = resolveDrill(as("OWNER", other), "uni-016");
    expect({ ...a, academyId: "" }).toEqual({ ...b, academyId: "" });
    expect(a.academyId).toBe(academy.id);
    expect(b.academyId).toBe(other.id);
  });
});

describe("sessions use universal and academy drills", () => {
  it("saves a snapshot, keeps the chosen order and durations", () => {
    const own = create("OWNER");
    const session = makeSession([
      { drillId: "uni-016", duration: 15 },
      { drillId: own.id, duration: 20 },
      { drillId: "uni-008", duration: 10 },
    ]);
    expect(session.agenda.map((a) => a.drill.id)).toEqual(["uni-016", own.id, "uni-008"]);
    expect(session.agenda.map((a) => a.duration)).toEqual([15, 20, 10]);
    expect(session.agenda[0]).toMatchObject({
      drillVersion: 1,
      drill: {
        name: "Three-Player Passing Triangles",
        ownership: "UNIVERSAL_CATALOGUE",
        universalVersion: 1,
      },
    });
    // Stage 1: the universal snapshot is COMPLETE (it replaces the earlier slim
    // snapshot, which depended on today's catalogue). Staff only: families get
    // name, purpose and cue from reports, never the session.
    expect(session.agenda[0].drill.content?.steps?.length).toBeGreaterThan(0);
    expect(session.agenda[0].drill.content?.diagram).toBeDefined();
    expect(session.agenda[0].drill.snapshot).toMatchObject({
      source: "UNIVERSAL_CATALOGUE",
      contentVersion: 1,
      number: 16,
    });
    expect(session.agenda[1].drill.recordVersion).toBeUndefined();
  });
  it("keeps the existing duration validation", () => {
    expect(() =>
      makeSession([
        { drillId: "uni-016", duration: 40 },
        { drillId: "uni-008", duration: 40 },
      ]),
    ).toThrow(/exceed the session length/);
  });
  it("refuses an unknown or draft universal drill and another academy's drill", async () => {
    expect(await statusOf(() => makeSession([{ drillId: "uni-999", duration: 10 }]))).toBe(404);
    expect(await statusOf(() => makeSession([{ drillId: "uni-049", duration: 10 }]))).toBe(404);
    const other = newAcademyConfig();
    seedAcademy(other);
    const foreign = create("OWNER", {}, other);
    expect(await statusOf(() => makeSession([{ drillId: foreign.id, duration: 10 }]))).toBe(404);
  });
  it("editing or archiving a drill never changes a saved session", () => {
    const own = create("OWNER", { name: "Original name" });
    const session = makeSession([{ drillId: own.id, duration: 15 }]);
    const fresh = () => repo.find(academy.id, "session", session.id)!.agenda[0];
    const snapshot = JSON.stringify(fresh());
    edit("OWNER", own, { name: "Renamed later", purpose: "Changed purpose later." });
    expect(JSON.stringify(fresh())).toBe(snapshot);
    expect(fresh().drill.name).toBe("Original name");
    setDrillArchived(as("OWNER"), own.id, true);
    expect(JSON.stringify(fresh())).toBe(snapshot);
  });
  it("a copy edited later leaves a session built from the universal drill unchanged", () => {
    const session = makeSession([{ drillId: "uni-008", duration: 15 }]);
    const { drill } = customiseDrill(as("OWNER"), "uni-008");
    edit("OWNER", drill, { name: "Our wall drill" });
    expect(repo.find(academy.id, "session", session.id)!.agenda[0].drill.name).toBe(
      "Wall-Kicks / Wall Passing",
    );
  });
  it("refuses an archived drill for a new session but keeps it in a saved draft", async () => {
    const own = create("OWNER");
    const draft = makeSession([{ drillId: own.id, duration: 15 }]);
    setDrillArchived(as("OWNER"), own.id, true);
    expect(
      await statusOf(() => makeSession([{ drillId: own.id, duration: 15 }])),
    ).toBe(409);
    // Saving the existing draft again, with the drill still in it, is allowed.
    const resaved = act(
      "OWNER",
      "session",
      sessionData("2026-12-10", [{ drillId: own.id, duration: 20 }], {
        title: "Edited title",
      }),
      { id: draft.id, expectedVersion: draft.version },
    ) as FootballSession;
    expect(resaved.agenda[0].duration).toBe(20);
    // But the drill cannot be added to a different draft.
    expect(
      await statusOf(() =>
        act(
          "OWNER",
          "session",
          sessionData("2026-12-11", [{ drillId: own.id, duration: 10 }]),
        ),
      ),
    ).toBe(409);
  });
  it("a coach plans with the library on their own sessions only", async () => {
    expect(makeSession([{ drillId: "uni-016", duration: 15 }], "COACH").agenda).toHaveLength(1);
    expect(
      await statusOf(() =>
        act("PARENT", "session", sessionData("2026-12-12", [{ drillId: "uni-016", duration: 15 }])),
      ),
    ).toBe(403);
  });
});

describe("recurring sessions", () => {
  const seriesData = (agenda: unknown[]) => ({
    branchId: "main",
    squadId: "squad-main",
    location: "Synthetic pitch",
    coachIds: [userOf("COACH")],
    timezone: academy.timezone,
    weekdays: [1, 3],
    startDate: "2026-12-14",
    endDate: "2026-12-30",
    startTime: "17:00",
    endTime: "18:00",
    theme: "Receiving",
    agenda,
    exclusions: [],
  });
  it("creates sessions whose agenda snapshots a universal and an academy drill", () => {
    const own = create("OWNER");
    const series = act(
      "OWNER",
      "series",
      seriesData([
        { drillId: "uni-025", duration: 20 },
        { drillId: own.id, duration: 20 },
      ]),
      { id: randomUUID() },
    ) as FootballSeries;
    const made = repo.list(academy.id, "session").filter((s) => s.seriesId === series.id);
    expect(made.length).toBeGreaterThan(2);
    for (const s of made)
      expect(s.agenda.map((a) => a.drill.id)).toEqual(["uni-025", own.id]);
  });
  it("refuses an archived drill for a new series", async () => {
    const own = create("OWNER");
    setDrillArchived(as("OWNER"), own.id, true);
    expect(
      await statusOf(() =>
        act("OWNER", "series", seriesData([{ drillId: own.id, duration: 20 }]), {
          id: randomUUID(),
        }),
      ),
    ).toBe(409);
    expect(
      await statusOf(() =>
        act("OWNER", "seriesPreview", seriesData([{ drillId: own.id, duration: 20 }])),
      ),
    ).toBe(409);
  });
  it("keeps adding dates to an existing series after its drill is archived", () => {
    const own = create("OWNER");
    const series = act(
      "OWNER",
      "series",
      { ...seriesData([{ drillId: own.id, duration: 20 }]), endDate: "2026-12-18" },
      { id: randomUUID() },
    ) as FootballSeries;
    setDrillArchived(as("OWNER"), own.id, true);
    // Extending the series (processing it again) must not fail on the archived drill.
    expect(() => act("OWNER", "seriesSync", {}, { id: series.id, expectedVersion: series.version })).not.toThrow();
  });
  it("sessions already made keep their snapshot when the drill changes later", () => {
    const own = create("OWNER", { name: "Series drill" });
    const series = act(
      "OWNER",
      "series",
      seriesData([{ drillId: own.id, duration: 20 }]),
      { id: randomUUID() },
    ) as FootballSeries;
    edit("OWNER", own, { name: "Renamed" });
    const made = repo.list(academy.id, "session").filter((s) => s.seriesId === series.id);
    expect(made.every((s) => s.agenda[0].drill.name === "Series drill")).toBe(true);
  });
});

describe("training plans and reports", () => {
  const planInput = (drillIds: string[], over: Record<string, unknown> = {}) => ({
    playerId: "child",
    sportId: "football",
    coachId: userOf("COACH"),
    focus: "Passing",
    reason: "A short synthetic reason for the plan.",
    drillIds,
    observe: "Watch the quality of the pass.",
    homePractice: "",
    reviewDate: "2026-12-30",
    nextStep: "Review in a month.",
    status: "ACTIVE",
    privateNote: "",
    ...over,
  });
  it("a plan can assign universal and academy drills", () => {
    const own = create("OWNER");
    const plan = saveRecord(as("OWNER"), "plan", planInput(["uni-016", own.id]));
    expect((plan as { drillIds: string[] }).drillIds).toEqual(["uni-016", own.id]);
  });
  it("rejects an unknown drill and another academy's drill", async () => {
    const other = newAcademyConfig();
    seedAcademy(other);
    const foreign = create("OWNER", {}, other);
    expect(await statusOf(() => saveRecord(as("OWNER"), "plan", planInput(["uni-999"])))).toBe(400);
    expect(await statusOf(() => saveRecord(as("OWNER"), "plan", planInput([foreign.id])))).toBe(400);
    expect(await statusOf(() => saveRecord(as("OWNER"), "plan", planInput(["uni-049"])))).toBe(400);
  });
  it("refuses an archived drill for a new plan but keeps one a plan already has", async () => {
    const own = create("OWNER");
    const plan = saveRecord(as("OWNER"), "plan", planInput([own.id])) as {
      id: string;
      recordVersion: number;
    };
    setDrillArchived(as("OWNER"), own.id, true);
    expect(await statusOf(() => saveRecord(as("OWNER"), "plan", planInput([own.id])))).toBe(409);
    const updated = saveRecord(
      as("OWNER"),
      "plan",
      planInput([own.id], { status: "CONTINUE", expectedVersion: plan.recordVersion }),
      plan.id,
    ) as { status: string };
    expect(updated.status).toBe("CONTINUE");
  });
});

describe("what families can never see", () => {
  it("a family report carries only the name, purpose and cue of a drill", () => {
    const own = create("OWNER", { name: "Report drill" });
    // A completed session in October with both kinds of drill and a present mark.
    const universal = resolveDrill(as("OWNER"), "uni-016");
    const session = {
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
      roster: [{ playerId: "child", name: "Synthetic child" }],
      agenda: [
        { drill: universal, duration: 15, drillVersion: 1 },
        { drill: own, duration: 15, drillVersion: 1 },
      ],
      objectives: [],
    };
    repo.save(academy.id, "session", session);
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
    const monthly = assembleMonthly(as("OWNER"), "child", "2026-10");
    const activities = monthly.model.activities;
    expect(activities.map((a) => a.name).sort()).toEqual(
      ["Report drill", "Three-Player Passing Triangles"].sort(),
    );
    for (const activity of activities)
      expect(Object.keys(activity).sort()).toEqual(
        ["cue", "drillId", "name", "purpose"].sort(),
      );
    const text = JSON.stringify(monthly.model);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("Pass and move: never stand still");
    expect(text).not.toMatch(/safety|commonMistakes|coachingPoints|steps/i);
  });
  it("a parent's academy payload holds no drill, session or plan detail", () => {
    const own = create("OWNER");
    makeSession([
      { drillId: "uni-016", duration: 15 },
      { drillId: own.id, duration: 15 },
    ]);
    const parent = workspace(as("PARENT"));
    expect(parent.records.drill).toEqual([]);
    expect(parent.records.session).toEqual([]);
    const text = JSON.stringify(parent);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("Three-Player Passing Triangles");
    expect(text).not.toContain("Pass and move: never stand still");
  });
});
