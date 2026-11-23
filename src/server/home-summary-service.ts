import "server-only";
import type { HomeSession, HomeSummary } from "@/domain/home-summary";
import type { FootballSession } from "@/domain/training";
import { participates } from "@/domain/player-lifecycle";
import {
  academyDate,
  currentPlayerPlan,
  portalSessionSummary,
} from "@/services/portal-records";
import { monthReportProgress } from "@/services/report-period-filter";
import {
  requireRole,
  visibleRecords,
  withLookupScope,
  type WorkspaceAccess,
} from "./workspace-access";

const RECENT_ACTIVITY = 4;
const SCHEDULE_ROWS = 3;
const COMING_ROWS = 5;

/** Builds the Owner, Admin and Coach Home dashboard from the viewer's own
 * permission-scoped records (`visibleRecords`), using the same functions the
 * dashboard used on the full payload, so every figure keeps its meaning,
 * its role scope and its academy-local date handling. */
export function homeSummary(
  ctx: WorkspaceAccess,
  now = new Date(),
): HomeSummary {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH"]);
  return withLookupScope(() => {
    const records = {
      session: visibleRecords(ctx, "session"),
      squad: visibleRecords(ctx, "squad"),
      player: visibleRecords(ctx, "player"),
      plan: visibleRecords(ctx, "plan"),
      report: visibleRecords(ctx, "report"),
      evidence: visibleRecords(ctx, "evidence"),
      attendance: visibleRecords(ctx, "attendance"),
      conversation: visibleRecords(ctx, "conversation"),
      branch: visibleRecords(ctx, "branch"),
    };
    const data = { academy: ctx.academy, records },
      sessions = portalSessionSummary(data, now);
    const playerName = (id: string) =>
      records.player.find((p) => p.id === id)?.name;
    const home = (session: FootballSession): HomeSession => ({
      id: session.id,
      title: session.title,
      theme: session.theme,
      status: session.status,
      startAt: session.startAt,
      endAt: session.endAt,
      location: session.location,
      squadId: session.squadId,
      batchName: records.squad.find((s) => s.id === session.squadId)?.name,
      rosterCount: session.roster.length,
      sharedObjective: session.sharedObjective
        ? {
            goal: session.sharedObjective.goal,
            observe: session.sharedObjective.observe,
          }
        : undefined,
    });
    const reviews = records.evidence.filter((e) =>
        ["DRAFT", "AWAITING_REVIEW"].includes(e.status),
      ),
      unmarked = records.attendance.filter(
        (a) =>
          sessions.todaySessions.some((s) => s.id === a.sessionId) &&
          a.status === "UNMARKED",
      );
    const focusPlayer = records.player.find((p) =>
        currentPlayerPlan(data, p.id),
      ),
      plan = focusPlayer && currentPlayerPlan(data, focusPlayer.id);
    const month = sessions.today.slice(0, 7),
      monthly = monthReportProgress(records.report, month);
    const recent = [
      ...records.evidence
        .filter((e) => e.status === "REVIEWED")
        .map((e) => ({
          kind: "EVIDENCE" as const,
          id: e.id,
          date: e.reviewedAt ?? e.recordedAt,
          playerName: playerName(e.playerId),
          sessionId: e.sessionId,
          playerId: e.playerId,
        })),
      ...records.conversation.flatMap((c) =>
        c.messages
          .filter((m) => !m.internal)
          .slice(-1)
          .map((m) => ({
            kind: "CONVERSATION" as const,
            id: m.id,
            date: m.at,
            subject: c.subject,
            playerName: playerName(c.playerId),
            playerId: c.playerId,
          })),
      ),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, RECENT_ACTIVITY);
    return {
      academyId: ctx.academy.id,
      generatedAt: now.toISOString(),
      today: sessions.today,
      nextSession: sessions.next ? home(sessions.next) : undefined,
      todaySessions: sessions.todaySessions.slice(0, SCHEDULE_ROWS).map(home),
      comingSessions: sessions.upcoming
        .filter((s) => academyDate(data, new Date(s.startAt)) !== sessions.today)
        .slice(0, COMING_ROWS)
        .map(home),
      upcomingSessions: sessions.upcoming.length,
      activePlayers: records.player.filter((p) => participates(p.status))
        .length,
      batches: records.squad.length,
      openConversations: records.conversation.filter((c) => c.status === "OPEN")
        .length,
      recent,
      observationsToReview: {
        count: reviews.length,
        firstSessionId: reviews[0]?.sessionId,
      },
      reportDrafts: records.report.filter((r) => r.status !== "Approved")
        .length,
      unmarkedToday: {
        count: unmarked.length,
        firstSessionId: unmarked[0]?.sessionId,
      },
      focus:
        focusPlayer && plan
          ? {
              playerName: focusPlayer.name,
              focus: plan.focus,
              observe: plan.observe,
            }
          : undefined,
      reportsThisMonth: { month, ...monthly },
      approvedReports: records.report.filter((r) => r.status === "Approved")
        .length,
      hasBranch: records.branch.length > 0,
    };
  });
}
