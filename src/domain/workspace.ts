import type { AcademyDrillContent, DrillCategoryId } from "./drill-library";
import type { RecordBase, SportRecord } from "./entities";
import type { PlayerStatus } from "./player-lifecycle";
import type { ReportViewModel } from "./report";
import type {
  TrainingRecords,
  ParentScheduledSession,
  ParentClosure,
} from "./training";
import type {
  WeeklyPlan,
  MonthlySources,
  ReportingPeriod,
} from "./communication";
export type AcademyRole = "OWNER" | "ADMIN" | "COACH" | "PARENT" | "SUPPORT";
export interface AcademyConfiguration extends RecordBase {
  configVersion?: number;
  name: string;
  contactEmail: string;
  location?: string;
  about?: string;
  phone?: string;
  website?: string;
  /** The city the academy is in. Optional: academies made before it was asked have none. */
  city?: string;
  country: string;
  language: string;
  currency: string;
  timezone: string;
  dateLocale: string;
  weekStartsOn?: 0 | 1;
  dateFormat?: "DD_MMM_YYYY" | "MM_DD_YYYY" | "YYYY_MM_DD";
  timeFormat?: "12_HOUR" | "24_HOUR";
  sessionThemes?: string[];
  measurementSystem: "METRIC" | "IMPERIAL";
  brandAccent: string;
  logoData?: string;
  sportIds: string[];
  legacyRecordsRestricted?: boolean;
  ageGroups: string[];
  reviewFrequency: string;
  modules: string[];
  nutritionOptional: true;
  demo: boolean;
  onboardingStatus: "CONFIGURING" | "ACTIVE";
}
export interface AcademyMembership extends RecordBase {
  userId: string;
  role: AcademyRole;
  active: boolean;
  sportIds: string[];
  expiresAt?: string;
}
export interface WorkspacePlayer extends RecordBase {
  recordVersion?: number;
  name: string;
  sportIds: string[];
  squad: string;
  squadId?: string;
  ageCategory?: string;
  birthDate?: string;
  position?: string;
  status?: PlayerStatus;
  coachId: string;
  /** The owner's "keep for now" decision about a player who is 18 or older (set only by the age review). */
  ageDecision?: import("./player-age").AgeDecision | null;
}
export interface WorkspacePlan extends SportRecord {
  recordVersion?: number;
  playerId: string;
  coachId: string;
  focus: string;
  reason: string;
  drillIds: string[];
  observe: string;
  homePractice: string;
  reviewDate: string;
  nextStep: string;
  status:
    | "DRAFT"
    | "ACTIVE"
    | "NEEDS_REVIEW"
    | "CONTINUE"
    | "ADAPT"
    | "COMPLETED"
    | "PAUSED";
  privateNote: string;
}
export interface WorkspaceReport extends SportRecord {
  correctionOf?: string;
  reportingPeriod?: ReportingPeriod;
  monthlySources?: MonthlySources;
  recordVersion?: number;
  sourceEvidenceIds?: string[];
  playerId: string;
  planId: string;
  period: string;
  observation: string;
  evidenceType:
    | "RAW_RECORD"
    | "COACH_OBSERVATION"
    | "CALCULATED_METRIC"
    | "AI_ESTIMATE"
    | "MISSING_OR_UNCLEAR";
  nextStep: string;
  closingNote: string;
  status: "Draft" | "Approved" | "Revision Requested";
  externalDeliveryStatus: "NOT_SENT";
  snapshot?: ReportViewModel;
  approvedPlan?: Omit<WorkspacePlan, "privateNote">;
  /** Set when an approved report was pulled back from families (P1-10). The
   * report returns to "Revision Requested" without its snapshot; the approved
   * version stays in the append-only approval history and the audit log. */
  withdrawal?: { at: string; by: string; reason: string };
}
export interface WorkspaceDrill extends SportRecord {
  name: string;
  focusArea: string;
  /** Shown to families in monthly reports: keep it short and plain. */
  purpose: string;
  /** Shown to families in monthly reports: keep it short and plain. */
  cue: string;
  /** ACADEMY_CURRICULUM is a stored academy drill. UNIVERSAL_CATALOGUE only
   * appears in a session or plan snapshot of a catalogue drill. */
  ownership: "ACADEMY_CURRICULUM" | "UNIVERSAL_CATALOGUE";
  /** A legacy template id, or the universal drill this is a copy of. */
  templateId?: string;
  /** Optimistic-concurrency version of a stored academy drill. */
  recordVersion?: number;
  /** One of the seven predefined categories. Missing on older drills, which
   * are shown as Uncategorised until edited. */
  category?: DrillCategoryId;
  /** Missing means ACTIVE (older drills). Archived drills stay readable for
   * history but cannot be added to new sessions or plans. */
  status?: "ACTIVE" | "ARCHIVED";
  createdBy?: string;
  archivedAt?: string;
  archivedBy?: string;
  /** The catalogue content version this copy or snapshot came from. */
  universalVersion?: number;
  /** Staff-only coaching content. Never part of any family projection. */
  content?: AcademyDrillContent;
  /** Internal Sportozen restriction (not a governing-body rule), kept on a
   * copy of a restricted catalogue drill and in every snapshot of it. */
  minimumAge?: { years: number; basis: "INTERNAL_PRODUCT_POLICY" };
  /** Safety lines inherited from a restricted catalogue drill. A copy keeps
   * them for ever: they cannot be removed through an edit. */
  lockedSafety?: string[];
  /** Present on a drill saved in a session: when the complete content was
   * captured and what it was captured from. A catalogue drill saved in a
   * session without this marker is a legacy incomplete snapshot. */
  snapshot?: {
    capturedAt: string;
    contentVersion: number;
    source: "UNIVERSAL_CATALOGUE" | "ACADEMY_DRILL";
    /** The approved objective of a catalogue drill, verbatim. */
    objective?: string;
    number?: number;
  };
}
export interface WorkspaceBranch extends RecordBase {
  name: string;
  timezone: string;
}
export interface WorkspaceProgram extends SportRecord {
  name: string;
  branchId: string;
}
export interface WorkspaceUpdate extends SportRecord {
  approvedAt?: string;
  recordVersion?: number;
  playerId: string;
  planId: string;
  messageBody: string;
  sourceReportId?: string;
  sourceWeeklyPlanId?: string;
  type:
    | "DEVELOPMENT"
    | "NUTRITION_HYDRATION"
    | "UPCOMING_TRAINING"
    | "REVIEWED_SESSION";
  approvalStatus: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  inAppPublicationStatus: "UNPUBLISHED" | "PUBLISHED";
  externalDeliveryStatus: "NOT_SENT";
  version: number;
  approvedBody?: string;
  approvedSource?:
    ReportViewModel | { guideline: string; approval: "ACADEMY_APPROVED" };
  publishedGuardianIds?: string[];
}
export interface WorkspaceConversation extends RecordBase {
  guardianId: string;
  playerId: string;
  updateId?: string;
  subject: string;
  status: "OPEN" | "CLOSED";
  messages: {
    id: string;
    senderId: string;
    senderRole: AcademyRole;
    body: string;
    at: string;
    internal: boolean;
    channel?: "IN_APP" | "WHATSAPP";
  }[];
}
export interface WorkspaceMoney extends RecordBase {
  playerId: string;
  amountMinor: number;
  currency: string;
  label: string;
}
export interface WorkspacePreference extends RecordBase {
  userId: string;
  nutrition: boolean;
  development: boolean;
  inApp: boolean;
  language: string;
  quietStart: string;
  quietEnd: string;
  externalEnabled: false;
}
export interface WorkspaceDietaryNote extends RecordBase {
  playerId: string;
  userId: string;
  note: string;
}
/**
 * A prospective player before any player record exists (P1-05). Owner and
 * admin only: it holds a child's name and a guardian's contact, so coaches,
 * parents and Support never read it. Converting it creates exactly one player.
 */
export interface WorkspaceEnquiry extends RecordBase {
  recordVersion?: number;
  childName: string;
  guardianName: string;
  /** A phone number or e-mail address, as given. */
  contact: string;
  source: string;
  followUpDate?: string;
  /** Staff-only working notes. */
  notes: string;
  status: "OPEN" | "WAITLIST" | "CLOSED" | "CONVERTED";
  closedReason?: string;
  convertedPlayerId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceRecords extends TrainingRecords {
  enquiry: WorkspaceEnquiry;
  weekly: WeeklyPlan;
  player: WorkspacePlayer;
  plan: WorkspacePlan;
  report: WorkspaceReport;
  drill: WorkspaceDrill;
  branch: WorkspaceBranch;
  program: WorkspaceProgram;
  update: WorkspaceUpdate;
  conversation: WorkspaceConversation;
  fee: WorkspaceMoney;
  preference: WorkspacePreference;
  dietary: WorkspaceDietaryNote;
}
export type WorkspaceKind = keyof WorkspaceRecords;
export interface WorkspacePayload {
  viewer?: { id: string; name: string; playerLogin?: true };
  /** Present when only some record kinds were requested; the other kinds in
   * `records` are empty because they were not loaded, not because none exist. */
  loadedKinds?: WorkspaceKind[];
  academy: AcademyConfiguration;
  membership: AcademyMembership;
  parentSchedule?: ParentScheduledSession[];
  /** Days the academy or a branch is closed, as families may read them. */
  parentClosures?: ParentClosure[];
  /** Current staff review guidance, derived on read and never saved in reports. */
  monthlyReportReview?: Record<
    string,
    { sourcesCurrent: boolean; reason?: string }
  >;
  guardians?: { playerId: string; userId: string; name: string }[];
  subscription?: {
    tier: string;
    status: string;
    modules: string[];
  };
  records: { [K in WorkspaceKind]: WorkspaceRecords[K][] };
  members: {
    userId: string;
    name: string;
    role: AcademyRole;
    active: boolean;
    id: string;
  }[];
}
