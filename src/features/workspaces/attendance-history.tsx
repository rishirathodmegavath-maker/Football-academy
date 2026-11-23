"use client";
import { useState } from "react";
import type { AttendanceHistory } from "@/domain/training";
import {
  useAttendanceHistory,
  useFollowUps,
} from "@/hooks/use-training-extras";
import type { PortalController } from "./portal-types";
import "./session-extras.css";
import { displayDay } from "@/services/date-display";

const statusText: Record<string, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  EXCUSED: "Excused",
};
const dateText = (date: string) => displayDay(date, { weekday: true });
const PAGE = 10;

/** The numbers and the session-by-session marks. Staff also see the follow-up
 * notice and correction reasons; the server sends a parent neither, so none is
 * shown to them. */
export function AttendanceHistoryView({
  history,
  parent = false,
}: {
  history: AttendanceHistory;
  parent?: boolean;
}) {
  const [all, setAll] = useState(false);
  const rows = all ? history.sessions : history.sessions.slice(0, PAGE);
  return (
    <section
      className="sx-history"
      aria-label={`Attendance of ${history.playerName}`}
    >
      {!parent && history.followUp && (
        <p className="sx-flag" role="alert">
          <strong>Follow-up needed:</strong> {history.consecutiveAbsences}{" "}
          sessions missed in a row.
        </p>
      )}
      {history.counted === 0 ? (
        <p>No completed sessions have been recorded yet.</p>
      ) : (
        <>
          <p className="sx-figures">
            <strong data-testid="attendance-percentage">
              {history.percentage}%
            </strong>{" "}
            attendance · {history.present} present · {history.absent} absent ·{" "}
            {history.excused} excused · {history.counted} sessions
          </p>
          <div
            className="sx-bar"
            role="img"
            aria-label={`${history.percentage} percent attendance`}
          >
            <span style={{ width: `${history.percentage ?? 0}%` }} />
          </div>
          <table className="sx-table">
            <caption className="sx-sr">
              Attendance history for {history.playerName}, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Batch</th>
                <th scope="col">Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sessionId}>
                  <td>{dateText(row.date)}</td>
                  <td>{row.squadName}</td>
                  <td>
                    <span className={`sx-mark sx-${row.status.toLowerCase()}`}>
                      {statusText[row.status] ?? row.status}
                    </span>
                    {!parent && row.correctionReason && (
                      <small className="sx-note">
                        Correction: {row.correctionReason}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.sessions.length > PAGE && (
            <button type="button" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${history.sessions.length}`}
            </button>
          )}
          <p className="sx-small">
            Only completed sessions count. Cancelled and unmarked sessions are
            left out, and an excused absence neither adds to nor ends a run of
            absences.
          </p>
        </>
      )}
    </section>
  );
}

/** Loads one player's history when shown. */
export function PlayerAttendanceHistory({
  workspace: w,
  playerId,
  parent = false,
}: {
  workspace: PortalController;
  playerId: string;
  parent?: boolean;
}) {
  const read = useAttendanceHistory(w, playerId);
  if (read.error) return <p role="alert">{read.error}</p>;
  if (!read.data) return <p role="status">Loading attendance history…</p>;
  return <AttendanceHistoryView history={read.data} parent={parent} />;
}

/** A disclosure that fetches the history only when it is opened. */
export function AttendanceHistoryDisclosure({
  workspace,
  playerId,
  name,
}: {
  workspace: PortalController;
  playerId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sx-disclosure">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide history" : "History"} for ${name}`}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <PlayerAttendanceHistory workspace={workspace} playerId={playerId} />
      )}
    </div>
  );
}

/** Players who have missed three or more sessions in a row. Staff only; a
 * coach sees only the players assigned to them. */
export function FollowUpList({
  workspace: w,
}: {
  workspace: PortalController;
}) {
  const read = useFollowUps(w);
  const [open, setOpen] = useState("");
  if (read.error) return <p role="alert">{read.error}</p>;
  if (!read.data) return null;
  return (
    <section className="sx-followups" aria-label="Attendance follow-up">
      <h2>Attendance follow-up</h2>
      {read.data.length === 0 ? (
        <p>No player has missed three sessions in a row.</p>
      ) : (
        <ul>
          {read.data.map((player) => (
            <li key={player.playerId}>
              <div>
                <strong>{player.playerName}</strong>
                <span>
                  {" "}
                  missed {player.consecutiveAbsences} sessions in a row ·{" "}
                  {player.percentage}% attendance
                </span>
                <button
                  type="button"
                  aria-expanded={open === player.playerId}
                  onClick={() =>
                    setOpen(open === player.playerId ? "" : player.playerId)
                  }
                >
                  {open === player.playerId ? "Hide history" : "View history"}
                </button>
              </div>
              {open === player.playerId && (
                <AttendanceHistoryView history={player} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
