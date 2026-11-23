import {
  assertDrillAgeRules,
  academyToday,
  assertDrillWrite,
  drillForPlanning,
  isLegacyTemplateId,
  legacyTemplateDrillId,
  parseDrillInput,
  prepareAcademyDrill,
  recordDrillWrite,
  resolveDrill,
} from "./drill-library-service";
import { generalNutritionGuidance } from "@/config/communication/nutrition-guidance";
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AcademyConfiguration,
  WorkspaceKind,
  WorkspacePayload,
  WorkspacePlan,
  WorkspaceReport,
  WorkspaceRecords,
  WorkspaceUpdate,
} from "@/domain/workspace";
import type { WorkspaceBootstrap } from "@/domain/home-summary";
import type { ReportViewModel } from "@/domain/report";
import { operationalSports } from "@/config/sports/workspace-sports";
import { reportTrainingSources } from "./training-service";
import {
  assembleMonthly,
  assertMonthlyCurrent,
  weeklySource,
} from "./period-service";
import { approvedReportPresentationData } from "@/services/reports/report-presentation";
import { measurementText } from "@/services/training-rules";
import { parentClosures, parentSchedule } from "./parent-schedule-service";
import { workspaceRepository as repo } from "./workspace-repository";
import { database, atomic, audit } from "./database";
import { lifecycleOf } from "./academy-lifecycle-state";
import { requireUnder18 } from "./player-age-service";
import {
  registerAcademyLifecycle,
  touchLifecycleForEdit,
} from "./academy-lifecycle";
import { LIFECYCLE_LABEL, type LifecycleState } from "@/domain/academy-lifecycle";
import {
  ARCHIVED_MESSAGE,
  isArchived,
  transitionNeedsManager,
} from "@/domain/player-lifecycle";
import { authenticatedUser, WorkspaceError } from "./auth";
import { isDecodablePng } from "./png-logo";
import { requireNoPrivateChat, viewerOf } from "./player-link-service";
import { isPlayerLinkLogin, requireNotPlayerLogin } from "./player-login";
import {
  access,
  requireRole,
  requireModule,
  requireSport,
  requirePlayer,
  requireOpenPlayer,
  visibleRecords,
  visibleRecord,
  withLookupScope,
  type AccessScope,
  type WorkspaceAccess,
} from "./workspace-access";
import {
  academySchema,
  academyUpdateSchema,
  playerSchema,
  planSchema,
  reportSchema,
  updateSchema,
  enquirySchema,
  conversionSchema,
} from "./workspace-schemas";
export const kinds: WorkspaceKind[] = [
  "weekly",
  "player",
  "plan",
  "report",
  "drill",
  "branch",
  "program",
  "update",
  "conversation",
  "fee",
  "preference",
  "dietary",
  "squad",
  "venue",
  "session",
  "attendance",
  "evidence",
  "series",
  "wrapup",
  "closure",
  "enquiry",
];
/** Kinds that exist but are left out of the default full payload: a session's
 * wrap-up text grows with every session held, and only the session desk reads
 * it. They load when asked for by name (`?kinds=wrapup`). */
const onDemandKinds: readonly WorkspaceKind[] = ["wrapup"];
const staff = ["OWNER", "ADMIN", "COACH"] as const;
const now = () => new Date().toISOString();
function academyReleaseView(
  academy: AcademyConfiguration,
  state: LifecycleState | undefined = lifecycleOf(academy.id)?.state,
): AcademyConfiguration {
  return {
    ...academy,
    configVersion: academy.configVersion ?? 0,
    location: academy.location ?? "",
    about: academy.about ?? "",
    phone: academy.phone ?? "",
    website: academy.website ?? "",
    weekStartsOn: academy.weekStartsOn ?? 1,
    dateFormat: academy.dateFormat ?? "DD_MMM_YYYY",
    timeFormat: academy.timeFormat ?? "12_HOUR",
    sportIds: academy.sportIds.filter((sport) => sport === "football"),
    legacyRecordsRestricted: academy.sportIds.some(
      (sport) => sport !== "football",
    ),
    // Kept for compatibility: derived from the approval lifecycle, which is
    // the only thing that decides it (the stored value is no longer read).
    onboardingStatus: state === "ACTIVE" ? "ACTIVE" : "CONFIGURING",
  };
}
export function workspaces(userId: string) {
  return database()
    .prepare(
      "SELECT a.config,m.role,m.id AS membershipId,l.state AS lifecycle FROM academy_workspaces a JOIN academy_memberships m ON m.academyId=a.id LEFT JOIN academy_lifecycle l ON l.academyId=a.id WHERE m.userId=? AND m.active=1 AND (m.expiresAt IS NULL OR m.expiresAt>?)",
    )
    .all(userId, now())
    .map((row) => ({
      academy: academyReleaseView(
        JSON.parse(String(row.config)) as AcademyConfiguration,
        (row.lifecycle as LifecycleState | null) ?? undefined,
      ),
      role: String(row.role),
      membershipId: String(row.membershipId),
      // Where the academy is in the approval workflow (null: no record).
      lifecycle: (row.lifecycle as LifecycleState | null) ?? null,
    }));
}
function region(config: ReturnType<typeof academySchema.parse>) {
  try {
    new Intl.DateTimeFormat(config.dateLocale, { timeZone: config.timezone });
    new Intl.NumberFormat(config.dateLocale, {
      style: "currency",
      currency: config.currency,
    });
  } catch {
    throw new WorkspaceError(
      400,
      "Choose valid regional formatting and time zone settings.",
    );
  }
}
function logo(config: { logoData?: string }, saved?: string) {
  // A stored logo that did not change is not re-checked; a new one must decode.
  if (
    config.logoData &&
    config.logoData !== saved &&
    !isDecodablePng(config.logoData)
  )
    throw new WorkspaceError(
      400,
      "The logo is not a valid PNG image. Choose a different PNG file.",
    );
}
export async function createAcademy(headers: Headers, input: unknown) {
  const user = await authenticatedUser(headers),
    value = academySchema.parse(input);
  region(value);
  logo(value);
  const id = randomUUID();
  const academy: AcademyConfiguration = {
    ...value,
    configVersion: 0,
    id,
    academyId: id,
    nutritionOptional: true,
    onboardingStatus: "CONFIGURING",
  };
  atomic(() => {
    database()
      .prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)")
      .run(id, JSON.stringify(academy));
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES(?,?,?,?,1)",
      )
      .run(randomUUID(), id, user.id, "OWNER");
    database()
      .prepare(
        "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)",
      )
      .run(id, "LOCAL_FOUNDATION", JSON.stringify(value.modules), "ACTIVE");
    // Every new academy starts in CONFIGURING and waits for a platform
    // administrator before it can run operations (docs/ACADEMY_APPROVAL.md).
    registerAcademyLifecycle(id, user.id, 0);
    audit(id, user.id, "Academy created; empty workspace");
  });
  return academy;
}
/** Whether each unapproved monthly report's saved sources still match the
 * academy's current training records. Staff only; parents get no entries. */
export function monthlyReportReviewFor(
  ctx: WorkspaceAccess,
  reports: WorkspaceReport[],
): NonNullable<WorkspacePayload["monthlyReportReview"]> {
  const review: NonNullable<WorkspacePayload["monthlyReportReview"]> = {};
  if (!["OWNER", "ADMIN", "COACH"].includes(ctx.membership.role)) return review;
  for (const report of reports) {
    if (!report.monthlySources || report.status === "Approved") continue;
    try {
      assertMonthlyCurrent(ctx, report);
      review[report.id] = { sourcesCurrent: true };
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      review[report.id] = { sourcesCurrent: false, reason: error.message };
    }
  }
  return review;
}
/** Reads the optional `kinds` query value (comma separated record kinds). */
export function parseKinds(value: string | null): WorkspaceKind[] | undefined {
  if (value === null) return undefined;
  const requested = value.split(",").map((kind) => kind.trim());
  if (
    !requested.length ||
    requested.some((kind) => !kinds.includes(kind as WorkspaceKind))
  )
    throw new WorkspaceError(400, "Unknown record kind requested.");
  return [...new Set(requested)] as WorkspaceKind[];
}
/** The small payload a portal needs to open: the academy, the viewer's
 * membership and identity. These are the same values the full payload carries
 * and they are already loaded by the access check, so no extra reads occur. */
export function workspaceBootstrap(ctx: WorkspaceAccess): WorkspaceBootstrap {
  const state = ctx.lifecycleState ?? lifecycleOf(ctx.academy.id)?.state;
  return {
    academy: academyReleaseView(ctx.academy, state),
    viewer: viewerOf(ctx),
    membership: ctx.membership,
    // Present only while the academy is still being set up or reviewed; an
    // approved academy's bootstrap is unchanged.
    ...(state && state !== "ACTIVE"
      ? { lifecycle: { state, label: LIFECYCLE_LABEL[state] } }
      : {}),
  };
}
/**
 * The academy payload. `only` limits which record kinds are read, for screens
 * that use a few of them; the other kinds come back empty and the payload
 * lists `loadedKinds`. Each loaded kind is exactly what the full payload
 * carries for the viewer. Without `only` the payload is unchanged.
 */
export function workspace(
  ctx: WorkspaceAccess,
  only?: WorkspaceKind[],
): WorkspacePayload {
  return withLookupScope(() => workspacePayload(ctx, only));
}
function workspacePayload(
  ctx: WorkspaceAccess,
  only?: WorkspaceKind[],
): WorkspacePayload {
  const records = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      (only ? only.includes(kind) : !onDemandKinds.includes(kind))
        ? visibleRecords(ctx, kind)
        : [],
    ]),
  ) as WorkspacePayload["records"];
  const monthlyReportReview = monthlyReportReviewFor(ctx, records.report);
  records.update = records.update.map((record) => {
    if (record.approvalStatus !== "APPROVED") return record;
    const approval = database()
      .prepare(
        "SELECT at FROM update_approval_history WHERE academyId=? AND updateId=? AND version=? ORDER BY at DESC LIMIT 1",
      )
      .get(ctx.academy.id, record.id, record.version);
    return {
      ...record,
      approvedAt: approval ? String(approval.at) : undefined,
    };
  });
  const members = ["OWNER", "ADMIN", "COACH"].includes(ctx.membership.role)
    ? database()
        .prepare(
          `SELECT m.id,m.userId,m.role,m.active,u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId WHERE m.academyId=? AND (?<>'COACH' OR m.userId=? OR m.role IN ('OWNER','ADMIN') OR (m.role='PARENT' AND EXISTS(SELECT 1 FROM guardian_relationships g JOIN workspace_records p ON p.academyId=g.academyId AND p.id=g.playerId AND p.kind='player' WHERE g.academyId=m.academyId AND g.userId=m.userId AND json_extract(p.body,'$.coachId')=? AND EXISTS(SELECT 1 FROM json_each(p.body,'$.sportIds') WHERE value='football'))))`,
        )
        .all(ctx.academy.id, ctx.membership.role, ctx.user.id, ctx.user.id)
        .map((r) => ({
          id: String(r.id),
          userId: String(r.userId),
          role: r.role as WorkspacePayload["members"][number]["role"],
          active: Boolean(r.active),
          name: String(r.name),
        }))
    : [];
  const entitlement = ["OWNER", "ADMIN"].includes(ctx.membership.role)
    ? database()
        .prepare(
          "SELECT tier,status,modules FROM platform_entitlements WHERE academyId=?",
        )
        .get(ctx.academy.id)
    : undefined;
  return {
    academy: academyReleaseView(ctx.academy, ctx.lifecycleState),
    viewer: viewerOf(ctx),
    membership: ctx.membership,
    ...(only ? { loadedKinds: only } : {}),
    ...(["OWNER", "ADMIN", "COACH"].includes(ctx.membership.role)
      ? { monthlyReportReview }
      : {}),
    ...(ctx.membership.role === "PARENT"
      ? {
          parentSchedule: parentSchedule(ctx),
          parentClosures: parentClosures(ctx),
        }
      : {}),
    records,
    members,
    ...(["OWNER", "ADMIN", "COACH"].includes(ctx.membership.role)
      ? {
          guardians: database()
            .prepare(
              'SELECT g.playerId,g.userId,u.name FROM guardian_relationships g JOIN "user" u ON u.id=g.userId JOIN academy_memberships m ON m.academyId=g.academyId AND m.userId=g.userId AND m.active=1 WHERE g.academyId=?',
            )
            .all(ctx.academy.id)
            .filter((row) => records.player.some((p) => p.id === row.playerId))
            .map((row) => ({
              playerId: String(row.playerId),
              userId: String(row.userId),
              name: String(row.name),
            })),
        }
      : {}),
    ...(entitlement
      ? {
          subscription: {
            tier: String(entitlement.tier),
            status: String(entitlement.status),
            modules: JSON.parse(String(entitlement.modules)) as string[],
          },
        }
      : {}),
  };
}
export function updateAcademy(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const { expectedVersion } = z
    .object({ expectedVersion: z.number().int().nonnegative() })
    .parse(input);
  return atomic(() => {
    const membership = repo.membership(ctx.academy.id, ctx.user.id);
    if (!membership)
      throw new WorkspaceError(403, "Membership is no longer active.");
    requireRole({ ...ctx, membership }, ["OWNER", "ADMIN"]);
    const row = database()
      .prepare("SELECT config FROM academy_workspaces WHERE id=?")
      .get(ctx.academy.id);
    if (!row) throw new WorkspaceError(404, "Academy is unavailable.");
    const previous = JSON.parse(String(row.config)) as AcademyConfiguration;
    if ((previous.configVersion ?? 0) !== expectedVersion)
      throw new WorkspaceError(
        409,
        "Academy configuration changed. Review the saved values before retrying your draft.",
      );
    const submitted = typeof input === "object" && input !== null ? input : {};
    const parsed = academyUpdateSchema.safeParse({
      ...previous,
      sportIds: ["football"],
      ...submitted,
    });
    if (!parsed.success) {
      // Only fields this request supplied are the client's mistake; a stored
      // value that no longer validates is reported as an internal failure.
      if (parsed.error.issues.some((i) => !(String(i.path[0]) in submitted)))
        throw new Error("Stored academy configuration failed validation.");
      throw parsed.error;
    }
    const { expectedVersion: _expected, ...value } = parsed.data;
    void _expected;
    region(value);
    logo(value, previous.logoData);
    // Keep historical enrolments/configuration; a default timezone change does
    // not rewrite branches, sessions, resolved instants or report snapshots.
    const academy: AcademyConfiguration = {
      ...previous,
      ...value,
      id: ctx.academy.id,
      academyId: ctx.academy.id,
      configVersion: expectedVersion + 1,
      sportIds: [
        "football",
        ...previous.sportIds.filter((sport) => sport !== "football"),
      ],
    };
    const result = database()
      .prepare("UPDATE academy_workspaces SET config=? WHERE id=? AND config=?")
      .run(JSON.stringify(academy), ctx.academy.id, String(row.config));
    if (result.changes !== 1)
      throw new WorkspaceError(
        409,
        "Academy configuration changed. Review the saved values before retrying your draft.",
      );
    audit(ctx.academy.id, ctx.user.id, "Academy configuration updated");
    // An edit while the application is being reviewed makes any decision made
    // on the earlier profile stale.
    touchLifecycleForEdit(ctx.academy.id);
    const confirmed = repo.academy(ctx.academy.id);
    if (!confirmed || confirmed.configVersion !== expectedVersion + 1)
      throw new WorkspaceError(
        500,
        "The saved academy configuration could not be confirmed.",
      );
    return academyReleaseView(confirmed, ctx.lifecycleState);
  });
}
function coach(ctx: WorkspaceAccess, userId: string) {
  const m = repo.membership(ctx.academy.id, userId);
  if (!m || !staff.includes(m.role as (typeof staff)[number]))
    throw new WorkspaceError(
      400,
      "Assign an active staff member in this academy.",
    );
  if (ctx.membership.role === "COACH" && userId !== ctx.user.id)
    throw new WorkspaceError(403, "Coaches can assign their own player plans.");
}
function planLinks(
  ctx: WorkspaceAccess,
  p: WorkspacePlan,
  existingDrills: ReadonlySet<string> = new Set(),
) {
  const player = requireOpenPlayer(ctx, p.playerId);
  requireSport(ctx, p.sportId);
  if (!player.sportIds.includes(p.sportId))
    throw new WorkspaceError(400, "Player is not enrolled in this sport.");
  coach(ctx, p.coachId);
  if (!operationalSports[p.sportId].skills.includes(p.focus))
    throw new WorkspaceError(
      400,
      "Choose a skill from this sport configuration.",
    );
  const planned = [];
  for (const id of p.drillIds) {
    // A universal or an academy drill; an archived one only where the plan
    // already had it.
    let drill;
    try {
      drill = drillForPlanning(ctx, id, existingDrills);
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 404)
        throw new WorkspaceError(
          400,
          "Every drill must belong to this academy and sport.",
        );
      throw error;
    }
    if (drill.sportId !== p.sportId)
      throw new WorkspaceError(
        400,
        "Every drill must belong to this academy and sport.",
      );
    planned.push(drill);
  }
  // A drill with an internal minimum age is checked for the plan's player.
  assertDrillAgeRules(ctx, planned, [p.playerId], academyToday(ctx));
}
/**
 * The player lifecycle rules for a save (see domain/player-lifecycle.ts):
 * an archived profile can only be restored, and only an owner or admin moves a
 * player into or out of PAUSED or ARCHIVED.
 */
function assertStatusChange(
  ctx: WorkspaceAccess,
  previous: WorkspaceRecords["player"] | undefined,
  nextStatus: string,
) {
  const from = previous?.status ?? "ACTIVE";
  if (isArchived(from) && isArchived(nextStatus))
    throw new WorkspaceError(409, ARCHIVED_MESSAGE);
  if (transitionNeedsManager(from, nextStatus))
    requireRole(ctx, ["OWNER", "ADMIN"]);
}
const banned =
  /weight.loss|calorie.restrict|medical.diet|supplement|prescri|diagnos|treat(?:ment)?|injury.recovery.diet/i;
export function saveRecord(
  ctx: WorkspaceAccess,
  kind: WorkspaceKind,
  input: unknown,
  id: string = randomUUID(),
) {
  requireModule(ctx, kind);
  const base = { id, academyId: ctx.academy.id };
  let legacyDrillId: string | undefined;
  let record: WorkspaceRecords[WorkspaceKind];
  if (!["preference", "dietary", "conversation"].includes(kind))
    requireRole(ctx, [...staff]);
  switch (kind) {
    case "player": {
      const {
        expectedVersion: _version,
        placementReviewed,
        ...value
      } = playerSchema.parse(input);
      void _version;
      value.sportIds.forEach((s) => requireSport(ctx, s));
      coach(ctx, value.coachId);
      const historical = repo.find(ctx.academy.id, "player", id);
      if (historical) requirePlayer(ctx, id);
      assertStatusChange(
        ctx,
        historical,
        value.status ?? historical?.status ?? "ACTIVE",
      );
      // Players are under 18 and always have a date of birth (see player-age-service.ts).
      requireUnder18(
        {
          birthDate:
            value.birthDate !== undefined
              ? value.birthDate
              : historical?.birthDate,
          status: value.status ?? historical?.status ?? "ACTIVE",
        },
        academyToday(ctx),
        historical?.ageDecision,
      );
      const nextSquadId = value.squadId ?? historical?.squadId ?? "";
      const batchChanged = nextSquadId !== (historical?.squadId ?? "");
      const rosterOnlyUnassignment =
        !!historical &&
        !historical.squadId &&
        value.squadId === "" &&
        repo
          .list(ctx.academy.id, "squad")
          .some(
            (squad) =>
              squad.sportId === "football" &&
              squad.playerIds.includes(historical.id),
          );
      const placementChanged =
        batchChanged ||
        rosterOnlyUnassignment ||
        (!!historical &&
          value.squad !== undefined &&
          value.squad !== historical.squad);
      if (placementChanged) {
        requireRole(ctx, ["OWNER", "ADMIN"]);
        if (historical && !placementReviewed)
          throw new WorkspaceError(
            400,
            "Review the training-batch placement before applying this change. Age category is independent.",
          );
      }
      let nextSquad = value.squad ?? historical?.squad ?? "";
      if (nextSquadId && (!historical || batchChanged)) {
        const squad = visibleRecord(ctx, "squad", nextSquadId);
        if (squad.sportId !== "football")
          throw new WorkspaceError(
            400,
            "Choose a football batch in this academy.",
          );
        // Resolve new placements from the academy's saved batch. Ordinary
        // edits retain legacy labels; current UI display resolves by squadId.
        nextSquad = squad.name;
      }
      record = {
        ...historical,
        recordVersion: undefined,
        ...base,
        ...value,
        ...(value.squadId !== undefined || !historical
          ? { squadId: nextSquadId }
          : {}),
        squad: nextSquad,
        position: value.position ?? historical?.position ?? "",
        status: value.status ?? historical?.status ?? "ACTIVE",
        sportIds: [
          "football",
          ...(historical?.sportIds.filter((sport) => sport !== "football") ??
            []),
        ],
      };
      break;
    }
    case "enquiry": {
      requireRole(ctx, ["OWNER", "ADMIN"]);
      const { expectedVersion, ...value } = enquirySchema.parse(input);
      const historical = repo.find(ctx.academy.id, "enquiry", id);
      if (historical) {
        if (historical.status === "CONVERTED")
          throw new WorkspaceError(
            409,
            "This enquiry was already converted to a player.",
          );
        if (expectedVersion !== historical.recordVersion)
          throw new WorkspaceError(
            409,
            "Enquiry changed. Reload and review your unsaved edit before retrying.",
          );
      }
      record = {
        ...base,
        ...value,
        followUpDate: value.followUpDate || undefined,
        closedReason:
          value.status === "CLOSED" ? value.closedReason?.trim() : undefined,
        createdAt: historical?.createdAt ?? now(),
        updatedAt: now(),
      };
      break;
    }
    case "plan": {
      const { expectedVersion: _expected, ...data } = planSchema.parse(input);
      void _expected;
      const value = { ...base, ...data };
      planLinks(
        ctx,
        value,
        new Set(repo.find(ctx.academy.id, "plan", id)?.drillIds ?? []),
      );
      record = value;
      break;
    }
    case "report": {
      if (repo.find(ctx.academy.id, "report", id)?.monthlySources)
        throw new WorkspaceError(
          409,
          "Use the monthly review editor to preserve period sources.",
        );
      const { expectedVersion: _expected, ...value } =
        reportSchema.parse(input);
      void _expected;
      const plan = visibleRecord(ctx, "plan", value.planId);
      if (plan.playerId !== value.playerId || plan.sportId !== value.sportId)
        throw new WorkspaceError(
          400,
          "Report must match its player and sport plan.",
        );
      requireOpenPlayer(ctx, value.playerId);
      requireSport(ctx, value.sportId);
      reportTrainingSources(ctx, {
        ...base,
        ...value,
        status: "Draft",
        externalDeliveryStatus: "NOT_SENT",
      });
      record = {
        ...base,
        ...value,
        status: "Draft",
        externalDeliveryStatus: "NOT_SENT",
      };
      break;
    }
    case "drill": {
      const value = parseDrillInput(input);
      // A legacy platform template always becomes ONE deterministic, categorised
      // drill: repeating the request returns it instead of making another.
      if (
        !repo.find(ctx.academy.id, "drill", id) &&
        isLegacyTemplateId(value.templateId)
      ) {
        legacyDrillId = legacyTemplateDrillId(value.templateId);
        const already = repo.find(ctx.academy.id, "drill", legacyDrillId);
        if (already) return already;
      }
      // Judged here against the stored drill and again inside the write
      // transaction below (membership, ownership, archive state and version).
      record = prepareAcademyDrill(ctx, legacyDrillId ?? id, value);
      break;
    }
    case "branch": {
      requireRole(ctx, ["OWNER", "ADMIN"]);
      const value = z
        .object({
          name: z.string().trim().min(2).max(200),
          timezone: z.string().max(100),
        })
        .parse(input);
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone });
      } catch {
        throw new WorkspaceError(400, "Invalid branch time zone.");
      }
      // The same branch twice is almost always a repeated click. Refuse it
      // (case-insensitively) instead of storing a duplicate.
      if (
        repo
          .list(ctx.academy.id, "branch")
          .some(
            (b) =>
              b.id !== id &&
              b.name.trim().toLowerCase() === value.name.toLowerCase(),
          )
      )
        throw new WorkspaceError(
          409,
          `A branch named “${value.name}” already exists.`,
        );
      record = { ...base, ...value };
      break;
    }
    case "program": {
      requireRole(ctx, ["OWNER", "ADMIN"]);
      const value = z
        .object({
          name: z.string().min(2).max(200),
          sportId: z.literal("football").default("football"),
          branchId: z.string(),
        })
        .parse(input);
      requireSport(ctx, value.sportId);
      if (!repo.find(ctx.academy.id, "branch", value.branchId))
        throw new WorkspaceError(400, "Choose a branch in this academy.");
      if (
        repo
          .list(ctx.academy.id, "program")
          .some(
            (p) =>
              p.id !== id &&
              p.branchId === value.branchId &&
              p.name.trim().toLowerCase() === value.name.trim().toLowerCase(),
          )
      )
        throw new WorkspaceError(
          409,
          `A programme named “${value.name.trim()}” already exists in this branch.`,
        );
      record = { ...base, ...value, name: value.name.trim() };
      break;
    }
    case "update": {
      const value = updateSchema.parse(input);
      requireOpenPlayer(ctx, value.playerId);
      requireSport(ctx, value.sportId);
      const sourceReport = value.sourceReportId
        ? repo.find(ctx.academy.id, "report", value.sourceReportId)
        : undefined;
      if (
        value.sourceReportId &&
        (!sourceReport ||
          sourceReport.playerId !== value.playerId ||
          sourceReport.sportId !== value.sportId ||
          sourceReport.status !== "Approved" ||
          !sourceReport.snapshot)
      )
        throw new WorkspaceError(
          400,
          "Choose the player's approved sport report.",
        );
      if (value.planId) {
        const p = visibleRecord(ctx, "plan", value.planId);
        if (p.playerId !== value.playerId || p.sportId !== value.sportId)
          throw new WorkspaceError(400, "Update plan does not match.");
      } else if (
        !sourceReport?.monthlySources ||
        sourceReport.planId ||
        !["DEVELOPMENT", "REVIEWED_SESSION"].includes(value.type)
      ) {
        throw new WorkspaceError(
          400,
          "A development plan or an approved batch-only monthly report is required.",
        );
      }
      if (banned.test(value.messageBody))
        throw new WorkspaceError(
          400,
          "Medical or unsupported nutrition recommendations are not allowed.",
        );
      if (value.sourceWeeklyPlanId) {
        const source = weeklySource(ctx, value.sourceWeeklyPlanId);
        if (
          value.type !== "UPCOMING_TRAINING" ||
          source.playerId !== value.playerId ||
          value.sourceReportId
        )
          throw new WorkspaceError(
            400,
            "Choose one weekly source for this player's upcoming training.",
          );
      }
      if (value.sourceReportId) {
        const r = sourceReport;
        if (
          !r ||
          r.playerId !== value.playerId ||
          r.sportId !== value.sportId ||
          r.status !== "Approved"
        )
          throw new WorkspaceError(
            400,
            "Choose the player's approved sport report.",
          );
        if (value.type === "REVIEWED_SESSION" && !r.sourceEvidenceIds?.length)
          throw new WorkspaceError(
            400,
            "Select a report based on reviewed completed-session evidence.",
          );
        if (value.type === "UPCOMING_TRAINING" && !r.approvedPlan)
          throw new WorkspaceError(
            400,
            "An approved plan snapshot is required.",
          );
      }
      const existing = repo.find(ctx.academy.id, "update", id);
      record = {
        ...base,
        ...value,
        version: (existing?.version ?? 0) + 1,
        approvalStatus: "DRAFT",
        inAppPublicationStatus: "UNPUBLISHED",
        externalDeliveryStatus: "NOT_SENT",
      };
      break;
    }
    case "conversation": {
      requireRole(ctx, [...staff, "PARENT"]);
      requireNoPrivateChat(ctx);
      const value = z
        .object({
          playerId: z.string(),
          guardianId: z.string(),
          subject: z.string().min(2).max(200),
          updateId: z.string().optional(),
        })
        .parse(input);
      requirePlayer(ctx, value.playerId);
      if (ctx.membership.role === "PARENT" && value.guardianId !== ctx.user.id)
        throw new WorkspaceError(
          403,
          "Only your own private conversation can be created.",
        );
      // Staff do not open private one-to-one conversations with a child's own login: it is the parent or guardian they write to.
      if (isPlayerLinkLogin(ctx.academy.id, value.guardianId))
        throw new WorkspaceError(
          403,
          "Private messages cannot be addressed to a player's own login. Write to the player's parent or guardian.",
        );
      if (
        !database()
          .prepare(
            "SELECT 1 FROM guardian_relationships WHERE academyId=? AND userId=? AND playerId=?",
          )
          .get(ctx.academy.id, value.guardianId, value.playerId)
      )
        throw new WorkspaceError(
          403,
          "An authorised guardian relationship is required.",
        );
      if (value.updateId) {
        const update = visibleRecord(ctx, "update", value.updateId);
        if (
          update.playerId !== value.playerId ||
          update.approvalStatus !== "APPROVED" ||
          update.inAppPublicationStatus !== "PUBLISHED"
        )
          throw new WorkspaceError(
            403,
            "Choose this child’s published update.",
          );
      }
      record = { ...base, ...value, status: "OPEN", messages: [] };
      break;
    }
    case "preference": {
      requireRole(ctx, ["PARENT"]);
      const value = z
        .object({
          nutrition: z.boolean(),
          development: z.boolean(),
          inApp: z.boolean(),
          language: z.string().max(50),
          quietStart: z.string().regex(/^(?:\d\d:\d\d)?$/),
          quietEnd: z.string().regex(/^(?:\d\d:\d\d)?$/),
        })
        .parse(input);
      record = {
        ...base,
        id: ctx.user.id,
        userId: ctx.user.id,
        ...value,
        externalEnabled: false,
      };
      break;
    }
    case "dietary": {
      requireRole(ctx, ["PARENT"]);
      requireNotPlayerLogin(ctx, "Dietary notes");
      const value = z
        .object({ playerId: z.string(), note: z.string().max(2000) })
        .parse(input);
      requireOpenPlayer(ctx, value.playerId);
      record = {
        ...base,
        id: `${ctx.user.id}-${value.playerId}`,
        userId: ctx.user.id,
        ...value,
      };
      break;
    }
    case "fee": {
      requireRole(ctx, ["OWNER", "ADMIN"]);
      const value = z
        .object({
          playerId: z.string(),
          amountMinor: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
          currency: z.string().regex(/^[A-Z]{3}$/),
          label: z.string().min(1).max(200),
        })
        .parse(input);
      requireOpenPlayer(ctx, value.playerId);
      record = { ...base, ...value };
      break;
    }
    default:
      throw new WorkspaceError(400, "Unsupported record kind.");
  }
  atomic(() => {
    if (kind === "drill") {
      const membership = repo.membership(ctx.academy.id, ctx.user.id);
      if (!membership)
        throw new WorkspaceError(403, "Membership is no longer active.");
      // The deterministic legacy drill may have been made while this request
      // waited: that is a repeat, not an error.
      if (legacyDrillId && repo.find(ctx.academy.id, "drill", record.id)) return;
      assertDrillWrite(
        { ...ctx, membership },
        record.id,
        parseDrillInput(input).expectedVersion,
      );
    }
    if (kind === "player" || kind === "plan" || kind === "report") {
      const expected = (
        kind === "player"
          ? playerSchema
          : kind === "plan"
            ? planSchema
            : reportSchema
      ).parse(input).expectedVersion;
      const current = Number(
        database()
          .prepare(
            "SELECT version FROM workspace_records WHERE academyId=? AND kind=? AND id=?",
          )
          .get(ctx.academy.id, kind, record.id)?.version ?? 0,
      );
      if (
        (kind === "player" && current > 0 && expected === undefined) ||
        (expected !== undefined && expected !== current)
      )
        throw new WorkspaceError(
          409,
          "Record changed. Reload and review your unsaved draft before retrying.",
        );
    }
    if (kind === "player") {
      const membership = repo.membership(ctx.academy.id, ctx.user.id);
      if (!membership)
        throw new WorkspaceError(403, "Membership is no longer active.");
      requireRole({ ...ctx, membership }, [...staff]);
      const previous = repo.find(ctx.academy.id, "player", record.id);
      const next = record as WorkspaceRecords["player"];
      const requestedPlacement = playerSchema.parse(input);
      const currentContext = { ...ctx, membership };
      requireSport(currentContext, "football");
      if (previous) requirePlayer(currentContext, record.id);
      coach(currentContext, next.coachId);
      if (previous && next.squad !== previous.squad)
        requireRole(currentContext, ["OWNER", "ADMIN"]);
      // Re-judged with the membership read inside the transaction.
      assertStatusChange(currentContext, previous, next.status ?? "ACTIVE");
      if ((previous?.status ?? "ACTIVE") !== (next.status ?? "ACTIVE"))
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Player status changed from ${previous?.status ?? "ACTIVE"} to ${next.status ?? "ACTIVE"}`,
          record.id,
        );
      const batchChanged = (previous?.squadId ?? "") !== (next.squadId ?? "");
      const currentRosterBatches =
        batchChanged || requestedPlacement.squadId === ""
          ? repo
              .list(ctx.academy.id, "squad")
              .filter(
                (squad) =>
                  squad.sportId === "football" &&
                  squad.playerIds.includes(record.id),
              )
          : [];
      const rosterUnassignment =
        requestedPlacement.squadId === "" && currentRosterBatches.length > 0;
      if (batchChanged || rosterUnassignment) {
        requireRole({ ...ctx, membership }, ["OWNER", "ADMIN"]);
        if (previous && !requestedPlacement.placementReviewed)
          throw new WorkspaceError(
            400,
            "Review the training-batch placement before applying this change. Age category is independent.",
          );
        for (const squadId of new Set(
          [
            previous?.squadId,
            ...currentRosterBatches.map((squad) => squad.id),
            next.squadId,
          ].filter((value): value is string => !!value),
        )) {
          const squad = repo.find(ctx.academy.id, "squad", squadId);
          if (!squad)
            throw new WorkspaceError(
              409,
              "The training batch changed. Review the current batch before retrying.",
            );
          const playerIds = squad.playerIds.filter(
            (playerId) => playerId !== record.id,
          );
          if (squadId === next.squadId) playerIds.push(record.id);
          repo.save(ctx.academy.id, "squad", {
            ...squad,
            playerIds,
            version: squad.version + 1,
            updatedAt: now(),
            updatedBy: ctx.user.id,
          });
        }
        audit(
          ctx.academy.id,
          ctx.user.id,
          "Reviewed player training-batch placement; historical session rosters unchanged",
          record.id,
        );
      }
    }
    const beforeDrill =
      kind === "drill"
        ? repo.find(ctx.academy.id, "drill", record.id)
        : undefined;
    repo.save(ctx.academy.id, kind, record);
    if (kind === "drill") {
      audit(
        ctx.academy.id,
        ctx.user.id,
        `Academy drill ${beforeDrill ? "edited" : "created"}`,
        record.id,
      );
      recordDrillWrite(
        { ...ctx, membership: repo.membership(ctx.academy.id, ctx.user.id)! },
        record.id,
        beforeDrill,
        beforeDrill
          ? "Edited"
          : legacyDrillId
            ? `Created from legacy template ${parseDrillInput(input).templateId}`
            : "Created",
      );
      return;
    }
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Record saved; approval cleared for edited reports/updates",
      record.id,
    );
  });
  return kind === "plan" || kind === "player" || kind === "enquiry" || kind === "drill"
    ? {
        ...repo.find(ctx.academy.id, kind, record.id)!,
        ...(kind === "player" ? { sportIds: ["football"] } : {}),
      }
    : "sportIds" in record
      ? { ...record, sportIds: ["football"] }
      : record;
}
export function approveReport(
  ctx: WorkspaceAccess,
  id: string,
  verified: boolean,
  expectedVersion?: number,
) {
  requireRole(ctx, [...staff]);
  if (!verified)
    throw new WorkspaceError(400, "Verify the source records before approval.");
  const report = visibleRecord(ctx, "report", id),
    plan = report.planId
      ? visibleRecord(ctx, "plan", report.planId)
      : undefined,
    player = requirePlayer(ctx, report.playerId);
  if (!plan && !report.monthlySources)
    throw new WorkspaceError(
      400,
      "A recorded development plan is required for non-monthly reports.",
    );
  if (expectedVersion !== undefined && expectedVersion !== report.recordVersion)
    throw new WorkspaceError(
      409,
      "Report changed. Review its current sources before approval.",
    );
  if (report.status === "Approved")
    throw new WorkspaceError(
      409,
      "Edit and save a draft before approving a new report version.",
    );
  if (plan) planLinks(ctx, plan, new Set(plan.drillIds));
  if (report.monthlySources && !report.nextStep.trim())
    throw new WorkspaceError(
      400,
      "Record and save a next development step before approving this monthly report.",
    );
  const assigned = (plan?.drillIds ?? []).map((id) => resolveDrill(ctx, id));
  const trainingSources = reportTrainingSources(ctx, report);
  if (
    report.monthlySources &&
    new Date().toISOString() < report.monthlySources.period.endAt
  )
    throw new WorkspaceError(
      409,
      "Wait until the reporting month ends before final approval.",
    );
  assertMonthlyCurrent(ctx, report);
  const coachName = database()
    .prepare('SELECT name FROM "user" WHERE id=?')
    .get(plan?.coachId ?? player.coachId)?.name;
  let approvedPlan: WorkspaceReport["approvedPlan"];
  if (plan) {
    const { privateNote: _private, ...publicPlan } = plan;
    void _private;
    approvedPlan = publicPlan;
  }
  const snapshot: ReportViewModel = {
    reportId: report.id,
    playerId: player.id,
    academy: ctx.academy.name,
    brandAccent: ctx.academy.brandAccent,
    logoData: ctx.academy.logoData || undefined,
    player: player.name,
    period:
      report.period + (report.correctionOf ? " · Reviewed correction" : ""),
    status: "Approved",
    externalDelivery: "Not sent",
    demo: ctx.academy.demo,
    sport: operationalSports[report.sportId].name,
    squad: player.squad || undefined,
    ageCategory: player.ageCategory || undefined,
    coach: coachName ? String(coachName) : undefined,
    focus: plan?.focus ?? report.monthlySources!.model.focus,
    reviewedReason: plan?.reason,
    practised: trainingSources.length
      ? [...new Set(trainingSources.map((e) => e.drillName))].join("; ")
      : assigned.length
        ? assigned.map((d) => d.name).join("; ")
        : (plan?.focus ?? report.monthlySources!.model.practised),
    activities: trainingSources.length
      ? trainingSources.map((e) => {
          const a = repo
            .find(ctx.academy.id, "session", e.sessionId)!
            .agenda.find((a) => a.drill.id === e.drillId)!;
          return {
            name: a.drill.name,
            purpose: a.drill.purpose,
            cue: a.drill.cue,
            drillId: a.drill.id,
          };
        })
      : assigned.map((d) => ({
          name: d.name,
          purpose: d.purpose,
          cue: d.cue,
          drillId: d.id,
        })),
    evidence: trainingSources.length
      ? trainingSources.map((e) => ({
          text: `${e.observation.replace(/[.!?]\s*$/, "")}. ${measurementText(e)}. Conditions: ${e.conditions.replace(/[.!?]\s*$/, "")}. Recorded attendance: ${repo.find(ctx.academy.id, "attendance", `${e.sessionId}:${e.playerId}`)?.status ?? "UNMARKED"}. No video attached.`,
          source: `${e.type.replaceAll("_", " ")} - reviewed ${e.reviewedAt}`,
          reference: `Session ${e.sessionId}; evidence ${e.id}; drill version ${e.drillVersion}`,
        }))
      : [
          {
            text: report.observation,
            source:
              report.evidenceType === "AI_ESTIMATE"
                ? "AI estimate - coach reviewed"
                : report.evidenceType.replaceAll("_", " ").toLowerCase(),
          },
        ],
    nextStep: report.nextStep,
    observationCriteria: plan?.observe,
    reviewDate: plan?.reviewDate,
    note: report.closingNote,
  };
  // A report that was withdrawn and is approved again no longer carries the
  // withdrawal note (the audit log keeps it); it is internal, never for families.
  const { withdrawal: _withdrawn, ...current } = report;
  void _withdrawn;
  const approved: WorkspaceReport = {
    ...current,
    status: "Approved",
    snapshot,
    approvedPlan,
    externalDeliveryStatus: "NOT_SENT",
  };
  if (report.monthlySources) {
    Object.assign(snapshot, report.monthlySources.model);
    snapshot.evidence = [
      ...report.monthlySources.model.evidence,
      ...(report.observation.trim()
        ? [{ text: report.observation, source: "Coach reviewed commentary" }]
        : []),
    ];
    snapshot.presentationData = {
      ...assembleMonthly(ctx, report.playerId, report.monthlySources.period.key)
        .model.presentationData!,
      coachEvaluation: report.observation.trim() ? [report.observation] : [],
    };
  } else if (trainingSources.length) {
    snapshot.presentationData = approvedReportPresentationData({
      evidence: trainingSources,
      sessions: trainingSources.map((e) =>
        repo.find(ctx.academy.id, "session", e.sessionId)!,
      ),
      timezone: ctx.academy.timezone,
      coachEvaluation: report.observation.trim() ? [report.observation] : [],
    });
  }
  atomic(() => {
    if (
      repo.find(ctx.academy.id, "report", id)?.recordVersion !==
      report.recordVersion
    )
      throw new WorkspaceError(
        409,
        "Report changed during approval. Review again.",
      );
    if (
      plan &&
      repo.find(ctx.academy.id, "plan", plan.id)?.recordVersion !==
        plan.recordVersion
    )
      throw new WorkspaceError(
        409,
        "The source plan changed during review. Review its current version.",
      );
    reportTrainingSources(ctx, report);
    assertMonthlyCurrent(ctx, report);
    repo.save(ctx.academy.id, "report", approved);
    database()
      .prepare(
        "INSERT INTO report_approval_history(id,academyId,reportId,snapshot,approvedPlan,approvedBy,at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        ctx.academy.id,
        id,
        JSON.stringify(snapshot),
        JSON.stringify(approvedPlan ?? null),
        ctx.user.id,
        now(),
      );
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Report source verified and approved",
      id,
    );
  });
  return approved;
}
const withdrawalInput = z.object({
  reason: z.string().trim().min(10).max(1000),
  expectedVersion: z.number().int().positive().optional(),
});
/**
 * Pulls an approved report back from families (P1-10). Owner or admin only,
 * with a written reason. The report returns to "Revision Requested" and loses
 * its snapshot, so every family-facing read (which requires an approved report
 * with a snapshot), the PDF and the update sources stop working at once.
 * Updates already published from it are unpublished and their queued external
 * deliveries cancelled. The approved version stays in the append-only approval
 * history; the withdrawal is recorded on the report and in the audit log. A
 * corrected report is prepared and approved through the normal review.
 */
export function withdrawReport(ctx: WorkspaceAccess, id: string, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const { reason, expectedVersion } = withdrawalInput.parse(input ?? {});
  const report = visibleRecord(ctx, "report", id);
  requirePlayer(ctx, report.playerId);
  if (expectedVersion !== undefined && expectedVersion !== report.recordVersion)
    throw new WorkspaceError(
      409,
      "Report changed. Review its current version before withdrawing it.",
    );
  if (report.status !== "Approved" || !report.snapshot)
    throw new WorkspaceError(409, "Only an approved report can be withdrawn.");
  const at = now();
  const { snapshot: _snapshot, approvedPlan: _plan, ...rest } = report;
  void _snapshot;
  void _plan;
  const withdrawn: WorkspaceReport = {
    ...rest,
    recordVersion: undefined,
    status: "Revision Requested",
    withdrawal: { at, by: ctx.user.id, reason },
  };
  return atomic(() => {
    const current = repo.find(ctx.academy.id, "report", id);
    if (
      !current ||
      current.status !== "Approved" ||
      current.recordVersion !== report.recordVersion
    )
      throw new WorkspaceError(
        409,
        "Report changed during withdrawal. Review its current version.",
      );
    repo.save(ctx.academy.id, "report", withdrawn);
    for (const update of repo.list(ctx.academy.id, "update")) {
      if (
        update.sourceReportId !== id ||
        (update.approvalStatus !== "APPROVED" &&
          update.inAppPublicationStatus !== "PUBLISHED")
      )
        continue;
      repo.save(ctx.academy.id, "update", {
        ...update,
        recordVersion: undefined,
        approvalStatus: "REJECTED",
        inAppPublicationStatus: "UNPUBLISHED",
        publishedGuardianIds: [],
      });
      database()
        .prepare(
          "UPDATE delivery_jobs SET state='CANCELLED',reason='Source report withdrawn' WHERE academyId=? AND sourceId=? AND state='QUEUED'",
        )
        .run(ctx.academy.id, update.id);
      audit(
        ctx.academy.id,
        ctx.user.id,
        "Update unpublished because its source report was withdrawn",
        update.id,
      );
    }
    audit(
      ctx.academy.id,
      ctx.user.id,
      `Approved report withdrawn from families: ${reason}`,
      id,
    );
    return repo.find(ctx.academy.id, "report", id)!;
  });
}
/**
 * Turns an enquiry into a player (P1-05). Owner or admin, once: the player is
 * created as a TRIAL profile for the chosen coach (and batch), the enquiry
 * becomes CONVERTED and links to it. Converting again returns the same player
 * and creates nothing. The trial enrolment and its fee are then set up with the
 * existing trial workflow; nothing is invoiced here.
 */
export function convertEnquiry(ctx: WorkspaceAccess, id: string, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  requireModule(ctx, "enquiry");
  const data = conversionSchema.parse(input ?? {});
  return atomic(() => {
    const enquiry = repo.find(ctx.academy.id, "enquiry", id);
    if (!enquiry) throw new WorkspaceError(404, "Enquiry not found.");
    if (enquiry.status === "CONVERTED" && enquiry.convertedPlayerId) {
      const existing = repo.find(
        ctx.academy.id,
        "player",
        enquiry.convertedPlayerId,
      );
      if (existing) return { enquiry, player: existing, created: false };
    }
    if (enquiry.status === "CLOSED")
      throw new WorkspaceError(
        409,
        "Reopen this enquiry before converting it to a player.",
      );
    const player = saveRecord(
      ctx,
      "player",
      {
        name: enquiry.childName,
        coachId: data.coachId,
        ...(data.squadId ? { squadId: data.squadId } : {}),
        ...(data.ageCategory ? { ageCategory: data.ageCategory } : {}),
        ...(data.birthDate ? { birthDate: data.birthDate } : {}),
        status: "TRIAL",
        sportIds: ["football"],
      },
      `from-enquiry-${enquiry.id}`,
    ) as WorkspaceRecords["player"];
    repo.save(ctx.academy.id, "enquiry", {
      ...enquiry,
      recordVersion: undefined,
      status: "CONVERTED",
      convertedPlayerId: player.id,
      updatedAt: now(),
    });
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Enquiry converted to a trial player",
      enquiry.id,
    );
    return {
      enquiry: repo.find(ctx.academy.id, "enquiry", enquiry.id)!,
      player,
      created: true,
    };
  });
}
export const nutritionGuidance = generalNutritionGuidance;
export function reviewUpdate(
  ctx: WorkspaceAccess,
  id: string,
  action: "submit" | "approve" | "reject",
  verified: boolean,
  expectedVersion?: number,
) {
  requireRole(ctx, [...staff]);
  const record = visibleRecord(ctx, "update", id);
  if (expectedVersion !== undefined && expectedVersion !== record.recordVersion)
    throw new WorkspaceError(
      409,
      "Update changed. Review the current draft before approval.",
    );
  let next: WorkspaceUpdate = { ...record, externalDeliveryStatus: "NOT_SENT" };
  if (action === "submit") {
    if (!["DRAFT", "REJECTED"].includes(record.approvalStatus))
      throw new WorkspaceError(
        409,
        "Only a draft or rejected update can be submitted.",
      );
    next.approvalStatus = "PENDING_APPROVAL";
  } else {
    if (record.approvalStatus !== "PENDING_APPROVAL")
      throw new WorkspaceError(409, "Submit this draft for review first.");
    if (action === "reject") next.approvalStatus = "REJECTED";
    else {
      if (record.type === "NUTRITION_HYDRATION")
        requireRole(ctx, ["OWNER", "ADMIN"]);
      if (!verified)
        throw new WorkspaceError(
          400,
          "Verify player, guardian and approved source records.",
        );
      if (
        record.type === "NUTRITION_HYDRATION" &&
        record.messageBody !== nutritionGuidance
      )
        throw new WorkspaceError(
          400,
          "Only the approved general nutrition guideline is allowed.",
        );
      if (record.sourceWeeklyPlanId) {
        weeklySource(ctx, record.sourceWeeklyPlanId);
      } else if (record.type !== "NUTRITION_HYDRATION") {
        const r = record.sourceReportId
          ? repo.find(ctx.academy.id, "report", record.sourceReportId)
          : undefined;
        if (
          !r ||
          r.status !== "Approved" ||
          !r.snapshot ||
          r.playerId !== record.playerId ||
          r.sportId !== record.sportId
        )
          throw new WorkspaceError(
            400,
            "An approved report for this player and sport is required.",
          );
        if (record.type === "REVIEWED_SESSION") {
          if (!r.sourceEvidenceIds?.length)
            throw new WorkspaceError(
              400,
              "Completed session sources are required.",
            );
          reportTrainingSources(ctx, r);
        }
      }
      next = {
        ...next,
        approvalStatus: "APPROVED",
        approvedBody: record.messageBody,
        approvedSource:
          record.type === "NUTRITION_HYDRATION"
            ? { guideline: nutritionGuidance, approval: "ACADEMY_APPROVED" }
            : record.sourceWeeklyPlanId
              ? weeklySource(ctx, record.sourceWeeklyPlanId)
              : repo.find(ctx.academy.id, "report", record.sourceReportId!)!
                  .snapshot,
        inAppPublicationStatus: "UNPUBLISHED",
        publishedGuardianIds: [],
      };
    }
  }
  atomic(() => {
    if (
      repo.find(ctx.academy.id, "update", id)?.recordVersion !==
      record.recordVersion
    )
      throw new WorkspaceError(
        409,
        "Update changed during review. Review again.",
      );
    if (action === "approve" && record.sourceWeeklyPlanId) {
      if (
        JSON.stringify(weeklySource(ctx, record.sourceWeeklyPlanId)) !==
        JSON.stringify(next.approvedSource)
      )
        throw new WorkspaceError(409, "Weekly source changed during approval.");
    } else if (action === "approve" && record.type !== "NUTRITION_HYDRATION") {
      const source = repo.find(
        ctx.academy.id,
        "report",
        record.sourceReportId!,
      );
      if (
        !source ||
        source.status !== "Approved" ||
        JSON.stringify(source.snapshot) !== JSON.stringify(next.approvedSource)
      )
        throw new WorkspaceError(
          409,
          "The approved source changed during review. Review again.",
        );
      if (record.type === "REVIEWED_SESSION")
        reportTrainingSources(ctx, source);
    }
    repo.save(ctx.academy.id, "update", next);
    if (action === "approve")
      database()
        .prepare(
          "INSERT INTO update_approval_history(id,academyId,updateId,version,body,source,approvedBy,at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          ctx.academy.id,
          id,
          next.version,
          next.approvedBody!,
          JSON.stringify(next.approvedSource),
          ctx.user.id,
          now(),
        );
  });
  audit(
    ctx.academy.id,
    ctx.user.id,
    `Update ${action}; external delivery NOT_SENT`,
    id,
  );
  return next;
}
/** Explicit private publication; approval alone never adds an inbox recipient. */
export function publishUpdate(
  ctx: WorkspaceAccess,
  id: string,
  expectedVersion?: number,
) {
  requireRole(ctx, [...staff]);
  const record = visibleRecord(ctx, "update", id);
  if (expectedVersion !== undefined && expectedVersion !== record.recordVersion)
    throw new WorkspaceError(409, "Update changed. Review before sharing.");
  if (
    record.approvalStatus !== "APPROVED" ||
    !record.approvedBody ||
    !record.approvedSource
  )
    throw new WorkspaceError(
      409,
      "Approve this update before sharing in the parent app.",
    );
  return atomic(() => {
    if (
      repo.find(ctx.academy.id, "update", id)?.recordVersion !==
      record.recordVersion
    )
      throw new WorkspaceError(409, "Update changed during publication.");
    if (record.type === "NUTRITION_HYDRATION") {
      requireRole(ctx, ["OWNER", "ADMIN"]);
      if (record.approvedBody !== nutritionGuidance)
        throw new WorkspaceError(
          400,
          "Only approved general guidance may be shared.",
        );
    } else if (record.sourceWeeklyPlanId) {
      if (
        JSON.stringify(weeklySource(ctx, record.sourceWeeklyPlanId)) !==
        JSON.stringify(record.approvedSource)
      )
        throw new WorkspaceError(
          409,
          "Weekly source changed. Review before sharing.",
        );
    } else {
      const source = repo.find(
        ctx.academy.id,
        "report",
        record.sourceReportId!,
      );
      if (
        !source ||
        source.status !== "Approved" ||
        source.playerId !== record.playerId ||
        source.sportId !== record.sportId ||
        JSON.stringify(source.snapshot) !==
          JSON.stringify(record.approvedSource)
      )
        throw new WorkspaceError(
          409,
          "Approved source changed. Review a new draft before sharing.",
        );
      if (record.type === "REVIEWED_SESSION")
        reportTrainingSources(ctx, source);
    }
    const guardians = database()
      .prepare(
        "SELECT g.userId FROM guardian_relationships g JOIN academy_memberships m ON m.academyId=g.academyId AND m.userId=g.userId WHERE g.academyId=? AND g.playerId=? AND m.role='PARENT' AND m.active=1 AND NOT EXISTS (SELECT 1 FROM player_link_login pl WHERE pl.academyId=g.academyId AND pl.userId=g.userId)",
      )
      .all(ctx.academy.id, record.playerId)
      .map((r) => String(r.userId));
    const recipients = guardians.filter((userId) => {
      const preference = repo.find(ctx.academy.id, "preference", userId);
      return (
        (!preference || preference.inApp) &&
        (record.type === "NUTRITION_HYDRATION"
          ? preference?.nutrition === true
          : preference?.development !== false)
      );
    });
    const next: WorkspaceUpdate = {
      ...record,
      publishedGuardianIds: recipients,
      inAppPublicationStatus: recipients.length ? "PUBLISHED" : "UNPUBLISHED",
      externalDeliveryStatus: "NOT_SENT",
    };
    repo.save(ctx.academy.id, "update", next);
    audit(
      ctx.academy.id,
      ctx.user.id,
      recipients.length
        ? "Approved update shared privately in parent app"
        : "Publication withheld by preferences or guardian access",
      id,
    );
    return next;
  });
}

export function reply(ctx: WorkspaceAccess, id: string, input: unknown) {
  requireRole(ctx, [...staff, "PARENT"]);
  requireNoPrivateChat(ctx);
  const value = z
      .object({
        body: z.string().trim().min(1).max(5000),
        internal: z.boolean().default(false),
        action: z.enum(["reply", "close", "reopen"]).default("reply"),
      })
      .parse(input),
    authorisedConversation = visibleRecord(ctx, "conversation", id);
  if (value.internal && ctx.membership.role === "PARENT")
    throw new WorkspaceError(403, "Parents cannot create staff-only notes.");
  if (
    ctx.membership.role !== "PARENT" &&
    isPlayerLinkLogin(ctx.academy.id, authorisedConversation.guardianId)
  )
    throw new WorkspaceError(
      403,
      "Private messages cannot be sent to a player's own login. Write to the player's parent or guardian.",
    );
  const next = atomic(() => {
    // The conversation is read inside the write lock. The communication worker
    // (a separate process) appends inbound messages to the same record; a read
    // taken before the lock could be saved over that message and lose it.
    const conversation = repo.find(
      ctx.academy.id,
      "conversation",
      authorisedConversation.id,
    )!;
    if (value.action === "reply" && conversation.status !== "OPEN")
      throw new WorkspaceError(409, "Reopen the conversation before replying.");
    const updated = {
      ...conversation,
      messages:
        value.action === "reply"
          ? [
              ...conversation.messages,
              {
                id: randomUUID(),
                senderId: ctx.user.id,
                senderRole: ctx.membership.role,
                body: value.body,
                internal: value.internal,
                at: now(),
              },
            ]
          : conversation.messages,
      status:
        value.action === "close"
          ? ("CLOSED" as const)
          : value.action === "reopen"
            ? ("OPEN" as const)
            : conversation.status,
    };
    repo.save(ctx.academy.id, "conversation", updated);
    audit(
      ctx.academy.id,
      ctx.user.id,
      `Conversation ${value.action}${value.internal ? " staff-only note" : ""}`,
      id,
    );
    return updated;
  });
  return ctx.membership.role === "PARENT"
    ? { ...next, messages: next.messages.filter((m) => !m.internal) }
    : next;
}
// Invitations and membership revocation live in membership-service.ts; they are
// re-exported so the routes and tests keep one import point.
export {
  invite,
  acceptInvitation,
  revokeMembership,
} from "./membership-service";
export async function context(
  headers: Headers,
  academyId: string,
  scope: AccessScope = "operational",
) {
  return access(headers, academyId, scope);
}
