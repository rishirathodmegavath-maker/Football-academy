import "server-only";
import {
  PARENT_CUE_MAX,
  PARENT_PURPOSE_MAX,
  copyDrillId,
  isCopyDrillId,
  isUniversalDrillId,
  type AcademyDrillContent,
  type DrillCategoryId,
  type UniversalDrill,
} from "@/domain/drill-library";
import type { WorkspaceDrill } from "@/domain/workspace";
import {
  categorySummary,
  findUniversalDrill,
  publishedDrills,
} from "@/config/drills";
import { headingPolicyFor } from "@/config/drills/heading-policy";
import { operationalSports } from "@/config/sports/workspace-sports";
import { playerAge } from "@/services/portal-records";
import { atomic, audit, database } from "./database";
import { WorkspaceError } from "./auth";
import {
  requireModule,
  requireRole,
  requireSport,
  visibleRecord,
  type WorkspaceAccess,
} from "./workspace-access";
import { workspaceRepository as repo } from "./workspace-repository";
import { drillRevisionHistory, recordDrillRevision } from "./drill-revisions";
import { drillSchema } from "./workspace-schemas";

const staff = ["OWNER", "ADMIN", "COACH"] as const;
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ catalogue

/** The universal catalogue for staff of an academy whose plan includes the
 * development module. Draft entries are never served. */
export function drillCatalogue(ctx: WorkspaceAccess) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "drill");
  requireSport(ctx, "football");
  return {
    categories: categorySummary(),
    drills: publishedDrills(),
    headingPolicy: headingPolicyFor(ctx.academy.country),
  };
}

// ------------------------------------------------------------------ resolution

const isArchived = (d: Pick<WorkspaceDrill, "status">) => d.status === "ARCHIVED";

/** The catalogue drill as a complete, self-contained record: everything a
 * coach needs to run it and everything needed to reproduce it later. Staff
 * only; family-facing projections take just name, purpose and cue. */
function universalSnapshot(
  academyId: string,
  u: UniversalDrill,
): WorkspaceDrill {
  return {
    id: u.id,
    academyId,
    sportId: "football",
    name: u.name,
    focusArea: u.focusArea,
    purpose: u.purpose,
    cue: u.cue,
    ownership: "UNIVERSAL_CATALOGUE",
    templateId: u.id,
    category: u.categoryId,
    status: "ACTIVE",
    universalVersion: u.contentVersion,
    content: toAcademyContent(u),
    lockedSafety: [...u.content.safety],
    ...(u.minimumAge ? { minimumAge: { ...u.minimumAge } } : {}),
  };
}

/**
 * A drill by id, whether it is a catalogue drill or this academy's own. An
 * archived academy drill still resolves (history and existing plans need it).
 * Another academy's drill, or a draft or unknown catalogue drill, is 404.
 */
export function resolveDrill(ctx: WorkspaceAccess, id: string): WorkspaceDrill {
  if (isUniversalDrillId(id)) {
    requireModule(ctx, "drill");
    const found = findUniversalDrill(id);
    if (!found) throw new WorkspaceError(404, "Drill is not available.");
    return universalSnapshot(ctx.academy.id, found);
  }
  const drill = visibleRecord(ctx, "drill", id);
  // The optimistic-concurrency counter is not part of a historical snapshot.
  return { ...drill, recordVersion: undefined };
}

/**
 * The drill for a NEW agenda or plan item. An archived academy drill is
 * refused, unless the record being edited already contains it (`existing`).
 */
export function drillForPlanning(
  ctx: WorkspaceAccess,
  id: string,
  existing: ReadonlySet<string> = new Set(),
): WorkspaceDrill {
  const drill = resolveDrill(ctx, id);
  if (isArchived(drill) && !existing.has(id))
    throw new WorkspaceError(
      409,
      "This drill is archived. Restore it, or choose another drill, before adding it to a new session or plan.",
    );
  return drill;
}

/** The version recorded with a snapshot: the content version for a catalogue
 * drill, the stored record's version for an academy drill. */
export function drillVersionOf(academyId: string, drill: WorkspaceDrill): number {
  if (drill.ownership === "UNIVERSAL_CATALOGUE")
    return drill.universalVersion ?? 1;
  return Number(
    database()
      .prepare(
        "SELECT version FROM workspace_records WHERE academyId=? AND kind=? AND id=?",
      )
      .get(academyId, "drill", drill.id)?.version,
  );
}

/**
 * The complete, immutable snapshot of a drill as it is at this moment, for
 * saving in a session. It stands on its own: the session never needs the
 * current catalogue or the current academy drill to show what was planned.
 */
export function sessionDrillSnapshot(
  ctx: WorkspaceAccess,
  drill: WorkspaceDrill,
  at = now(),
): WorkspaceDrill {
  const universal = drill.ownership === "UNIVERSAL_CATALOGUE",
    source = universal ? findUniversalDrill(drill.id) : undefined;
  return structuredClone({
    ...drill,
    recordVersion: undefined,
    snapshot: {
      capturedAt: at,
      contentVersion: drillVersionOf(ctx.academy.id, drill),
      source: universal ? "UNIVERSAL_CATALOGUE" : "ACADEMY_DRILL",
      ...(source
        ? { objective: source.originalObjective, number: source.number }
        : {}),
    },
  });
}

/**
 * True when a drill saved in a session cannot reproduce itself: a catalogue
 * drill saved before complete snapshots existed. Such a record is preserved
 * and labelled; today's catalogue is never substituted for it.
 */
export const isLegacyIncompleteSnapshot = (drill: WorkspaceDrill) =>
  drill.ownership === "UNIVERSAL_CATALOGUE" && !drill.snapshot;

// ------------------------------------------------------------------ age rule

/** The internal minimum age of a drill, including a copy of a restricted
 * catalogue drill and an older snapshot that predates the field. */
export function minimumAgeOf(
  drill: WorkspaceDrill,
): { years: number; basis: "INTERNAL_PRODUCT_POLICY" } | undefined {
  if (drill.minimumAge) return drill.minimumAge;
  const universalId =
    drill.ownership === "UNIVERSAL_CATALOGUE"
      ? drill.id
      : drill.templateId && isUniversalDrillId(drill.templateId)
        ? drill.templateId
        : undefined;
  return universalId ? findUniversalDrill(universalId)?.minimumAge : undefined;
}

/** Today's date in the academy's time zone, as YYYY-MM-DD. */
export function academyToday(ctx: WorkspaceAccess, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.academy.timezone,
  }).format(at);
}

/**
 * Enforces the internal minimum age of a drill, server-side. Every player who
 * will take part must have a recorded date of birth that makes them old
 * enough on `onDate`. A missing or unreadable date of birth blocks the drill:
 * the age category alone cannot show that an individual child is old enough.
 * This is an internal Sportozen safeguarding rule, not an association rule and
 * not medical advice.
 */
export function assertDrillAgeRules(
  ctx: WorkspaceAccess,
  drills: readonly WorkspaceDrill[],
  playerIds: readonly string[],
  onDate: string,
) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : academyToday(ctx);
  for (const drill of drills) {
    const minimum = minimumAgeOf(drill);
    if (!minimum) continue;
    const blocked: string[] = [];
    for (const playerId of playerIds) {
      const player = repo.find(ctx.academy.id, "player", playerId);
      const age = playerAge(player?.birthDate, day);
      if (!player) blocked.push("a player who cannot be found");
      else if (age === undefined || !Number.isFinite(age))
        blocked.push(`${player.name} (no valid date of birth recorded)`);
      else if (age < minimum.years)
        blocked.push(`${player.name} (age ${age})`);
    }
    if (blocked.length)
      throw new WorkspaceError(
        409,
        `${drill.name} is for players aged ${minimum.years} or over. This is an internal Sportozen safeguarding rule, not an association rule. It cannot be used here because of: ${blocked.join("; ")}. Remove the drill, remove those players, or record a correct date of birth.`,
      );
  }
}

// ------------------------------------------------------------------ writing

/** Owner and admin manage every academy drill. A coach manages only a drill
 * they created. Older drills have no creator, so only owner and admin manage
 * them. */
export function canManageDrill(
  ctx: WorkspaceAccess,
  drill: Pick<WorkspaceDrill, "createdBy">,
): boolean {
  if (["OWNER", "ADMIN"].includes(ctx.membership.role)) return true;
  return (
    ctx.membership.role === "COACH" &&
    !!drill.createdBy &&
    drill.createdBy === ctx.user.id
  );
}

function assertManageable(ctx: WorkspaceAccess, drill: WorkspaceDrill) {
  if (!canManageDrill(ctx, drill))
    throw new WorkspaceError(
      403,
      "Only the academy owner, an admin, or the coach who created this drill can change it.",
    );
}

const RESERVED =
  "These drill ids belong to the universal catalogue and cannot be written.";

/** The catalogue content as an independent, editable academy copy. */
export function toAcademyContent(u: UniversalDrill): AcademyDrillContent {
  const { diagram, ...rest } = structuredClone(u.content);
  return { ...rest, diagram };
}

// ------------------------------------------------------------ legacy templates

/**
 * The older "copy a platform template" mechanism. A template is not a
 * catalogue drill, but it must no longer create a new record every time. A
 * template always maps to one deterministic, categorised academy drill.
 */
export const LEGACY_TEMPLATE_CATEGORY: Record<string, DrillCategoryId> = {
  "football-close-control": "ball-control-dribbling",
};
export const legacyTemplateDrillId = (templateId: string) =>
  `from-tpl-${templateId}`;
export const isLegacyTemplateId = (id: string | undefined): id is string =>
  !!id && Object.hasOwn(LEGACY_TEMPLATE_CATEGORY, id);

// ------------------------------------------------------------------ validation

const fieldError = (field: string, message: string) =>
  new WorkspaceError(400, `${field}: ${message}`);

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  focusArea: "Focus",
  purpose: "Purpose",
  cue: "Coaching cue",
  category: "Category",
  expectedVersion: "Version",
  templateId: "Template",
  "content.description": "Description",
  "content.skills": "Skills",
  "content.steps": "Steps",
  "content.safety": "Safety",
  "content.equipment": "Equipment",
  "content.coachingPoints": "Coaching points",
  "content.commonMistakes": "Common mistakes",
  "content.setup": "Setup",
  "content.references": "Sources",
};

/** Parses a drill write and answers with a field-specific message rather than
 * the generic "check the fields" response. */
export function parseDrillInput(input: unknown) {
  const parsed = drillSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0],
    path = issue.path.slice(0, 2).join("."),
    label =
      FIELD_LABELS[path] ??
      FIELD_LABELS[String(issue.path[0] ?? "")] ??
      String(issue.path[issue.path.length - 1] ?? "Drill");
  const detail =
    issue.code === "too_big"
      ? "is too long. Shorten it; nothing is cut for you."
      : issue.code === "too_small"
        ? "is required or too short."
        : issue.code === "invalid_value"
          ? "must be one of the listed choices."
          : issue.code === "unrecognized_keys"
            ? "contains a field that is not allowed."
            : "is not valid.";
  throw fieldError(label, detail);
}

/** Family-facing text limits, one definition for every way a drill is saved. */
export function assertFamilyText(purpose: string, cue: string) {
  if (purpose.length > PARENT_PURPOSE_MAX)
    throw fieldError(
      "Purpose",
      `can appear in family reports, so keep it to ${PARENT_PURPOSE_MAX} characters or fewer (it is ${purpose.length}). Nothing was shortened for you.`,
    );
  if (cue.length > PARENT_CUE_MAX)
    throw fieldError(
      "Coaching cue",
      `can appear in family reports, so keep it to ${PARENT_CUE_MAX} characters or fewer (it is ${cue.length}). Nothing was shortened for you.`,
    );
}

/**
 * Merges a submitted content object onto the stored one. A field that is not
 * submitted is kept exactly as it was; a field that is submitted replaces it
 * (an empty list is an explicit clear). The safety lines a copy inherited from
 * its catalogue drill are always present and come first. A client never
 * supplies a diagram: a copy keeps the one it has unless a predefined layout
 * is chosen.
 */
export function mergeContent(
  submitted: AcademyDrillContent,
  previous: AcademyDrillContent | undefined,
  locked: readonly string[] = [],
): AcademyDrillContent {
  const { diagram: _ignored, ...rest } = submitted;
  void _ignored;
  const merged: AcademyDrillContent = { ...(previous ?? {}), ...rest };
  if (submitted.diagramPreset) delete merged.diagram;
  else if (previous?.diagram) merged.diagram = previous.diagram;
  if (locked.length)
    merged.safety = [
      ...locked,
      ...(merged.safety ?? []).filter((line) => !locked.includes(line)),
    ];
  return merged;
}

/**
 * The record to store for a create or edit through the generic record path.
 * Permission, reserved ids, category and archive rules are judged here; the
 * caller judges them again inside its transaction against fresh state.
 */
export function prepareAcademyDrill(
  ctx: WorkspaceAccess,
  id: string,
  value: {
    sportId: "football";
    name: string;
    focusArea: string;
    purpose: string;
    cue: string;
    templateId?: string;
    category?: DrillCategoryId;
    content?: AcademyDrillContent;
  },
): WorkspaceDrill {
  requireModule(ctx, "drill");
  requireSport(ctx, value.sportId);
  if (!operationalSports[value.sportId].skills.includes(value.focusArea))
    throw fieldError("Focus", "use this sport's vocabulary.");
  if (isUniversalDrillId(id)) throw new WorkspaceError(403, RESERVED);
  const historical = repo.find(ctx.academy.id, "drill", id);
  if (!historical && isCopyDrillId(id))
    throw new WorkspaceError(
      403,
      "A customised copy is created only by customising the universal drill.",
    );
  assertFamilyText(value.purpose, value.cue);
  const legacyTemplate =
    !historical && isLegacyTemplateId(value.templateId)
      ? value.templateId
      : undefined;
  const category =
    value.category ??
    historical?.category ??
    (legacyTemplate ? LEGACY_TEMPLATE_CATEGORY[legacyTemplate] : undefined);
  // A legacy record may stay uncategorised until it is edited; a new record
  // may not be created without one.
  if (!category)
    throw fieldError(
      "Category",
      "choose one of the seven categories to save this drill.",
    );
  if (historical) {
    assertManageable(ctx, historical);
    if (isArchived(historical))
      throw new WorkspaceError(409, "Restore this drill before editing it.");
  }
  // A client cannot present its own drill as a copy of a catalogue drill.
  const templateId = historical
    ? historical.templateId
    : value.templateId && !isUniversalDrillId(value.templateId)
      ? value.templateId
      : undefined;
  const { recordVersion: _version, ...kept } = historical ?? ({} as WorkspaceDrill);
  void _version;
  // A copy made before locked lines were stored takes them from its source.
  const source =
    historical?.templateId && isUniversalDrillId(historical.templateId)
      ? findUniversalDrill(historical.templateId)
      : undefined;
  const locked = historical?.lockedSafety ?? source?.content.safety;
  const minimumAge = historical?.minimumAge ?? source?.minimumAge;
  let content: AcademyDrillContent | undefined = historical?.content;
  if (value.content !== undefined) {
    content = mergeContent(value.content, historical?.content, locked ?? []);
    if (!content.safety?.length)
      throw fieldError(
        "Safety",
        "add at least one safety line. Safety guidance cannot be left empty.",
      );
  }
  return {
    ...kept,
    id,
    academyId: ctx.academy.id,
    sportId: value.sportId,
    name: value.name,
    focusArea: value.focusArea,
    purpose: value.purpose,
    cue: value.cue,
    ownership: "ACADEMY_CURRICULUM",
    ...(templateId ? { templateId } : {}),
    category,
    status: historical?.status ?? "ACTIVE",
    createdBy: historical?.createdBy ?? ctx.user.id,
    ...(locked?.length ? { lockedSafety: [...locked] } : {}),
    ...(minimumAge ? { minimumAge: { ...minimumAge } } : {}),
    ...(content ? { content } : {}),
  };
}

/**
 * Re-judged inside the write transaction, against the membership and the
 * stored record as they are now: role, ownership, archive state and the
 * version the editor saw.
 */
export function assertDrillWrite(
  ctx: WorkspaceAccess,
  recordId: string,
  expectedVersion: number | undefined,
) {
  requireRole(ctx, [...staff]);
  const previous = repo.find(ctx.academy.id, "drill", recordId);
  if (!previous) {
    if (expectedVersion !== undefined && expectedVersion !== 0)
      throw new WorkspaceError(
        409,
        "Record changed. Reload and review your unsaved draft before retrying.",
      );
    return;
  }
  assertManageable(ctx, previous);
  if (isArchived(previous))
    throw new WorkspaceError(409, "Restore this drill before editing it.");
  if (expectedVersion === undefined || expectedVersion !== previous.recordVersion)
    throw new WorkspaceError(
      409,
      "Record changed. Reload and review your unsaved draft before retrying.",
    );
}

/** Appends the revision for a drill write made through the record routes.
 * Called in the same transaction as the save. */
export function recordDrillWrite(
  ctx: WorkspaceAccess,
  drillId: string,
  before: WorkspaceDrill | undefined,
  context: string,
) {
  const after = repo.find(ctx.academy.id, "drill", drillId);
  if (after)
    recordDrillRevision(
      ctx.academy.id,
      { id: ctx.user.id, role: ctx.membership.role },
      before,
      after,
      context,
    );
}

/** The history of one academy drill: owner and admin, or the coach who
 * created it. */
export function drillHistory(ctx: WorkspaceAccess, drillId: string) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "drill");
  if (isUniversalDrillId(drillId)) throw new WorkspaceError(403, RESERVED);
  const drill = repo.find(ctx.academy.id, "drill", drillId);
  if (!drill) throw new WorkspaceError(404, "Drill not found in this academy.");
  assertManageable(ctx, drill);
  return { drillId, revisions: drillRevisionHistory(ctx.academy.id, drillId) };
}

// ------------------------------------------------------------------ actions

function freshContext(ctx: WorkspaceAccess): WorkspaceAccess {
  const membership = repo.membership(ctx.academy.id, ctx.user.id);
  if (!membership || membership.role !== ctx.membership.role)
    throw new WorkspaceError(403, "Membership is no longer active.");
  return { ...ctx, membership };
}

/**
 * One deterministic academy copy per catalogue drill. Customising again
 * returns the existing copy (archived or not); nothing is duplicated and the
 * catalogue entry is never touched. The copy keeps the catalogue drill's
 * safety lines and any minimum age for good.
 */
export function customiseDrill(ctx: WorkspaceAccess, universalId: string) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "drill");
  requireSport(ctx, "football");
  if (!isUniversalDrillId(universalId))
    throw new WorkspaceError(400, "Choose a drill from the universal library.");
  const source = findUniversalDrill(universalId);
  if (!source) throw new WorkspaceError(404, "Drill is not available.");
  // The same family-text limits apply to a copy as to any other drill.
  assertFamilyText(source.purpose, source.cue);
  return atomic(() => {
    const current = freshContext(ctx);
    const id = copyDrillId(universalId);
    const existing = repo.find(current.academy.id, "drill", id);
    if (existing) return { drill: existing, created: false as const };
    const record: WorkspaceDrill = {
      id,
      academyId: current.academy.id,
      sportId: "football",
      name: source.name,
      focusArea: source.focusArea,
      purpose: source.purpose,
      cue: source.cue,
      ownership: "ACADEMY_CURRICULUM",
      templateId: universalId,
      universalVersion: source.contentVersion,
      category: source.categoryId,
      status: "ACTIVE",
      createdBy: current.user.id,
      content: toAcademyContent(source),
      lockedSafety: [...source.content.safety],
      ...(source.minimumAge ? { minimumAge: { ...source.minimumAge } } : {}),
    };
    repo.save(current.academy.id, "drill", record);
    audit(
      current.academy.id,
      current.user.id,
      `Universal drill ${source.number} customised as an academy copy`,
      id,
    );
    const saved = repo.find(current.academy.id, "drill", id)!;
    recordDrillRevision(
      current.academy.id,
      { id: current.user.id, role: current.membership.role },
      undefined,
      saved,
      `Customised from universal Drill ${source.number} (content version ${source.contentVersion})`,
    );
    return { drill: saved, created: true as const };
  });
}

/** Archive or restore an academy drill. Idempotent. */
export function setDrillArchived(
  ctx: WorkspaceAccess,
  id: string,
  archived: boolean,
  expectedVersion?: number,
  options: { requireVersion?: boolean } = {},
) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "drill");
  if (isUniversalDrillId(id)) throw new WorkspaceError(403, RESERVED);
  return atomic(() => {
    const current = freshContext(ctx);
    const drill = repo.find(current.academy.id, "drill", id);
    if (!drill) throw new WorkspaceError(404, "Drill not found in this academy.");
    assertManageable(current, drill);
    if (options.requireVersion && expectedVersion === undefined)
      throw new WorkspaceError(
        400,
        "Version: reload the drill and try again so that nobody else's change is overwritten.",
      );
    if (expectedVersion !== undefined && expectedVersion !== drill.recordVersion)
      throw new WorkspaceError(
        409,
        "Record changed. Reload and review before retrying.",
      );
    if (isArchived(drill) === archived) return drill;
    const { recordVersion: _version, ...stored } = drill;
    void _version;
    repo.save(current.academy.id, "drill", {
      ...stored,
      status: archived ? "ARCHIVED" : "ACTIVE",
      ...(archived
        ? { archivedAt: now(), archivedBy: current.user.id }
        : { archivedAt: undefined, archivedBy: undefined }),
    });
    audit(
      current.academy.id,
      current.user.id,
      archived ? "Academy drill archived" : "Academy drill restored",
      id,
    );
    const saved = repo.find(current.academy.id, "drill", id)!;
    recordDrillRevision(
      current.academy.id,
      { id: current.user.id, role: current.membership.role },
      drill,
      saved,
      archived ? "Archived" : "Restored",
    );
    return saved;
  });
}
