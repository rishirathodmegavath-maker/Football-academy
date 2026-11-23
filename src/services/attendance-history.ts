import {
  FOLLOW_UP_AFTER,
  type AttendanceHistory,
  type AttendanceHistoryRow,
  type FootballAttendance,
  type FootballSession,
} from "@/domain/training";

/**
 * One player's attendance, from records that already exist. Only COMPLETED
 * sessions count: a cancelled session was never held, and a session still to
 * come has nothing to count. An UNMARKED mark carries no information and is
 * left out.
 *
 * - percentage = present / (present + absent + excused)
 * - consecutive absences = the latest run of ABSENT marks, newest first.
 *   EXCUSED neither adds to the run nor ends it; PRESENT ends it.
 */
export function attendanceHistory(input: {
  playerId: string;
  playerName: string;
  sessions: FootballSession[];
  attendance: FootballAttendance[];
  squadNames: ReadonlyMap<string, string>;
  /** Staff see the follow-up flag and correction reasons; parents do not. */
  staff: boolean;
}): AttendanceHistory {
  const marks = new Map(
    input.attendance
      .filter((mark) => mark.playerId === input.playerId)
      .map((mark) => [mark.sessionId, mark]),
  );
  const rows: AttendanceHistoryRow[] = [];
  for (const session of input.sessions) {
    if (
      session.status !== "COMPLETED" ||
      !session.roster.some((p) => p.playerId === input.playerId)
    )
      continue;
    const mark = marks.get(session.id);
    if (!mark || mark.status === "UNMARKED") continue;
    rows.push({
      sessionId: session.id,
      date: session.startLocal.slice(0, 10),
      startAt: session.startAt,
      squadName: input.squadNames.get(session.squadId) ?? "Training batch",
      status: mark.status,
      ...(input.staff && mark.correctionReason
        ? { correctionReason: mark.correctionReason }
        : {}),
    });
  }
  rows.sort(
    (a, b) =>
      b.startAt.localeCompare(a.startAt) ||
      b.sessionId.localeCompare(a.sessionId),
  );
  let present = 0,
    absent = 0,
    excused = 0,
    streak = 0,
    open = true;
  for (const row of rows) {
    if (row.status === "PRESENT") present++;
    else if (row.status === "ABSENT") absent++;
    else excused++;
    if (!open) continue;
    if (row.status === "ABSENT") streak++;
    else if (row.status === "PRESENT") open = false;
  }
  const counted = present + absent + excused;
  return {
    playerId: input.playerId,
    playerName: input.playerName,
    counted,
    present,
    absent,
    excused,
    percentage: counted ? Math.round((present / counted) * 1000) / 10 : null,
    consecutiveAbsences: streak,
    ...(input.staff ? { followUp: streak >= FOLLOW_UP_AFTER } : {}),
    sessions: rows,
  };
}
