import {
  academyToday,
  assertDrillAgeRules,
  drillForPlanning,
  drillVersionOf,
  sessionDrillSnapshot,
} from "./drill-library-service";
import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  TrainingKind,
  TrainingRecords,
  FootballSession,
  FootballSeries,
  FootballEvidence,
  SkippedOccurrence,
  SeriesCancelOutcome,
  SeriesPreview,
} from "@/domain/training";
import type {
  WorkspacePlan,
  WorkspaceReport,
  WorkspaceRecords,
} from "@/domain/workspace";
import {
  evidenceInput,
  resolveSessionTime,
  measurementText,
  sessionDraftInput,
} from "@/services/training-rules";
import {
  sessionConflicts,
  venueHierarchyError,
  type SessionConflict,
} from "@/services/session-scheduling";
import {
  expandSeries,
  occurrenceId,
  SeriesRuleError,
  type SeriesRule,
} from "@/services/recurrence";
import {
  seriesDraftInput,
  seriesCancelInput,
  wrapUpInput,
} from "@/services/series-rules";
import {
  notifySeriesCancelled,
  notifySessionCancelled,
} from "./session-notices";
import { workspaceRepository as repo } from "./workspace-repository";
import { inPeriod } from "@/services/communication/period-rules";
import { atomic, database, audit } from "./database";
import { WorkspaceError } from "./auth";
import {
  MAX_CLOSURE_DAYS,
  closureCovering,
  closureDays,
  closureMessage,
  localDateOf,
} from "@/services/closure-rules";
import {
  ARCHIVED_MESSAGE,
  isArchived,
  participates,
} from "@/domain/player-lifecycle";
import { verifyPlaceConfirmation } from "./google-places";
import {
  requireRole,
  requireModule,
  requireSport,
  requirePlayer,
  requireOpenPlayer,
  visibleRecord,
  coachCoversPlayers,
  withLookupScope,
  type WorkspaceAccess,
} from "./workspace-access";
const id = z.string().min(1).max(100),
  text = z.string().trim().min(1).max(2000);
const envelope = z.object({
  requestId: z.uuid(),
  action: z.enum([
    "squad",
    "venue",
    "session",
    "reschedule",
    "copy",
    "objective",
    "status",
    "attendance",
    "evidence",
    "review",
    "report",
    "nextStep",
    "series",
    "seriesPreview",
    "seriesSync",
    "seriesCancel",
    "wrapup",
    "closure",
  ]),
  id: id.optional(),
  expectedVersion: z.number().int().nonnegative().default(0),
  data: z.unknown(),
});
const staff = ["OWNER", "ADMIN", "COACH"] as const;
function fail(message: string, status = 400): never {
  throw new WorkspaceError(status, message);
}
export function authorisedSession(
  ctx: WorkspaceAccess,
  sessionId: string,
): FootballSession {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "session");
  requireSport(ctx, "football");
  const session = repo.find(ctx.academy.id, "session", sessionId);
  if (
    !session ||
    session.sportId !== "football" ||
    (ctx.membership.role === "COACH" &&
      (!session.coachIds.includes(ctx.user.id) ||
        !coachCoversPlayers(
          ctx.academy.id,
          ctx.user.id,
          session.roster.map((p) => p.playerId),
        )))
  )
    fail("Session is not available for your coaching assignment.", 404);
  return session;
}
function scoped<K extends TrainingKind>(
  ctx: WorkspaceAccess,
  kind: K,
  recordId: string,
): TrainingRecords[K] {
  const r = repo.find(ctx.academy.id, kind, recordId);
  if (!r) fail("Record unavailable.", 404);
  if ("sessionId" in r) authorisedSession(ctx, r.sessionId);
  if ("playerId" in r) requirePlayer(ctx, r.playerId);
  return r;
}
function playerInSession(
  ctx: WorkspaceAccess,
  s: FootballSession,
  playerId: string,
) {
  requirePlayer(ctx, playerId);
  if (!s.roster.some((p) => p.playerId === playerId))
    fail("Player is not in the historical session roster.");
}
function sessionTimes(startLocal: string, endLocal: string, timezone: string) {
  let startAt: string, endAt: string;
  try {
    startAt = resolveSessionTime(startLocal, timezone);
    endAt = resolveSessionTime(endLocal, timezone);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid session time.");
  }
  if (endAt <= startAt || Date.parse(endAt) - Date.parse(startAt) > 8 * 3600000)
    fail("Session must end after starting, within eight hours.");
  return { startAt, endAt };
}
function assertAssignments(ctx: WorkspaceAccess, session: FootballSession) {
  const branch = visibleRecord(ctx, "branch", session.branchId);
  if (session.timezone !== branch.timezone)
    fail("Use the recorded branch time zone.");
  if (
    session.venueId &&
    scoped(ctx, "venue", session.venueId).branchId !== session.branchId
  )
    fail("Venue must belong to this branch.");
  if (
    ctx.membership.role === "COACH" &&
    !session.coachIds.includes(ctx.user.id)
  )
    fail("Assign yourself to the session.", 403);
  for (const coachId of session.coachIds) {
    const member = repo.membership(ctx.academy.id, coachId);
    if (
      !member ||
      !staff.includes(member.role as (typeof staff)[number]) ||
      (member.sportIds.length && !member.sportIds.includes("football"))
    )
      fail("Choose active academy football coaches.");
    if (
      member.role === "COACH" &&
      !coachCoversPlayers(
        ctx.academy.id,
        coachId,
        session.roster.map((player) => player.playerId),
      )
    )
      fail(
        "Every assigned coach must be authorised for every player in the session roster.",
      );
  }
  session.roster.forEach((player) => requirePlayer(ctx, player.playerId));
  // Applies to every booking, scheduling, start and series run.
  assertDrillAgeRules(
    ctx,
    session.agenda.map((a) => a.drill),
    session.roster.map((player) => player.playerId),
    session.startLocal ? session.startLocal.slice(0, 10) : academyToday(ctx),
  );
}
/** Every booking rule except overlap with other sessions. */
function assertBookable(ctx: WorkspaceAccess, session: FootballSession) {
  assertAssignments(ctx, session);
  if (!session.coachIds.length)
    fail("Assign an authorised session coach before scheduling or starting.");
  if (!session.venueId && !session.location.trim())
    fail(
      "Choose a venue or record a training location before scheduling or starting.",
    );
  const resolved = sessionTimes(
    session.startLocal,
    session.endLocal,
    session.timezone,
  );
  if (
    Date.parse(resolved.startAt) !== Date.parse(session.startAt) ||
    Date.parse(resolved.endAt) !== Date.parse(session.endAt)
  )
    fail(
      "Saved session times are inconsistent. Review the dated schedule before confirming it.",
    );
  if (
    session.agenda.reduce((sum, item) => sum + item.duration, 0) >
    (Date.parse(session.endAt) - Date.parse(session.startAt)) / 60000
  )
    fail("Drill durations exceed the session length.");
}
/** Closures (P1-08) block creating or scheduling a session on a closed day.
 * Sessions that already exist are never touched here. */
function assertNotClosed(
  ctx: WorkspaceAccess,
  branchId: string,
  startLocal: string,
) {
  const closure = closureCovering(
    repo.list(ctx.academy.id, "closure"),
    branchId,
    localDateOf(startLocal),
  );
  if (closure)
    fail(
      `${closureMessage(closure, repo.find(ctx.academy.id, "branch", branchId)?.name)}. Choose another date, or lift the closure first.`,
      409,
    );
}
const closureInput = z.object({
  /** "" closes the whole academy. */
  branchId: id.or(z.literal("")),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  reason: z.string().trim().min(3).max(500),
  publicNote: z.string().trim().max(300).default(""),
  status: z.enum(["ACTIVE", "LIFTED"]).default("ACTIVE"),
});
function conflictKinds(conflicts: SessionConflict[]) {
  return [...new Set(conflicts.map((conflict) => conflict.kind))].join(", ");
}
function assertBooking(ctx: WorkspaceAccess, session: FootballSession) {
  assertBookable(ctx, session);
  const conflicts = sessionConflicts(
    session,
    repo.list(ctx.academy.id, "session"),
    repo.list(ctx.academy.id, "venue"),
  );
  if (conflicts.length)
    fail(
      `Scheduling conflict: ${conflictKinds(conflicts)} already booked for an overlapping time. Choose another time or configured space.`,
      409,
    );
}
/** The session as it is saved when cancelled. `cancelledFrom` records what a
 * parent could have seen, which decides whether a notice is owed. */
function cancelled(s: FootballSession): FootballSession {
  return {
    ...s,
    status: "CANCELLED",
    cancelledFrom: s.status as "DRAFT" | "SCHEDULED" | "IN_PROGRESS",
    cancelledAt: new Date().toISOString(),
  };
}
/**
 * Agenda items as a session snapshot. A drill is a universal catalogue drill
 * or one of this academy's own, captured COMPLETE at this moment: the saved
 * session never depends on the current catalogue or the current academy drill
 * to show what was planned.
 *
 * A drill the record already holds (`previous`) keeps the snapshot it was
 * saved with, exactly; only its duration follows the request. To take a newer
 * version of a drill, remove it and add it again. An archived drill is refused
 * for a new item unless the record being edited already contains it, or
 * `allowArchived` names it (a series that already uses it).
 */
function buildAgenda(
  ctx: WorkspaceAccess,
  items: { drillId: string; duration: number }[],
  options: {
    previous?: FootballSession["agenda"];
    allowArchived?: ReadonlySet<string>;
  } = {},
): FootballSession["agenda"] {
  const previous = new Map(
      (options.previous ?? []).map((a) => [a.drill.id, a] as const),
    ),
    allowed = new Set([...(options.allowArchived ?? []), ...previous.keys()]),
    capturedAt = new Date().toISOString();
  return items.map((a) => {
    const kept = previous.get(a.drillId);
    if (kept)
      return {
        drill: kept.drill,
        duration: a.duration,
        drillVersion: kept.drillVersion,
      };
    const drill = drillForPlanning(ctx, a.drillId, allowed);
    return {
      drill: sessionDrillSnapshot(ctx, drill, capturedAt),
      duration: a.duration,
      drillVersion: drillVersionOf(ctx.academy.id, drill),
    };
  });
}
/** One UNMARKED attendance record per rostered player of a new session. */
function seedAttendance(
  ctx: WorkspaceAccess,
  sessionId: string,
  roster: FootballSession["roster"],
) {
  for (const p of roster)
    save(
      ctx,
      "attendance",
      {
        id: `${sessionId}:${p.playerId}`,
        academyId: ctx.academy.id,
        sportId: "football",
        sessionId,
        playerId: p.playerId,
        status: "UNMARKED",
        correctionReason: "",
      },
      0,
    );
}
function save<K extends TrainingKind>(
  ctx: WorkspaceAccess,
  kind: K,
  body: Omit<TrainingRecords[K], "version" | "updatedAt" | "updatedBy">,
  expected: number,
) {
  const old = repo.find(ctx.academy.id, kind, body.id);
  if ((old?.version ?? 0) !== expected)
    fail(
      "A newer version exists. Reload and review your unsaved changes before retrying.",
      409,
    );
  const record = {
    ...body,
    version: expected + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: ctx.user.id,
  } as TrainingRecords[K];
  repo.save(ctx.academy.id, kind, record as WorkspaceRecords[K]);
  database()
    .prepare(
      "INSERT INTO training_history(academyId,kind,recordId,version,body,actorId,at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      ctx.academy.id,
      kind,
      record.id,
      record.version,
      JSON.stringify(record),
      ctx.user.id,
      record.updatedAt,
    );
  audit(
    ctx.academy.id,
    ctx.user.id,
    `Training ${kind} saved version ${record.version}`,
    record.id,
  );
  return record;
}
/**
 * Applies a saved batch roster to the players, so `player.squadId` (the source
 * of truth) and the roster (derived from it) cannot disagree: players added are
 * placed in this batch and taken off any other batch's roster, players removed
 * lose the placement. Historical session rosters are never touched. An archived
 * profile cannot be newly placed. Runs inside the caller's transaction.
 */
function placeRoster(
  ctx: WorkspaceAccess,
  squad: TrainingRecords["squad"],
  previous: TrainingRecords["squad"] | undefined,
) {
  const players = repo.list(ctx.academy.id, "player"),
    wanted = new Set(squad.playerIds),
    before = new Set([
      ...(previous?.playerIds ?? []),
      ...players.filter((p) => p.squadId === squad.id).map((p) => p.id),
    ]);
  const others = repo
    .list(ctx.academy.id, "squad")
    .filter((s) => s.id !== squad.id && s.sportId === "football");
  const stamp = new Date().toISOString();
  for (const player of players) {
    const isWanted = wanted.has(player.id);
    if (isWanted && player.squadId !== squad.id) {
      if (isArchived(player.status)) fail(ARCHIVED_MESSAGE, 409);
      repo.save(ctx.academy.id, "player", {
        ...player,
        recordVersion: undefined,
        squadId: squad.id,
        squad: squad.name,
      });
      others.forEach((other, index) => {
        if (!other.playerIds.includes(player.id)) return;
        others[index] = {
          ...other,
          playerIds: other.playerIds.filter((id) => id !== player.id),
          version: other.version + 1,
          updatedAt: stamp,
          updatedBy: ctx.user.id,
        };
        repo.save(ctx.academy.id, "squad", others[index]);
      });
      audit(
        ctx.academy.id,
        ctx.user.id,
        "Batch roster saved: player placed; historical session rosters unchanged",
        player.id,
      );
    } else if (
      !isWanted &&
      before.has(player.id) &&
      // Older data can list a player on this roster while they are placed in a
      // different batch: that placement is not this roster's to clear.
      (player.squadId === squad.id || !player.squadId)
    ) {
      repo.save(ctx.academy.id, "player", {
        ...player,
        recordVersion: undefined,
        squadId: "",
        squad:
          player.squadId === squad.id || player.squad === previous?.name
            ? ""
            : player.squad,
      });
      audit(
        ctx.academy.id,
        ctx.user.id,
        "Batch roster saved: player removed from batch; historical session rosters unchanged",
        player.id,
      );
    } else if (isWanted && player.squad !== squad.name) {
      // A renamed batch: keep the player's displayed label in step.
      repo.save(ctx.academy.id, "player", {
        ...player,
        recordVersion: undefined,
        squad: squad.name,
      });
    }
  }
}
/** The players a NEW roster should carry: those who take part (ACTIVE, TRIAL).
 * Sessions already held keep the roster they were created with. */
function rosterFor(ctx: WorkspaceAccess, playerIds: readonly string[]) {
  return playerIds.flatMap((playerId) => {
    const player = requirePlayer(ctx, playerId);
    return participates(player.status)
      ? [{ playerId, name: player.name }]
      : [];
  });
}
// ----------------------------------------------------------------- series
/** Describes why dates were not scheduled, for a refusal that creates nothing. */
function skipSummary(skipped: SkippedOccurrence[]) {
  const label = {
    EXCLUDED: "holiday",
    PAST: "already started",
    TIME_INVALID: "clock-change",
    CONFLICT: "conflicting",
    CLOSURE: "closed-day",
  } as const;
  const counts = new Map<string, number>();
  for (const s of skipped)
    counts.set(label[s.reason], (counts.get(label[s.reason]) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${n} ${name}`).join(", ");
}
/** A series record from validated input. Nothing is saved here. */
function seriesFromDraft(
  ctx: WorkspaceAccess,
  d: z.infer<typeof seriesDraftInput>,
  seriesId: string,
): FootballSeries {
  const branch = visibleRecord(ctx, "branch", d.branchId),
    // A coach reaches only squads whose every player they cover.
    squad = visibleRecord(ctx, "squad", d.squadId);
  if (squad.branchId !== branch.id) fail("Squad and branch must match.");
  if (d.timezone !== branch.timezone)
    fail("Use the recorded branch time zone.");
  if (d.venueId && scoped(ctx, "venue", d.venueId).branchId !== branch.id)
    fail("Venue must belong to this branch.");
  // A new series may only use drills that are available now (not archived).
  d.agenda.forEach((a) => drillForPlanning(ctx, a.drillId));
  return {
    id: seriesId,
    academyId: ctx.academy.id,
    sportId: "football",
    version: 0,
    updatedAt: "",
    updatedBy: "",
    branchId: d.branchId,
    squadId: d.squadId,
    venueId: d.venueId,
    location: d.location,
    coachIds: [...new Set(d.coachIds)],
    timezone: d.timezone,
    weekdays: [...new Set(d.weekdays)].sort((a, b) => a - b),
    startDate: d.startDate,
    endDate: d.endDate,
    startTime: d.startTime,
    endTime: d.endTime,
    title: d.title,
    theme: d.theme,
    agenda: d.agenda,
    exclusions: [...d.exclusions].sort((a, b) => a.date.localeCompare(b.date)),
    status: "ACTIVE",
    skipped: [],
  };
}
interface SeriesPlan {
  /** Sessions to create now: valid time, not yet existing, no overlap. */
  create: FootballSession[];
  skipped: SkippedOccurrence[];
  /** Sessions of this series that already exist. */
  existing: number;
}
/**
 * What the series would add right now. Deterministic and side-effect free, so
 * the preview, the first run and every later run agree. A date whose session
 * already exists (whatever its status) is never created again, which is what
 * makes processing a series twice safe; a cancelled or rescheduled occurrence
 * keeps its id and is therefore never resurrected or duplicated.
 */
function planSeries(ctx: WorkspaceAccess, series: FootballSeries): SeriesPlan {
  // Planning only reads, so the per-date access checks share their lookups.
  return withLookupScope(() => planSeriesScoped(ctx, series));
}
function planSeriesScoped(
  ctx: WorkspaceAccess,
  series: FootballSeries,
): SeriesPlan {
  const rule: SeriesRule = {
    timezone: series.timezone,
    weekdays: series.weekdays,
    startDate: series.startDate,
    endDate: series.endDate,
    startTime: series.startTime,
    endTime: series.endTime,
    exclusions: series.exclusions,
  };
  let expanded: ReturnType<typeof expandSeries>;
  try {
    expanded = expandSeries(rule, Date.now());
  } catch (error) {
    if (error instanceof SeriesRuleError) fail(error.message);
    throw error;
  }
  const squad = visibleRecord(ctx, "squad", series.squadId),
    roster = rosterFor(ctx, squad.playerIds),
    agenda = buildAgenda(ctx, series.agenda, {
      allowArchived: new Set(series.agenda.map((a) => a.drillId)),
    }),
    sessions = repo.list(ctx.academy.id, "session"),
    venues = repo.list(ctx.academy.id, "venue"),
    have = new Set(sessions.map((s) => s.id));
  const candidate = (o: {
    date: string;
    startLocal: string;
    endLocal: string;
    startAt: string;
    endAt: string;
  }): FootballSession => ({
    id: occurrenceId(series.id, o.date),
    academyId: ctx.academy.id,
    sportId: "football",
    version: 0,
    updatedAt: "",
    updatedBy: "",
    branchId: series.branchId,
    squadId: series.squadId,
    venueId: series.venueId,
    location: series.location,
    coachIds: [...series.coachIds],
    timezone: series.timezone,
    startLocal: o.startLocal,
    endLocal: o.endLocal,
    startAt: o.startAt,
    endAt: o.endAt,
    title: series.title,
    theme: series.theme,
    status: "SCHEDULED",
    roster: roster.map((p) => ({ ...p })),
    agenda: structuredClone(agenda),
    objectives: [],
    seriesId: series.id,
    occurrenceDate: o.date,
  });
  // Coaches, venue and roster are checked once even if every date is skipped.
  assertAssignments(
    ctx,
    candidate({
      date: series.startDate,
      startLocal: `${series.startDate}T${series.startTime}`,
      endLocal: `${series.startDate}T${series.endTime}`,
      startAt: "",
      endAt: "",
    }),
  );
  const skipped = expanded.skipped.filter(
    (s) => !have.has(occurrenceId(series.id, s.date)),
  );
  const create: FootballSession[] = [];
  const closures = repo.list(ctx.academy.id, "closure");
  for (const o of expanded.occurrences) {
    if (have.has(occurrenceId(series.id, o.date))) continue;
    const closed = closureCovering(closures, series.branchId, o.date);
    if (closed) {
      skipped.push({
        date: o.date,
        reason: "CLOSURE",
        detail: closureMessage(
          closed,
          repo.find(ctx.academy.id, "branch", series.branchId)?.name,
        ),
      });
      continue;
    }
    const next = candidate(o);
    assertBookable(ctx, next);
    const conflicts = sessionConflicts(next, [...sessions, ...create], venues);
    if (conflicts.length) {
      skipped.push({
        date: o.date,
        reason: "CONFLICT",
        detail: `${conflictKinds(conflicts)} already booked for an overlapping time.`,
      });
      continue;
    }
    create.push(next);
  }
  skipped.sort((a, b) => a.date.localeCompare(b.date));
  return {
    create,
    skipped,
    existing: sessions.filter((s) => s.seriesId === series.id).length,
  };
}
function createOccurrences(ctx: WorkspaceAccess, sessions: FootballSession[]) {
  for (const s of sessions) {
    const { version: _v, updatedAt: _a, updatedBy: _b, ...body } = s;
    void _v;
    void _a;
    void _b;
    save(ctx, "session", body, 0);
    seedAttendance(ctx, s.id, s.roster);
  }
}
function activeMembership(ctx: WorkspaceAccess) {
  // Re-check active permissions inside the write transaction, including retries.
  const currentMembership = repo.membership(ctx.academy.id, ctx.user.id);
  if (
    !currentMembership ||
    currentMembership.role !== ctx.membership.role ||
    (currentMembership.sportIds.length &&
      !currentMembership.sportIds.includes("football"))
  )
    fail("Membership is no longer active.", 403);
}
export function trainingAction(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, "session");
  requireSport(ctx, "football");
  const command = envelope.parse(input),
    digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  // A preview reads and plans but never writes, so it carries no submission key.
  if (command.action === "seriesPreview")
    return atomic((): SeriesPreview => {
      activeMembership(ctx);
      const draft = seriesFromDraft(
        ctx,
        seriesDraftInput.parse(command.data),
        randomUUID(),
      );
      const plan = planSeries(ctx, draft);
      return {
        occurrences: plan.create.map((s) => ({
          date: s.occurrenceDate!,
          startLocal: s.startLocal,
          startAt: s.startAt,
          endAt: s.endAt,
        })),
        skipped: plan.skipped,
        existing: plan.existing,
      };
    });
  return atomic(() => {
    activeMembership(ctx);
    const prior = database()
      .prepare(
        "SELECT digest,response FROM training_submissions WHERE academyId=? AND userId=? AND requestId=?",
      )
      .get(ctx.academy.id, ctx.user.id, command.requestId);
    if (prior) {
      if (prior.digest !== digest)
        fail(
          "This submission key was already used for different content.",
          409,
        );
      const response = JSON.parse(String(prior.response)) as
        TrainingRecords[TrainingKind] | WorkspaceReport | WorkspacePlan;
      // A series also lists coaches, so it is recognised first.
      if ("weekdays" in response) visibleRecord(ctx, "series", response.id);
      else if ("coachIds" in response) authorisedSession(ctx, response.id);
      if ("sessionId" in response) authorisedSession(ctx, response.sessionId);
      if ("playerId" in response) requirePlayer(ctx, response.playerId);
      if (
        command.action === "squad" ||
        command.action === "venue" ||
        command.action === "closure"
      )
        requireRole(ctx, ["OWNER", "ADMIN"]);
      return response;
    }
    const recordId = command.id ?? randomUUID(),
      base = { id: recordId, academyId: ctx.academy.id, sportId: "football" },
      v = command.expectedVersion;
    let response:
      TrainingRecords[TrainingKind] | WorkspaceReport | WorkspacePlan;
    switch (command.action) {
      case "squad": {
        requireRole(ctx, ["OWNER", "ADMIN"]);
        const d = z
          .object({ name: text, branchId: id, playerIds: z.array(id) })
          .parse(command.data);
        visibleRecord(ctx, "branch", d.branchId);
        if (new Set(d.playerIds).size !== d.playerIds.length)
          fail("Duplicate roster player.");
        d.playerIds.forEach((p) => requirePlayer(ctx, p));
        const previousSquad = command.id
          ? repo.find(ctx.academy.id, "squad", recordId)
          : undefined;
        const savedSquad = save(ctx, "squad", { ...base, ...d }, v);
        // player.squadId is the placement source of truth (decision D9); the
        // roster just saved is applied to the players in this same transaction.
        placeRoster(ctx, savedSquad, previousSquad);
        response = savedSquad;
        break;
      }
      case "closure": {
        requireRole(ctx, ["OWNER", "ADMIN"]);
        const d = closureInput.parse(command.data);
        if (d.branchId) visibleRecord(ctx, "branch", d.branchId);
        if (d.endDate < d.startDate)
          fail("The last closed day cannot be before the first.");
        if (closureDays(d.startDate, d.endDate) > MAX_CLOSURE_DAYS)
          fail(`A closure can cover at most ${MAX_CLOSURE_DAYS} days.`);
        if (command.id && !repo.find(ctx.academy.id, "closure", recordId))
          fail("Closure unavailable in this academy.", 404);
        response = save(ctx, "closure", { ...base, ...d }, v);
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Closure ${d.status === "LIFTED" ? "lifted" : "recorded"}: ${d.startDate} to ${d.endDate}${d.branchId ? " (one branch)" : " (whole academy)"}`,
          recordId,
        );
        break;
      }
      case "venue": {
        requireRole(ctx, ["OWNER", "ADMIN"]);
        const d = z
          .object({
            name: text,
            branchId: id,
            location: text,
            parentVenueId: id.optional(),
            exclusive: z.boolean().default(true),
            independentChildren: z.boolean().default(false),
            bufferMinutes: z.number().int().min(0).max(120).default(0),
          })
          .parse(command.data);
        visibleRecord(ctx, "branch", d.branchId);
        const hierarchyError = venueHierarchyError(
          { ...base, ...d, version: v, updatedAt: "", updatedBy: ctx.user.id },
          repo.list(ctx.academy.id, "venue"),
        );
        if (hierarchyError) fail(hierarchyError);
        response = save(ctx, "venue", { ...base, ...d }, v);
        break;
      }
      case "session": {
        const { placeConfirmation, ...d } = sessionDraftInput.parse(
          command.data,
        );
        const branch = visibleRecord(ctx, "branch", d.branchId),
          squad = scoped(ctx, "squad", d.squadId);
        if (squad.branchId !== branch.id) fail("Squad and branch must match.");
        if (d.timezone !== branch.timezone)
          fail("Use the recorded branch time zone.");
        assertNotClosed(ctx, branch.id, d.startLocal);
        if (d.venueId && scoped(ctx, "venue", d.venueId).branchId !== branch.id)
          fail("Venue must belong to this branch.");
        for (const coachId of d.coachIds) {
          const m = repo.membership(ctx.academy.id, coachId);
          if (
            !m ||
            !staff.includes(m.role as (typeof staff)[number]) ||
            (m.sportIds.length && !m.sportIds.includes("football"))
          )
            fail("Choose active academy football coaches.");
        }
        if (
          ctx.membership.role === "COACH" &&
          !d.coachIds.includes(ctx.user.id)
        )
          fail("Assign yourself to the session.", 403);
        let startAt: string, endAt: string;
        try {
          startAt = resolveSessionTime(d.startLocal, d.timezone);
          endAt = resolveSessionTime(d.endLocal, d.timezone);
        } catch (e) {
          fail(e instanceof Error ? e.message : "Invalid time.");
        }
        if (
          endAt <= startAt ||
          Date.parse(endAt) - Date.parse(startAt) > 8 * 3600000
        )
          fail("Session must end after starting, within eight hours.");
        if (
          d.agenda.reduce((sum, a) => sum + a.duration, 0) >
          (Date.parse(endAt) - Date.parse(startAt)) / 60000
        )
          fail("Drill durations exceed the session length.");
        const old = command.id ? authorisedSession(ctx, recordId) : undefined;
        const googlePlaceId = placeConfirmation
          ? verifyPlaceConfirmation(
              placeConfirmation,
              { academyId: ctx.academy.id, userId: ctx.user.id },
              d.location,
            )
          : old?.location === d.location
            ? old.googlePlaceId
            : undefined;
        if (old && old.status !== "DRAFT")
          fail(
            "Only draft sessions can change their schedule and agenda.",
            409,
          );
        if (
          old?.objectives.some(
            (o) => !d.agenda.some((a) => a.drillId === o.drillId),
          )
        )
          fail(
            "Existing objectives refer to a removed drill. Update objectives before removing that drill.",
          );
        const roster =
          old?.roster ?? rosterFor(ctx, squad.playerIds);
        roster.forEach((p) => requirePlayer(ctx, p.playerId));
        for (const coachId of d.coachIds) {
          if (
            repo.membership(ctx.academy.id, coachId)?.role === "COACH" &&
            !coachCoversPlayers(
              ctx.academy.id,
              coachId,
              roster.map((p) => p.playerId),
            )
          )
            fail(
              "Every assigned coach must be authorised for every player in the session roster.",
            );
        }
        const agenda = buildAgenda(ctx, d.agenda, { previous: old?.agenda });
        // An internal minimum age is enforced here, for the whole roster.
        assertDrillAgeRules(
          ctx,
          agenda.map((a) => a.drill),
          roster.map((p) => p.playerId),
          d.startLocal.slice(0, 10),
        );
        response = save(
          ctx,
          "session",
          {
            ...base,
            ...d,
            title: d.title ?? old?.title,
            startAt,
            endAt,
            googlePlaceId,
            agenda,
            roster,
            objectives: old?.objectives ?? [],
            sharedObjective: d.sharedObjective ?? old?.sharedObjective,
            preparation: d.preparation ?? old?.preparation,
            copiedFromSessionId: old?.copiedFromSessionId,
            status: "DRAFT",
          },
          v,
        );
        if (!old) seedAttendance(ctx, recordId, roster);
        break;
      }
      case "copy": {
        z.object({}).strict().parse(command.data);
        const source = authorisedSession(ctx, recordId);
        if (source.version !== v)
          fail(
            "A newer version exists. Reload before copying this session.",
            409,
          );
        const copyId = randomUUID();
        const roster = rosterFor(
          ctx,
          source.roster.map((player) => player.playerId),
        );
        response = save(
          ctx,
          "session",
          {
            id: copyId,
            academyId: ctx.academy.id,
            sportId: "football",
            branchId: source.branchId,
            squadId: source.squadId,
            venueId: source.venueId,
            location: source.location,
            coachIds: [...source.coachIds],
            timezone: source.timezone,
            startLocal: "",
            endLocal: "",
            startAt: "",
            endAt: "",
            title: source.title,
            theme: source.theme,
            status: "DRAFT",
            roster,
            agenda: structuredClone(source.agenda),
            objectives: source.objectives.map((objective) => ({
              ...objective,
              playerName:
                roster.find((player) => player.playerId === objective.playerId)
                  ?.name ?? objective.playerName,
            })),
            sharedObjective: source.sharedObjective
              ? { ...source.sharedObjective }
              : undefined,
            preparation: source.preparation
              ? [...source.preparation]
              : undefined,
            copiedFromSessionId: source.id,
          },
          0,
        );
        seedAttendance(ctx, copyId, roster);
        break;
      }
      case "reschedule": {
        const session = authorisedSession(ctx, recordId);
        if (!["DRAFT", "SCHEDULED"].includes(session.status))
          fail("Only draft or scheduled sessions can be rescheduled.", 409);
        const d = z
          .object({
            startLocal: text,
            endLocal: text,
            timezone: text,
            location: z.string().trim().max(2000),
            venueId: id.optional(),
            coachIds: z.array(id),
            reason: z.string().trim().min(3).max(1000),
          })
          .parse(command.data);
        const { reason, ...schedule } = d;
        const next = {
          ...session,
          ...schedule,
          ...sessionTimes(d.startLocal, d.endLocal, d.timezone),
        };
        assertAssignments(ctx, next);
        assertNotClosed(ctx, next.branchId, next.startLocal);
        if (next.status === "SCHEDULED") assertBooking(ctx, next);
        else if (
          next.agenda.reduce((sum, item) => sum + item.duration, 0) >
          (Date.parse(next.endAt) - Date.parse(next.startAt)) / 60000
        )
          fail("Drill durations exceed the session length.");
        response = save(ctx, "session", next, v);
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Session rescheduled: ${reason}`,
          session.id,
        );
        break;
      }
      case "objective": {
        const s = authorisedSession(ctx, recordId);
        if (!["DRAFT", "SCHEDULED"].includes(s.status))
          fail("Objectives are locked after training begins.", 409);
        const d = z
          .object({
            playerId: id,
            planId: id.optional(),
            goal: text,
            drillId: id,
            cue: text,
            observe: text,
          })
          .parse(command.data);
        playerInSession(ctx, s, d.playerId);
        if (!s.agenda.some((a) => a.drill.id === d.drillId))
          fail("Select a session drill.");
        if (d.planId) {
          const p = visibleRecord(ctx, "plan", d.planId);
          if (
            p.playerId !== d.playerId ||
            !["ACTIVE", "CONTINUE", "ADAPT", "NEEDS_REVIEW"].includes(
              p.status,
            ) ||
            !p.drillIds.includes(d.drillId)
          )
            fail("Select this player’s current plan and assigned drill.");
        }
        response = save(
          ctx,
          "session",
          {
            ...s,
            objectives: [
              ...s.objectives.filter((o) => o.playerId !== d.playerId),
              {
                ...d,
                playerName: s.roster.find((p) => p.playerId === d.playerId)!
                  .name,
              },
            ],
          },
          v,
        );
        break;
      }
      case "status": {
        const s = authorisedSession(ctx, recordId),
          d = z
            .object({
              status: z.enum([
                "SCHEDULED",
                "IN_PROGRESS",
                "COMPLETED",
                "CANCELLED",
              ]),
              reason: z.string().max(1000).default(""),
            })
            .parse(command.data);
        const allowed: Record<string, string[]> = {
          DRAFT: ["SCHEDULED", "CANCELLED"],
          SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
          IN_PROGRESS: ["COMPLETED", "CANCELLED"],
          COMPLETED: [],
          CANCELLED: [],
        };
        if (!allowed[s.status].includes(d.status))
          fail("Invalid session status transition.", 409);
        if (d.status === "SCHEDULED") assertNotClosed(ctx, s.branchId, s.startLocal);
        if (d.status === "SCHEDULED" || d.status === "IN_PROGRESS")
          assertBooking(ctx, { ...s, status: d.status });
        if (d.status === "CANCELLED" && !d.reason.trim())
          fail("Record a cancellation reason.");
        if (d.status === "COMPLETED") {
          if (
            repo
              .list(ctx.academy.id, "attendance")
              .some((a) => a.sessionId === s.id && a.status === "UNMARKED")
          )
            fail("Mark attendance before completing the session.");
          if (
            repo
              .list(ctx.academy.id, "evidence")
              .some(
                (e) =>
                  e.sessionId === s.id &&
                  ["DRAFT", "AWAITING_REVIEW"].includes(e.status),
              )
          )
            fail("Review outstanding evidence before completion.");
        }
        const saved = save(
          ctx,
          "session",
          d.status === "CANCELLED" ? cancelled(s) : { ...s, status: d.status },
          v,
        );
        response = saved;
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Session ${d.status}: ${d.reason}`,
          s.id,
        );
        // Only this occurrence changes; its series and sibling dates are untouched.
        if (d.status === "CANCELLED") notifySessionCancelled(saved);
        break;
      }
      case "attendance": {
        const s = authorisedSession(ctx, recordId);
        if (s.status === "CANCELLED")
          fail("Cancelled attendance cannot be changed.");
        const d = z
          .object({
            entries: z
              .array(
                z.object({
                  playerId: id,
                  status: z.enum(["PRESENT", "ABSENT", "EXCUSED", "UNMARKED"]),
                  expectedVersion: z.number().int().positive(),
                }),
              )
              .min(1),
            correctionReason: z.string().max(1000).default(""),
          })
          .parse(command.data);
        if (new Set(d.entries.map((e) => e.playerId)).size !== d.entries.length)
          fail("Duplicate attendance player.");
        for (const e of d.entries) {
          playerInSession(ctx, s, e.playerId);
          const a = scoped(ctx, "attendance", `${s.id}:${e.playerId}`);
          if (
            a.status !== "UNMARKED" &&
            a.status !== e.status &&
            !d.correctionReason.trim()
          )
            fail("Explain the attendance correction.");
          save(
            ctx,
            "attendance",
            { ...a, status: e.status, correctionReason: d.correctionReason },
            e.expectedVersion,
          );
        }
        response = s;
        break;
      }
      case "evidence": {
        const d = evidenceInput.parse(command.data),
          s = authorisedSession(ctx, d.sessionId);
        playerInSession(ctx, s, d.playerId);
        requireOpenPlayer(ctx, d.playerId);
        if (s.status !== "IN_PROGRESS")
          fail("Capture evidence during an in-progress session.");
        if (
          scoped(ctx, "attendance", `${s.id}:${d.playerId}`).status !==
          "PRESENT"
        )
          fail("Record present attendance before training evidence.");
        const a = s.agenda.find((a) => a.drill.id === d.drillId);
        if (!a) fail("Select a drill from this session.");
        const objective = s.objectives.find((o) => o.playerId === d.playerId);
        if (d.planId && objective?.planId !== d.planId)
          fail("Evidence goal must match the session objective.");
        if (d.planId && objective?.drillId !== d.drillId)
          fail("Evidence drill must match this player’s session objective.");
        const old = command.id ? scoped(ctx, "evidence", recordId) : undefined;
        if (
          old &&
          (old.playerId !== d.playerId || old.sessionId !== d.sessionId)
        )
          fail("Evidence ownership cannot be changed.", 403);
        if (old && !["DRAFT", "AWAITING_REVIEW"].includes(old.status))
          fail(
            "Reviewed records are immutable. Capture a new observation instead.",
            409,
          );
        response = save(
          ctx,
          "evidence",
          {
            ...base,
            ...d,
            unit:
              d.measurement === "ATTEMPTS"
                ? "ATTEMPTS"
                : d.measurement === "ELAPSED_TIME"
                  ? "SECONDS"
                  : "NONE",
            drillVersion: a.drillVersion,
            drillName: a.drill.name,
            status: "AWAITING_REVIEW",
            authorId: old?.authorId ?? ctx.user.id,
            recordedAt: old?.recordedAt ?? new Date().toISOString(),
          },
          v,
        );
        break;
      }
      case "review": {
        const e = scoped(ctx, "evidence", recordId),
          d = z
            .object({
              status: z.enum(["REVIEWED", "UNCLEAR", "REJECTED", "SUPERSEDED"]),
              verified: z.literal(true),
            })
            .parse(command.data);
        if (
          !["AWAITING_REVIEW", "DRAFT"].includes(e.status) &&
          d.status !== "SUPERSEDED"
        )
          fail("This reviewed evidence is immutable.", 409);
        response = save(
          ctx,
          "evidence",
          {
            ...e,
            status: d.status,
            reviewedBy: ctx.user.id,
            reviewedAt: new Date().toISOString(),
          },
          v,
        );
        break;
      }
      case "seriesPreview":
        // Answered before this transaction (it never writes); unreachable here.
        throw new Error("seriesPreview is handled before the write path.");
      case "series": {
        const draft = seriesFromDraft(
          ctx,
          seriesDraftInput.parse(command.data),
          recordId,
        );
        if (repo.find(ctx.academy.id, "series", recordId))
          fail(
            "This series already exists. Use the schedule to add any missing dates.",
            409,
          );
        const plan = planSeries(ctx, draft);
        if (!plan.create.length)
          fail(
            `No session can be scheduled from this rule (${skipSummary(plan.skipped) || "no dates"}). Change the dates, times or holidays.`,
            409,
          );
        // The rule first, then the sessions it produced, in one transaction.
        response = save(ctx, "series", { ...draft, skipped: plan.skipped }, v);
        createOccurrences(ctx, plan.create);
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Recurring series created: ${plan.create.length} sessions, ${plan.skipped.length} dates skipped`,
          recordId,
        );
        break;
      }
      case "seriesSync": {
        // Processing a series again only adds dates that do not exist yet.
        const series = visibleRecord(ctx, "series", recordId);
        if (series.status !== "ACTIVE")
          fail("A cancelled series cannot add dates.", 409);
        const plan = planSeries(ctx, series);
        response = save(ctx, "series", { ...series, skipped: plan.skipped }, v);
        createOccurrences(ctx, plan.create);
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Recurring series processed: ${plan.create.length} sessions added`,
          recordId,
        );
        break;
      }
      case "seriesCancel": {
        const series = visibleRecord(ctx, "series", recordId);
        if (series.status !== "ACTIVE")
          fail("This series is already cancelled.", 409);
        if (series.version !== v)
          fail(
            "A newer version exists. Reload and review before cancelling.",
            409,
          );
        const d = seriesCancelInput.parse(command.data),
          now = Date.now(),
          left: SeriesCancelOutcome["left"] = [],
          notify: FootballSession[] = [];
        let count = 0;
        // Only this series' future, not-yet-started sessions. Held sessions,
        // started ones and other series' sessions are never touched.
        for (const occurrence of repo
          .list(ctx.academy.id, "session")
          .filter((s) => s.seriesId === series.id)) {
          if (["COMPLETED", "CANCELLED"].includes(occurrence.status)) continue;
          const date =
            occurrence.occurrenceDate ?? occurrence.startLocal.slice(0, 10);
          if (
            occurrence.status === "IN_PROGRESS" ||
            Date.parse(occurrence.startAt) <= now
          ) {
            left.push({
              sessionId: occurrence.id,
              date,
              reason:
                occurrence.status === "IN_PROGRESS"
                  ? "Training has already started."
                  : "Its start time has passed; handle it from the session.",
            });
            continue;
          }
          try {
            authorisedSession(ctx, occurrence.id);
          } catch (error) {
            if (!(error instanceof WorkspaceError)) throw error;
            left.push({
              sessionId: occurrence.id,
              date,
              reason: "Not assigned to you.",
            });
            continue;
          }
          const saved = save(
            ctx,
            "session",
            cancelled(occurrence),
            occurrence.version,
          );
          count++;
          audit(
            ctx.academy.id,
            ctx.user.id,
            `Session CANCELLED: series cancelled: ${d.reason}`,
            occurrence.id,
          );
          if (occurrence.status === "SCHEDULED") notify.push(saved);
        }
        const outcome: SeriesCancelOutcome = {
          cancelled: count,
          left,
          notices: notifySeriesCancelled(series, notify),
        };
        response = save(
          ctx,
          "series",
          {
            ...series,
            status: "CANCELLED",
            cancelReason: d.reason,
            cancelledAt: new Date(now).toISOString(),
            cancelOutcome: outcome,
          },
          v,
        );
        audit(
          ctx.academy.id,
          ctx.user.id,
          `Recurring series cancelled: ${count} sessions, ${left.length} left: ${d.reason}`,
          series.id,
        );
        break;
      }
      case "wrapup": {
        if (!command.id) fail("Choose the session for this wrap-up.");
        const s = authorisedSession(ctx, recordId);
        if (!["IN_PROGRESS", "COMPLETED"].includes(s.status))
          fail("Write the wrap-up once training has started.", 409);
        const d = wrapUpInput.parse(command.data);
        if (new Set(d.drills.map((x) => x.drillId)).size !== d.drills.length)
          fail("Each drill can appear once in a wrap-up.");
        if (
          d.drills.some((x) => !s.agenda.some((a) => a.drill.id === x.drillId))
        )
          fail("A wrap-up covers only the drills planned for this session.");
        if (
          s.agenda.some((a) => !d.drills.some((x) => x.drillId === a.drill.id))
        )
          fail("Record the outcome of every planned drill.");
        if (d.drills.some((x) => x.outcome === "SKIPPED" && x.actualMinutes))
          fail("A skipped drill has no minutes.");
        if (
          !s.agenda.length &&
          !d.observations &&
          !d.achievements &&
          !d.improvements
        )
          fail("Add at least one note.");
        response = save(
          ctx,
          "wrapup",
          {
            ...base,
            sessionId: s.id,
            // Planned minutes and names come from the saved agenda, in its order.
            drills: s.agenda.map((a) => {
              const x = d.drills.find((item) => item.drillId === a.drill.id)!;
              return {
                drillId: a.drill.id,
                drillName: a.drill.name,
                plannedMinutes: a.duration,
                outcome: x.outcome,
                ...(x.outcome === "SKIPPED"
                  ? { actualMinutes: 0 }
                  : x.actualMinutes === undefined
                    ? {}
                    : { actualMinutes: x.actualMinutes }),
                note: x.note,
              };
            }),
            observations: d.observations,
            achievements: d.achievements,
            improvements: d.improvements,
          },
          v,
        );
        audit(ctx.academy.id, ctx.user.id, "Session wrap-up saved", s.id);
        break;
      }
      case "nextStep": {
        const d = z
            .object({
              evidenceId: id,
              nextStep: text,
              status: z.enum([
                "CONTINUE",
                "ADAPT",
                "COMPLETED",
                "NEEDS_REVIEW",
              ]),
            })
            .parse(command.data),
          e = scoped(ctx, "evidence", d.evidenceId),
          p = visibleRecord(ctx, "plan", recordId);
        if (
          e.playerId !== p.playerId ||
          e.planId !== p.id ||
          e.status !== "REVIEWED"
        )
          fail("Use reviewed evidence for this development plan.");
        const current = Number(
          database()
            .prepare(
              "SELECT version FROM workspace_records WHERE academyId=? AND kind=? AND id=?",
            )
            .get(ctx.academy.id, "plan", p.id)?.version,
        );
        if (current !== v)
          fail("Plan changed. Reload before updating its next step.", 409);
        response = { ...p, nextStep: d.nextStep, status: d.status };
        repo.save(ctx.academy.id, "plan", response);
        audit(
          ctx.academy.id,
          ctx.user.id,
          "Plan next step reviewed against session evidence",
          e.id,
        );
        break;
      }
      case "report": {
        const d = z
            .object({
              playerId: id,
              planId: id,
              evidenceIds: z.array(id).min(1),
              period: text,
              closingNote: z.string().max(10000),
            })
            .parse(command.data),
          p = visibleRecord(ctx, "plan", d.planId);
        requirePlayer(ctx, d.playerId);
        if (p.playerId !== d.playerId) fail("Plan belongs to another player.");
        const records = d.evidenceIds.map((e) => scoped(ctx, "evidence", e));
        for (const e of records)
          if (
            e.playerId !== p.playerId ||
            e.planId !== p.id ||
            e.status !== "REVIEWED" ||
            e.visibility !== "PARENT_ELIGIBLE" ||
            authorisedSession(ctx, e.sessionId).status !== "COMPLETED"
          )
            fail(
              "Reports require parent-eligible reviewed evidence from completed sessions.",
            );
        if (repo.find(ctx.academy.id, "report", recordId))
          fail("Report already exists.", 409);
        response = {
          ...base,
          playerId: d.playerId,
          planId: d.planId,
          period: d.period,
          sourceEvidenceIds: d.evidenceIds,
          observation: records
            .map((e) => `${e.observation} - ${measurementText(e)}`)
            .join("\n"),
          evidenceType: "COACH_OBSERVATION",
          nextStep: p.nextStep,
          closingNote: d.closingNote,
          status: "Draft",
          externalDeliveryStatus: "NOT_SENT",
        };
        repo.save(ctx.academy.id, "report", response);
        audit(
          ctx.academy.id,
          ctx.user.id,
          "Report prepared from reviewed session records",
          recordId,
        );
        break;
      }
    }
    database()
      .prepare(
        "INSERT INTO training_submissions(academyId,userId,requestId,digest,response) VALUES(?,?,?,?,?)",
      )
      .run(
        ctx.academy.id,
        ctx.user.id,
        command.requestId,
        digest,
        JSON.stringify(response),
      );
    return response;
  });
}
export function reportTrainingSources(
  ctx: WorkspaceAccess,
  report: WorkspaceReport,
): FootballEvidence[] {
  requirePlayer(ctx, report.playerId);
  return (report.sourceEvidenceIds ?? []).map((id) => {
    const e = report.monthlySources
      ? repo.find(ctx.academy.id, "evidence", id)
      : scoped(ctx, "evidence", id);
    const session =
      e &&
      (report.monthlySources
        ? repo.find(ctx.academy.id, "session", e.sessionId)
        : authorisedSession(ctx, e.sessionId));
    if (
      !e ||
      e.sportId !== "football" ||
      !session ||
      session.sportId !== "football" ||
      e.playerId !== report.playerId ||
      (!report.monthlySources && e.planId !== report.planId) ||
      e.status !== "REVIEWED" ||
      e.visibility !== "PARENT_ELIGIBLE" ||
      session.status !== "COMPLETED" ||
      (report.monthlySources &&
        (!session.roster.some((p) => p.playerId === report.playerId) ||
          !inPeriod(session.startAt, report.monthlySources.period) ||
          !inPeriod(e.recordedAt, report.monthlySources.period)))
    )
      fail(
        "A report source is no longer eligible. Review its sources again.",
        409,
      );
    return e;
  });
}
export function trainingHistory(
  ctx: WorkspaceAccess,
  kind: TrainingKind,
  recordId: string,
) {
  requireRole(ctx, [...staff]);
  requireModule(ctx, kind);
  visibleRecord(ctx, kind, recordId);
  audit(ctx.academy.id, ctx.user.id, "Training audit history read", recordId);
  return database()
    .prepare(
      "SELECT version,body,actorId,at FROM training_history WHERE academyId=? AND kind=? AND recordId=? ORDER BY version",
    )
    .all(ctx.academy.id, kind, recordId)
    .map((row) => ({ ...row, body: JSON.parse(String(row.body)) }));
}
