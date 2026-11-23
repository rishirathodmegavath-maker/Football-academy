import type { LifecycleState } from "./academy-lifecycle";
import type { WorkspacePayload } from "./workspace";

/** What the portal needs to render its shell and decide what to load next.
 * Every field equals the same field of the full academy payload. */
export type WorkspaceBootstrap = Pick<
  WorkspacePayload,
  "academy" | "membership"
> & {
  viewer: { id: string; name: string; playerLogin?: true };
  /** Where the academy is in the approval workflow; only an ACTIVE academy opens the portal. */
  lifecycle?: { state: LifecycleState; label: string };
};

/** The fields of the payload that identify the signed-in context. Both the
 * bootstrap and the full payload satisfy it. */
export type WorkspaceShell = Pick<
  WorkspacePayload,
  "academy" | "membership"
> & { viewer?: { id: string; name: string; playerLogin?: true } };

export interface HomeSession {
  id: string;
  title?: string;
  theme: string;
  status: string;
  startAt: string;
  endAt: string;
  location: string;
  squadId: string;
  /** Name of the batch, when the viewer can read it. */
  batchName?: string;
  rosterCount: number;
  sharedObjective?: { goal: string; observe: string };
}

export type HomeActivity =
  | {
      kind: "EVIDENCE";
      id: string;
      date: string;
      playerName?: string;
      sessionId: string;
      playerId: string;
    }
  | {
      kind: "CONVERSATION";
      id: string;
      date: string;
      subject: string;
      playerName?: string;
      playerId: string;
    };

/** The Owner, Admin and Coach Home dashboard. Computed on the server from the
 * viewer's own permission-scoped records, in the academy's time zone. */
export interface HomeSummary {
  academyId: string;
  /** Server time the summary was computed. */
  generatedAt: string;
  /** Academy-local date (YYYY-MM-DD). */
  today: string;
  nextSession?: HomeSession;
  todaySessions: HomeSession[];
  /** The next few confirmed sessions on days after today, soonest first (today's are in `todaySessions`). */
  comingSessions: HomeSession[];
  upcomingSessions: number;
  activePlayers: number;
  batches: number;
  openConversations: number;
  recent: HomeActivity[];
  observationsToReview: { count: number; firstSessionId?: string };
  reportDrafts: number;
  unmarkedToday: { count: number; firstSessionId?: string };
  focus?: { playerName: string; focus: string; observe: string };
  reportsThisMonth: { month: string; total: number; approved: number };
  approvedReports: number;
  hasBranch: boolean;
}
