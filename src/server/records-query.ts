import { isUniversalDrillId } from "@/domain/drill-library";
import { resolveDrill } from "./drill-library-service";
import "server-only";
import { z } from "zod";
import type {
  WorkspaceKind,
  WorkspaceReport,
  WorkspaceRecords,
} from "@/domain/workspace";
import type {
  MonthlyReportSources,
  PlayerMessages,
  RecordPage,
  ReportContent,
  ReportSummary,
  SessionCounts,
  SessionEvidence,
  SessionSummary,
} from "@/domain/records-query";
import type { FootballEvidence, FootballSession } from "@/domain/training";
import { comparableEvidence } from "@/services/training-rules";
import { reportPresentation } from "@/services/reports/report-presentation";
import { reportMatchesPeriod } from "@/services/report-period-filter";
import { WorkspaceError } from "./auth";
import {
  visibleRecords,
  withLookupScope,
  type WorkspaceAccess,
} from "./workspace-access";
import { monthlyReportReviewFor } from "./workspace-service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  word = z.string().trim().min(1).max(100);
/** Every query parameter the records endpoint understands. Anything else is a
 * 400, and a parameter the record type does not support is a 400 as well. */
const querySchema = z
  .object({
    view: z.enum(["summary", "content"]),
    review: z.literal("1"),
    counts: z.literal("1"),
    compare: z.literal("1"),
    limit: z.coerce.number().int().min(1).max(200),
    cursor: z.coerce.number().int().min(0),
    player: word,
    session: word,
    squad: word,
    coach: word,
    status: word,
    period: word,
    q: word,
    from: day,
    to: day,
  })
  .partial()
  .strict();
type Query = z.infer<typeof querySchema>;

/** Filters per record type. They narrow what `visibleRecords` already allows
 * the viewer to read; they never widen it. */
const filters: Partial<Record<WorkspaceKind, (keyof Query)[]>> = {
  report: ["player", "period", "status"],
  session: ["from", "to", "status", "squad", "coach", "player"],
  attendance: ["session", "player", "status", "from", "to"],
  evidence: ["session", "player", "status", "from", "to"],
  wrapup: ["session"],
  series: ["status"],
  player: ["q", "status", "squad", "coach"],
  conversation: ["player", "status"],
  plan: ["player", "status"],
  update: ["player", "status"],
  weekly: ["player", "status"],
};
const summaries: WorkspaceKind[] = ["report", "session"];

function validate(kind: WorkspaceKind, query: Query) {
  const allowed = filters[kind] ?? [];
  for (const key of Object.keys(query) as (keyof Query)[]) {
    if (
      key === "limit" ||
      key === "cursor" ||
      key === "review" ||
      key === "counts" ||
      key === "compare"
    )
      continue;
    if (
      key === "view"
        ? query.view === "content"
          ? kind !== "report"
          : !summaries.includes(kind)
        : !allowed.includes(key)
    )
      throw new WorkspaceError(
        400,
        "That filter or view is not available for this record type.",
      );
  }
  if (
    query.counts !== undefined &&
    (kind !== "session" || query.view !== "summary")
  )
    throw new WorkspaceError(
      400,
      "Session counts are part of the session summary view.",
    );
  if (query.compare !== undefined && (kind !== "evidence" || !query.session))
    throw new WorkspaceError(
      400,
      "Comparison is read for the evidence of one session.",
    );
  if (
    query.review !== undefined &&
    (kind !== "report" || query.view !== "summary")
  )
    throw new WorkspaceError(
      400,
      "The source review is part of the report summary view.",
    );
  if (query.view === "content" && !query.player)
    throw new WorkspaceError(
      400,
      "Report content is read for one player at a time.",
    );
  if (query.view === "content" && query.limit !== undefined)
    throw new WorkspaceError(400, "Report content is not paged.");
  if (query.cursor !== undefined && query.limit === undefined)
    throw new WorkspaceError(400, "A page cursor needs a page size.");
  if (query.from && query.to && query.from > query.to)
    throw new WorkspaceError(
      400,
      "The start date must not follow the end date.",
    );
}

function narrow(
  ctx: WorkspaceAccess,
  kind: WorkspaceKind,
  query: Query,
  rows: Record<string, unknown>[],
) {
  const same =
    (field: string, value?: string) => (row: Record<string, unknown>) =>
      value === undefined || row[field] === value;
  let result = rows
    // A session names its players in the roster; other records carry playerId.
    .filter((row) =>
      kind === "session" && query.player
        ? (row.roster as { playerId: string }[]).some(
            (p) => p.playerId === query.player,
          )
        : same("playerId", query.player)(row),
    )
    .filter(same("sessionId", query.session))
    .filter(same("squadId", query.squad))
    .filter(same("status", query.status));
  if (query.coach)
    result = result.filter((row) =>
      kind === "session"
        ? (row.coachIds as string[]).includes(query.coach!)
        : row.coachId === query.coach,
    );
  if (query.q) {
    const needle = query.q.toLowerCase();
    result = result.filter((row) =>
      String(row.name ?? "")
        .toLowerCase()
        .includes(needle),
    );
  }
  if (query.period)
    result = result.filter((row) =>
      reportMatchesPeriod(
        row as unknown as WorkspaceReport,
        query.period as string,
      ),
    );
  if (query.from || query.to) {
    // Sessions carry their own academy-local start; attendance and evidence
    // take the date of their session, among the sessions the viewer can read.
    const startOf = new Map(
      visibleRecords(ctx, "session").map((s) => [
        s.id,
        s.startLocal.slice(0, 10),
      ]),
    );
    result = result.filter((row) => {
      const date =
        kind === "session"
          ? String(row.startLocal).slice(0, 10)
          : startOf.get(String(row.sessionId));
      return (
        date !== undefined &&
        (!query.from || date >= query.from) &&
        (!query.to || date <= query.to)
      );
    });
  }
  return result;
}

function reportSummaries(
  ctx: WorkspaceAccess,
  reports: WorkspaceReport[],
  withReview: boolean,
): ReportSummary[] {
  // Re-checking the saved sources of every draft is the costly part of a
  // summary, and only the monthly review queue shows it, so it is opt-in.
  const review = withReview ? monthlyReportReviewFor(ctx, reports) : {};
  return reports.map((r) => ({
    id: r.id,
    academyId: r.academyId,
    sportId: r.sportId,
    playerId: r.playerId,
    planId: r.planId,
    period: r.period,
    periodLabel: r.snapshot
      ? reportPresentation(r.snapshot).periodLabel
      : r.period,
    reportingPeriod: r.reportingPeriod,
    correctionOf: r.correctionOf,
    recordVersion: r.recordVersion,
    status: r.status,
    externalDeliveryStatus: r.externalDeliveryStatus,
    hasSnapshot: Boolean(r.snapshot),
    ...(r.status === "Approved" && r.snapshot
      ? { focus: r.snapshot.focus, nextStep: r.snapshot.nextStep }
      : {}),
    monthly: Boolean(r.monthlySources),
    untouched:
      !r.observation.trim() && !r.nextStep.trim() && !r.closingNote.trim(),
    hasNextStep: Boolean(r.nextStep.trim()),
    ...(review[r.id]
      ? {
          sourcesCurrent: review[r.id].sourcesCurrent,
          staleReason: review[r.id].reason,
        }
      : {}),
  }));
}
/** Approved reports reduced to what Messages reads. The viewer's own
 * `visibleRecords` has already applied role, academy and parent-child scope
 * (and removed a parent's access to sources); this only drops fields. */
function reportContents(reports: WorkspaceReport[]): ReportContent[] {
  return reports
    .filter((r) => r.status === "Approved" && r.snapshot)
    .map((r) => {
      const s = r.snapshot!;
      return {
        id: r.id,
        academyId: r.academyId,
        sportId: r.sportId,
        playerId: r.playerId,
        planId: r.planId,
        period: r.period,
        status: "Approved" as const,
        snapshot: {
          academy: s.academy,
          player: s.player,
          period: s.period,
          focus: s.focus,
          reviewedReason: s.reviewedReason,
          practised: s.practised,
          activities: s.activities.map((a) => ({
            name: a.name,
            purpose: a.purpose,
          })),
          evidence: s.evidence.map((e) => ({
            text: e.text,
            source: e.source,
            ...(e.reference ? { reference: e.reference } : {}),
          })),
          nextStep: s.nextStep,
          observationCriteria: s.observationCriteria,
          reviewDate: s.reviewDate,
        },
        ...(r.approvedPlan
          ? {
              approvedPlan: {
                id: r.approvedPlan.id,
                focus: r.approvedPlan.focus,
              },
            }
          : {}),
        ...(r.sourceEvidenceIds
          ? { sourceEvidenceIds: r.sourceEvidenceIds }
          : {}),
        ...(r.monthlySources ? { monthly: true } : {}),
      };
    });
}
/** Attendance and review counts per session, from the viewer's own records. */
function sessionCounts(
  ctx: WorkspaceAccess,
  sessions: FootballSession[],
): Map<string, SessionCounts> {
  const wanted = new Set(sessions.map((s) => s.id)),
    counts = new Map<string, SessionCounts>();
  const of = (id: string) => {
    let value = counts.get(id);
    if (!value) {
      value = {
        present: 0,
        absent: 0,
        excused: 0,
        unmarked: 0,
        awaitingReview: 0,
      };
      counts.set(id, value);
    }
    return value;
  };
  for (const id of wanted) of(id);
  for (const mark of visibleRecords(ctx, "attendance"))
    if (wanted.has(mark.sessionId))
      of(mark.sessionId)[
        mark.status === "PRESENT"
          ? "present"
          : mark.status === "ABSENT"
            ? "absent"
            : mark.status === "EXCUSED"
              ? "excused"
              : "unmarked"
      ]++;
  for (const note of visibleRecords(ctx, "evidence"))
    if (
      wanted.has(note.sessionId) &&
      ["DRAFT", "AWAITING_REVIEW"].includes(note.status)
    )
      of(note.sessionId).awaitingReview++;
  return counts;
}
/** Evidence of one session, each with whether the player has another reviewed
 * record it can be compared with (the review screen says so). */
function withComparison(
  ctx: WorkspaceAccess,
  items: FootballEvidence[],
): SessionEvidence[] {
  const byPlayer = new Map<string, FootballEvidence[]>();
  for (const e of visibleRecords(ctx, "evidence")) {
    const list = byPlayer.get(e.playerId);
    if (list) list.push(e);
    else byPlayer.set(e.playerId, [e]);
  }
  return items.map((e) => ({
    ...e,
    comparablePrevious: (byPlayer.get(e.playerId) ?? []).some(
      (v) => v.id !== e.id && comparableEvidence(e, v),
    ),
  }));
}
function sessionSummaries(
  sessions: FootballSession[],
  counts?: Map<string, SessionCounts>,
): SessionSummary[] {
  return sessions.map(
    ({
      agenda,
      objectives: _objectives,
      sharedObjective: _shared,
      preparation: _preparation,
      ...rest
    }) => {
      void [_objectives, _shared, _preparation];
      return {
        ...rest,
        agendaItems: agenda.length,
        ...(counts ? { counts: counts.get(rest.id) } : {}),
      };
    },
  );
}

/**
 * What Messages shows for one player in one read: their plans, updates and
 * conversations, and the content of their approved reports. Each part is the
 * result of the same filtered records read the endpoints offer, so role,
 * academy and parent-child scope (and what a parent never receives, such as
 * internal notes) are exactly theirs.
 */
export function playerMessages(
  ctx: WorkspaceAccess,
  playerId: string,
): PlayerMessages {
  const part = (kind: WorkspaceKind, extra = "") =>
    queryRecords(
      ctx,
      kind,
      new URLSearchParams(`player=${encodeURIComponent(playerId)}${extra}`),
    );
  return withLookupScope(() => ({
    plans: part("plan") as PlayerMessages["plans"],
    updates: part("update") as PlayerMessages["updates"],
    conversations: part("conversation") as PlayerMessages["conversations"],
    reports: part("report", "&view=content") as PlayerMessages["reports"],
  }));
}

/**
 * The focus area of each drill behind a monthly report.
 *
 * An APPROVED report is frozen: it answers only from what was saved with it
 * (the focus areas copied into its sources when it was prepared, then the
 * saved session snapshots for a report prepared before those existed). It never
 * reads a current academy drill record or the catalogue, so editing, archiving
 * or retiring a drill later cannot change it. A drill with no saved value is
 * left out rather than filled from today's record.
 *
 * A DRAFT report may still look further: the sessions' snapshots first, then an
 * academy drill's current record, then the current catalogue.
 */
function historicalDrills(
  ctx: WorkspaceAccess,
  report: WorkspaceReport,
  sessions: { agenda: { drill: { id: string; focusArea: string } }[] }[],
  drillIds: ReadonlySet<string>,
) {
  const found = new Map<string, string>();
  const frozen = report.status === "Approved";
  if (frozen)
    for (const f of report.monthlySources?.drillFocus ?? [])
      if (drillIds.has(f.id) && !found.has(f.id)) found.set(f.id, f.focusArea);
  for (const s of sessions)
    for (const a of s.agenda)
      if (drillIds.has(a.drill.id) && !found.has(a.drill.id))
        found.set(a.drill.id, a.drill.focusArea);
  if (!frozen) {
    for (const d of visibleRecords(ctx, "drill"))
      if (drillIds.has(d.id) && !found.has(d.id)) found.set(d.id, d.focusArea);
    for (const id of drillIds)
      if (!found.has(id) && isUniversalDrillId(id))
        try {
          found.set(id, resolveDrill(ctx, id).focusArea);
        } catch {
          /* not available any more: left out */
        }
  }
  return [...found].map(([id, focusArea]) => ({ id, focusArea }));
}

/**
 * The current sessions, reviewed evidence, attendance and drill focus areas
 * behind a monthly report's saved sources. Everything comes from the viewer's
 * own `visibleRecords`, so a coach sees only their own players' sessions, and
 * a report whose sources the viewer may not read (a parent's, which carries
 * none) yields nothing.
 */
export function monthlyReportSources(
  ctx: WorkspaceAccess,
  report: WorkspaceReport,
): MonthlyReportSources {
  const sources = report.monthlySources;
  if (!sources)
    return { sessions: [], evidence: [], attendance: [], drills: [] };
  return withLookupScope(() => {
    const sessions = visibleRecords(ctx, "session").filter((s) =>
      sources.sessionIds.includes(s.id),
    );
    const sessionIds = new Set(sessions.map((s) => s.id));
    const drillIds = new Set(
      sources.model.activities.flatMap((a) => (a.drillId ? [a.drillId] : [])),
    );
    return {
      sessions,
      evidence: visibleRecords(ctx, "evidence")
        .filter(
          (e) => sources.evidenceIds.includes(e.id) && e.status === "REVIEWED",
        )
        .map((e) => ({
          id: e.id,
          sessionId: e.sessionId,
          playerId: e.playerId,
          observation: e.observation,
        })),
      attendance: visibleRecords(ctx, "attendance")
        .filter(
          (a) => a.playerId === report.playerId && sessionIds.has(a.sessionId),
        )
        .map((a) => ({
          sessionId: a.sessionId,
          playerId: a.playerId,
          status: a.status,
        })),
      drills: historicalDrills(ctx, report, sessions, drillIds),
    };
  });
}

/**
 * Records of one kind for the viewer, optionally filtered, summarised and
 * paged. With no query parameters this is exactly `visibleRecords` (the
 * long-standing response); a `limit` returns a RecordPage instead of an array.
 * The viewer's permissions are applied first, by `visibleRecords`.
 */
export function queryRecords<K extends WorkspaceKind>(
  ctx: WorkspaceAccess,
  kind: K,
  params: URLSearchParams,
): WorkspaceRecords[K][] | unknown[] | RecordPage<unknown> {
  if (![...params.keys()].length) return visibleRecords(ctx, kind);
  const query = querySchema.parse(Object.fromEntries(params.entries()));
  validate(kind, query);
  return withLookupScope(() => {
    const rows = narrow(
      ctx,
      kind,
      query,
      visibleRecords(ctx, kind) as unknown as Record<string, unknown>[],
    );
    const start = query.cursor ?? 0,
      slice =
        query.limit === undefined
          ? rows
          : rows.slice(start, start + query.limit);
    const items: unknown[] =
      query.view === undefined
        ? query.compare === "1"
          ? withComparison(ctx, slice as unknown as FootballEvidence[])
          : slice
        : query.view === "content"
          ? reportContents(slice as unknown as WorkspaceReport[])
          : kind === "report"
            ? reportSummaries(
                ctx,
                slice as unknown as WorkspaceReport[],
                query.review === "1",
              )
            : sessionSummaries(
                slice as unknown as FootballSession[],
                query.counts === "1"
                  ? sessionCounts(ctx, slice as unknown as FootballSession[])
                  : undefined,
              );
    if (query.limit === undefined) return items;
    const next = start + query.limit;
    return {
      items,
      total: rows.length,
      nextCursor: next < rows.length ? next : null,
    };
  });
}
