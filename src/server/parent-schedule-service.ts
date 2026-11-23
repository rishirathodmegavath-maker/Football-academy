import "server-only";
import type {
  ParentClosure,
  ParentScheduledSession,
} from "@/domain/training";
import { workspaceRepository as repo } from "./workspace-repository";
import { database } from "./database";
import {
  requireRole,
  moduleEnabled,
  type WorkspaceAccess,
} from "./workspace-access";

/** How long a cancelled session stays on the schedule after it would have ended. */
const CANCELLED_VISIBLE_MS = 24 * 3600_000;

/** Confirmed sessions, and a session a parent had seen as confirmed that was
 * then cancelled (so the schedule shows the change rather than losing it).
 * A cancelled draft was never visible and stays hidden, as does any older
 * cancellation that predates the record of what it was cancelled from. */
function parentVisible(
  session: {
    status: string;
    cancelledFrom?: string;
    endAt: string;
  },
  now: number,
) {
  if (session.status === "SCHEDULED" || session.status === "IN_PROGRESS")
    return true;
  return (
    session.status === "CANCELLED" &&
    (session.cancelledFrom === "SCHEDULED" ||
      session.cancelledFrom === "IN_PROGRESS") &&
    Date.parse(session.endAt) > now - CANCELLED_VISIBLE_MS
  );
}

/** A staff-confirmed schedule may be read by its verified guardian. Private
 * weekly wording, observations and reports retain their separate approvals.
 * A cancelled session is projected without its reason. */
export function parentSchedule(ctx: WorkspaceAccess): ParentScheduledSession[] {
  requireRole(ctx, ["PARENT"]);
  if (!moduleEnabled(ctx, "session")) return [];
  const now = Date.now();
  const linked = new Set(
    database()
      .prepare(
        "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
      )
      .all(ctx.academy.id, ctx.user.id)
      .map((row) => String(row.playerId)),
  );
  const result: ParentScheduledSession[] = [];
  for (const session of repo.list(ctx.academy.id, "session")) {
    if (session.sportId !== "football" || !parentVisible(session, now))
      continue;
    const batch = repo.find(ctx.academy.id, "squad", session.squadId);
    for (const player of session.roster) {
      if (
        !linked.has(player.playerId) ||
        !repo
          .find(ctx.academy.id, "player", player.playerId)
          ?.sportIds.includes("football")
      )
        continue;
      result.push({
        id: session.id,
        childId: player.playerId,
        squadId: session.squadId,
        batchName: batch?.name ?? "Recorded training batch",
        theme: batch ? `${batch.name} Training` : "Football training",
        startAt: session.startAt,
        endAt: session.endAt,
        startLocal: session.startLocal,
        endLocal: session.endLocal,
        timezone: session.timezone,
        location: session.location,
        status: session.status as ParentScheduledSession["status"],
      });
    }
  }
  return result.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** Closed days a guardian should know about: those of the academy as a whole
 * and of the branch that one of their own children trains at. Only the dates,
 * the scope and the note written for families are projected; the internal
 * reason, other branches and lifted closures never leave the server. Closures
 * that ended more than a week ago are left out. */
export function parentClosures(
  ctx: WorkspaceAccess,
  today = new Date().toISOString().slice(0, 10),
): ParentClosure[] {
  requireRole(ctx, ["PARENT"]);
  if (!moduleEnabled(ctx, "session")) return [];
  const childBranches = new Set<string>();
  for (const row of database()
    .prepare(
      "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
    )
    .all(ctx.academy.id, ctx.user.id)) {
    const player = repo.find(ctx.academy.id, "player", String(row.playerId));
    if (!player?.sportIds.includes("football") || !player.squadId) continue;
    const branchId = repo.find(ctx.academy.id, "squad", player.squadId)?.branchId;
    if (branchId) childBranches.add(branchId);
  }
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return repo
    .list(ctx.academy.id, "closure")
    .filter(
      (closure) =>
        closure.sportId === "football" &&
        closure.status === "ACTIVE" &&
        closure.endDate >= cutoff &&
        (closure.branchId === "" || childBranches.has(closure.branchId)),
    )
    .map((closure) => ({
      id: closure.id,
      startDate: closure.startDate,
      endDate: closure.endDate,
      scope: closure.branchId ? ("BRANCH" as const) : ("ACADEMY" as const),
      branchName: closure.branchId
        ? repo.find(ctx.academy.id, "branch", closure.branchId)?.name
        : undefined,
      note: closure.publicNote,
    }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}
