import "server-only";
import type {
  AttendanceHistory,
  FootballAttendance,
  FootballSession,
} from "@/domain/training";
import { attendanceHistory } from "@/services/attendance-history";
import { database } from "./database";
import { WorkspaceError } from "./auth";
import { workspaceRepository as repo } from "./workspace-repository";
import {
  moduleEnabled,
  requireModule,
  requirePlayer,
  requireRole,
  requireSport,
  visibleRecords,
  type WorkspaceAccess,
} from "./workspace-access";

/**
 * Attendance history, computed on read from the attendance and session records
 * that already exist (no table of its own).
 *
 * - Staff: owners and admins read any football player; a coach reads only the
 *   players assigned to them (requirePlayer is the same check every other
 *   coach read uses). Staff also get the follow-up flag and correction reasons.
 *   A coach's players' history includes sessions another coach ran: it is the
 *   coach's own player's attendance, and a streak needs all of it.
 * - Parents: only a child linked to them, with the percentage and the
 *   session-by-session marks. No follow-up flag and no staff correction notes.
 * - Support and anyone else: refused.
 */
function squadNames(academyId: string) {
  return new Map(
    repo.list(academyId, "squad").map((squad) => [squad.id, squad.name]),
  );
}
function completed(academyId: string) {
  return repo
    .list(academyId, "session")
    .filter(
      (s: FootballSession) =>
        s.status === "COMPLETED" && s.sportId === "football",
    );
}

export function playerAttendanceHistory(
  ctx: WorkspaceAccess,
  playerId: string,
): AttendanceHistory {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH", "PARENT"]);
  requireSport(ctx, "football");
  const parent = ctx.membership.role === "PARENT";
  let name: string;
  if (parent) {
    if (!moduleEnabled(ctx, "attendance"))
      throw new WorkspaceError(
        403,
        "This module is not enabled for the academy subscription and configuration.",
      );
    const linked = database()
      .prepare(
        "SELECT 1 FROM guardian_relationships WHERE academyId=? AND userId=? AND playerId=?",
      )
      .get(ctx.academy.id, ctx.user.id, playerId);
    const player = linked && repo.find(ctx.academy.id, "player", playerId);
    // Same answer for "not yours" and "does not exist".
    if (!player || !player.sportIds.includes("football"))
      throw new WorkspaceError(
        404,
        "Record not available in this academy and role.",
      );
    name = player.name;
  } else {
    requireModule(ctx, "attendance");
    name = requirePlayer(ctx, playerId).name;
  }
  const attendance = repo
    .list(ctx.academy.id, "attendance")
    .filter((mark: FootballAttendance) => mark.playerId === playerId);
  return attendanceHistory({
    playerId,
    playerName: name,
    sessions: completed(ctx.academy.id),
    attendance,
    squadNames: squadNames(ctx.academy.id),
    staff: !parent,
  });
}

/** Players who need a follow-up: three or more consecutive absences. Staff
 * only; a coach sees only their own players. Most absences first. */
export function attendanceFollowUps(ctx: WorkspaceAccess): AttendanceHistory[] {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH"]);
  requireSport(ctx, "football");
  requireModule(ctx, "attendance");
  const sessions = completed(ctx.academy.id),
    names = squadNames(ctx.academy.id),
    byPlayer = new Map<string, FootballAttendance[]>();
  for (const mark of repo.list(ctx.academy.id, "attendance"))
    byPlayer.set(mark.playerId, [...(byPlayer.get(mark.playerId) ?? []), mark]);
  return visibleRecords(ctx, "player")
    .filter((p) => p.status === "ACTIVE" && p.sportIds.includes("football"))
    .map((p) =>
      attendanceHistory({
        playerId: p.id,
        playerName: p.name,
        sessions,
        attendance: byPlayer.get(p.id) ?? [],
        squadNames: names,
        staff: true,
      }),
    )
    .filter((h) => h.followUp)
    .sort(
      (a, b) =>
        b.consecutiveAbsences - a.consecutiveAbsences ||
        a.playerName.localeCompare(b.playerName),
    );
}
