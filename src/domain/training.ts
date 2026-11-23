import type { SportRecord } from "./entities";
import type { WorkspaceDrill } from "./workspace";
export interface TrainingRecord extends SportRecord {
  version: number;
  updatedAt: string;
  updatedBy: string;
}
export interface FootballSquad extends TrainingRecord {
  name: string;
  branchId: string;
  playerIds: string[];
}
export interface FootballVenue extends TrainingRecord {
  name: string;
  branchId: string;
  location: string;
  parentVenueId?: string;
  exclusive?: boolean;
  independentChildren?: boolean;
  bufferMinutes?: number;
}
export interface SessionObjective {
  playerId: string;
  playerName: string;
  planId?: string;
  goal: string;
  drillId: string;
  cue: string;
  observe: string;
}
export interface FootballSession extends TrainingRecord {
  branchId: string;
  squadId: string;
  venueId?: string;
  location: string;
  coachIds: string[];
  /** Verified selection only; manual locations have no invented Places identity. */
  googlePlaceId?: string;
  timezone: string;
  startLocal: string;
  endLocal: string;
  startAt: string;
  endAt: string;
  /** Optional editable title; training focus remains independently recorded. */
  title?: string;
  theme: string;
  status: "DRAFT" | "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  roster: { playerId: string; name: string }[];
  agenda: { drill: WorkspaceDrill; duration: number; drillVersion: number }[];
  objectives: SessionObjective[];
  sharedObjective?: { goal: string; cue: string; observe: string };
  preparation?: string[];
  copiedFromSessionId?: string;
  /** Set on an occurrence generated from a recurring series. The id is
   * `${seriesId}:${occurrenceDate}`, so a date can exist only once. */
  seriesId?: string;
  occurrenceDate?: string;
  /** Set when the session is cancelled: the status it was cancelled from
   * decides whether a parent ever saw it, so whether a notice is owed. */
  cancelledFrom?: "DRAFT" | "SCHEDULED" | "IN_PROGRESS";
  cancelledAt?: string;
}
/**
 * An all-day closure of the whole academy or one branch (P1-08, version 1:
 * academy/branch level and all-day only; no part-day or per-batch closures).
 * It blocks new sessions and skips recurring dates on those days. Sessions that
 * are already scheduled are NOT cancelled automatically: staff cancel them
 * through the normal flow so the cancellation notice and its reason stay
 * deliberate. Lifting a closure never recreates anything.
 */
export interface FootballClosure extends TrainingRecord {
  /** "" closes every branch of the academy. */
  branchId: string;
  /** Inclusive academy-local dates, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  /** Staff only. */
  reason: string;
  /** What families may read; empty means they see only that training is off. */
  publicNote: string;
  status: "ACTIVE" | "LIFTED";
}
/** The family-facing projection of a closure: no internal reason. */
export interface ParentClosure {
  id: string;
  startDate: string;
  endDate: string;
  scope: "ACADEMY" | "BRANCH";
  branchName?: string;
  note: string;
}
/** A date a series did not turn into a session, and why. Never shifted. */
export interface SkippedOccurrence {
  date: string;
  reason: "EXCLUDED" | "PAST" | "TIME_INVALID" | "CONFLICT" | "CLOSURE";
  /** Staff-facing explanation: holiday label, the clashing resource, or the
   * time-zone message. */
  detail: string;
}
export interface SeriesCancelOutcome {
  cancelled: number;
  /** Occurrences left alone: already started, already cancelled elsewhere, or
   * outside this coach's assignment. */
  left: { sessionId: string; date: string; reason: string }[];
  notices: NoticeReport;
}
/** What happened to the cancellation e-mails. Every guardian is accounted for. */
export interface NoticeReport {
  emailEnabled: boolean;
  guardians: number;
  queued: number;
  /** Queued, but held back so the per-address hourly limit is not exceeded. */
  deferred: number;
  alreadyNotified: number;
  noAddress: number;
  /** Invalid or suppressed address, or the daily ceiling reached. */
  refused: number;
}
/** A weekly recurring schedule. Occurrences are ordinary sessions (see
 * `FootballSession.seriesId`); this record is only the rule that produced them. */
export interface FootballSeries extends TrainingRecord {
  branchId: string;
  squadId: string;
  venueId?: string;
  location: string;
  coachIds: string[];
  timezone: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  /** Inclusive local dates, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  /** Local wall-clock times on each occurrence date, HH:mm. */
  startTime: string;
  endTime: string;
  title?: string;
  theme: string;
  agenda: { drillId: string; duration: number }[];
  exclusions: { date: string; label: string }[];
  status: "ACTIVE" | "CANCELLED";
  /** Dates the last run did not turn into sessions. A later run retries the
   * ones that were blocked by a conflict. */
  skipped: SkippedOccurrence[];
  cancelReason?: string;
  cancelledAt?: string;
  cancelOutcome?: SeriesCancelOutcome;
}
/** What a series would do right now. Nothing is saved. */
export interface SeriesPreview {
  occurrences: {
    date: string;
    startLocal: string;
    startAt: string;
    endAt: string;
  }[];
  skipped: SkippedOccurrence[];
  /** Sessions of this series that already exist. */
  existing: number;
}
export type WrapUpOutcome = "COMPLETED" | "PARTIAL" | "SKIPPED";
/** The coach's record of how a session actually went. Staff-only: it is never
 * part of a parent projection. One per session; its id is the session id. */
export interface SessionWrapUp extends TrainingRecord {
  sessionId: string;
  drills: {
    drillId: string;
    drillName: string;
    plannedMinutes: number;
    outcome: WrapUpOutcome;
    actualMinutes?: number;
    note: string;
  }[];
  observations: string;
  achievements: string;
  improvements: string;
}
export interface AttendanceHistoryRow {
  sessionId: string;
  /** Academy-local date of the session. */
  date: string;
  startAt: string;
  squadName: string;
  status: FootballAttendance["status"];
  /** Staff only. */
  correctionReason?: string;
}
export interface AttendanceHistory {
  playerId: string;
  playerName: string;
  /** Completed sessions that count (cancelled and unmarked ones do not). */
  counted: number;
  present: number;
  absent: number;
  excused: number;
  /** present ÷ (present + absent + excused), 0-100 with one decimal, or null
   * when nothing has been recorded yet. */
  percentage: number | null;
  /** Latest run of ABSENT marks; EXCUSED neither adds to it nor ends it. */
  consecutiveAbsences: number;
  /** Staff only: three or more consecutive absences. Absent for parents. */
  followUp?: boolean;
  /** Newest first. */
  sessions: AttendanceHistoryRow[];
}
export const FOLLOW_UP_AFTER = 3;
/** Public schedule projection only; never a staff session/roster payload. */
export interface ParentScheduledSession {
  id: string;
  childId: string;
  squadId: string;
  batchName: string;
  theme: string;
  startAt: string;
  endAt: string;
  startLocal: string;
  endLocal: string;
  timezone: string;
  location: string;
  /** CANCELLED appears only for a session a parent had seen as confirmed, so
   * the schedule shows what changed instead of silently dropping it. */
  status: "SCHEDULED" | "IN_PROGRESS" | "CANCELLED";
}
export interface FootballAttendance extends TrainingRecord {
  sessionId: string;
  playerId: string;
  status: "PRESENT" | "ABSENT" | "EXCUSED" | "UNMARKED";
  correctionReason: string;
}
export interface FootballEvidence extends TrainingRecord {
  sessionId: string;
  playerId: string;
  planId?: string;
  drillId: string;
  drillVersion: number;
  drillName: string;
  conditions: string;
  observation: string;
  staffNote: string;
  type: "COACH_OBSERVATION" | "RAW_RECORD";
  visibility: "PARENT_ELIGIBLE" | "STAFF_ONLY";
  measurement: "OBSERVATION" | "ATTEMPTS" | "ELAPSED_TIME";
  unit: "NONE" | "ATTEMPTS" | "SECONDS";
  attempts?: number;
  successes?: number;
  elapsedSeconds?: number;
  method: string;
  status:
    | "DRAFT"
    | "AWAITING_REVIEW"
    | "REVIEWED"
    | "UNCLEAR"
    | "REJECTED"
    | "SUPERSEDED";
  authorId: string;
  recordedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
}
export type TrainingKind =
  | "squad"
  | "venue"
  | "session"
  | "attendance"
  | "evidence"
  | "series"
  | "wrapup"
  | "closure";
export interface TrainingRecords {
  closure: FootballClosure;
  squad: FootballSquad;
  venue: FootballVenue;
  session: FootballSession;
  attendance: FootballAttendance;
  evidence: FootballEvidence;
  series: FootballSeries;
  wrapup: SessionWrapUp;
}
