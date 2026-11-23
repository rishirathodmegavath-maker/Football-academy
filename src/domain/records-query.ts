import type { ReportingPeriod } from "./communication";
import type {
  WorkspaceConversation,
  WorkspacePlan,
  WorkspaceReport,
  WorkspaceUpdate,
} from "./workspace";
import type {
  FootballAttendance,
  FootballEvidence,
  FootballSession,
} from "./training";

/** Returned instead of a bare array when a request carries `limit`. */
export interface RecordPage<T> {
  items: T[];
  /** Records matching the filters, before paging. */
  total: number;
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: number | null;
}

/** A report without its approved snapshot, saved monthly sources or approved
 * plan: enough to list, filter and open reports. Full content is the detail
 * read, `GET /records/report/:id`. */
export interface ReportSummary {
  id: string;
  academyId: string;
  sportId: string;
  playerId: string;
  planId: string;
  period: string;
  /** The label the report screens show for this period. */
  periodLabel: string;
  reportingPeriod?: ReportingPeriod;
  correctionOf?: string;
  recordVersion?: number;
  status: WorkspaceReport["status"];
  externalDeliveryStatus: WorkspaceReport["externalDeliveryStatus"];
  /** Approved reports carry a snapshot, available through the detail read. */
  hasSnapshot: boolean;
  /** Approved reports: the recorded focus and next step, for history lists. */
  focus?: string;
  nextStep?: string;
  /** A monthly report built from saved training sources. */
  monthly: boolean;
  /** Nothing has been written in the observation, next step or closing note. */
  untouched: boolean;
  /** The next development step has text. */
  hasNextStep: boolean;
  /** Staff only, for unapproved monthly reports, and only when the list is
   * requested with `review=1`: whether the saved sources still match current
   * training records. The detail read re-checks it. */
  sourcesCurrent?: boolean;
  staleReason?: string;
}

/** The current training records behind one monthly report's saved sources,
 * reduced to what the review table and the focus summary read. */
export interface MonthlyReportSources {
  sessions: FootballSession[];
  evidence: {
    id: string;
    sessionId: string;
    playerId: string;
    observation: string;
  }[];
  attendance: {
    sessionId: string;
    playerId: string;
    status: FootballAttendance["status"];
  }[];
  drills: { id: string; focusArea: string }[];
}

/** What Messages needs from one approved report: the text a message is
 * prepared from, and whether the report can support each kind of update.
 * Nothing else of the report (no monthly sources, drafts, scores, photos,
 * logo or private notes). Parents and support members receive the sanitised
 * approved snapshot they already see in Reports; `sourceEvidenceIds` and
 * `monthly` are set for staff only. */
export interface ReportContent {
  id: string;
  academyId: string;
  sportId: string;
  playerId: string;
  planId: string;
  period: string;
  status: "Approved";
  snapshot: {
    academy: string;
    player: string;
    period: string;
    focus: string;
    reviewedReason?: string;
    practised: string;
    activities: { name: string; purpose: string }[];
    evidence: { text: string; source: string; reference?: string }[];
    nextStep: string;
    observationCriteria?: string;
    reviewDate?: string;
  };
  /** The approved plan the report was issued with, when there is one. */
  approvedPlan?: { id: string; focus: string };
  sourceEvidenceIds?: string[];
  /** Built from saved monthly training sources (staff only). */
  monthly?: boolean;
}

/** Everything the Messages screen shows for one player, read together. Each
 * part is exactly what the matching filtered records read returns for the same
 * viewer (see `playerMessages`). */
export interface PlayerMessages {
  plans: WorkspacePlan[];
  updates: WorkspaceUpdate[];
  conversations: WorkspaceConversation[];
  reports: ReportContent[];
}

/** Attendance and evidence counts for one session. */
export interface SessionCounts {
  present: number;
  absent: number;
  excused: number;
  /** Attendance records still marked unmarked. */
  unmarked: number;
  /** Evidence not yet reviewed (draft or awaiting review). */
  awaitingReview: number;
}

/** A session without its agenda, objectives and preparation notes. With
 * `counts=1` it also carries the session's attendance and review counts. */
export type SessionSummary = Omit<
  FootballSession,
  "agenda" | "objectives" | "sharedObjective" | "preparation"
> & { agendaItems: number; counts?: SessionCounts };

/** An evidence record read for one session, with whether the player has other
 * reviewed evidence it can be compared with. */
export type SessionEvidence = FootballEvidence & {
  comparablePrevious: boolean;
};
