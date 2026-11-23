/**
 * The academy approval lifecycle as a pure state machine. Nothing here reads a
 * database or a request, so the server, the screens and the tests all use the
 * same table.
 *
 * Stored states and how they map to the approved vocabulary:
 *
 *   REGISTRATION            the moment an academy is created: history action
 *                           REGISTERED. An academy cannot exist unregistered,
 *                           so it is an event, not a state.
 *   CONFIGURING             the owner is completing the academy profile
 *   SUBMITTED               submitted for approval (a resubmission after a
 *                           rejection is the same state; `submissions` > 1 and
 *                           the history action RESUBMITTED tell them apart)
 *   PENDING_REVIEW          a platform administrator opened the application and
 *                           the decision is pending
 *   ACTIVE                  APPROVED and operating. Approval is the decision
 *                           (history action APPROVED); nothing can happen
 *                           between approving and operating, so there is no
 *                           separate APPROVED state.
 *   REJECTED                not approved; the reason is shown to the owner, who
 *                           may edit and resubmit
 *   SUSPENDED               stopped after approval; reversible
 *
 * CONFIGURING already existed as `onboardingStatus` in the academy
 * configuration, and ACTIVE is the value that field already used for an
 * operating academy; both words keep their meaning.
 */
export const LIFECYCLE_STATES = [
  "CONFIGURING",
  "SUBMITTED",
  "PENDING_REVIEW",
  "REJECTED",
  "ACTIVE",
  "SUSPENDED",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_ACTIONS = [
  "submit",
  "startReview",
  "approve",
  "reject",
  "suspend",
  "reactivate",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Who may perform an action: the academy's OWNER, or a platform administrator. */
export type LifecycleActor = "OWNER" | "PLATFORM";

export interface Transition {
  from: readonly LifecycleState[];
  to: LifecycleState;
  actor: LifecycleActor;
  /** A written reason is mandatory (shown to the owner). */
  reasonRequired: boolean;
}

export const REASON_MIN = 10;
export const REASON_MAX = 1000;

export const TRANSITIONS: Record<LifecycleAction, Transition> = {
  // The same action serves the first submission and a resubmission.
  submit: {
    from: ["CONFIGURING", "REJECTED"],
    to: "SUBMITTED",
    actor: "OWNER",
    reasonRequired: false,
  },
  startReview: {
    from: ["SUBMITTED"],
    to: "PENDING_REVIEW",
    actor: "PLATFORM",
    reasonRequired: false,
  },
  approve: {
    from: ["PENDING_REVIEW"],
    to: "ACTIVE",
    actor: "PLATFORM",
    reasonRequired: false,
  },
  reject: {
    from: ["PENDING_REVIEW"],
    to: "REJECTED",
    actor: "PLATFORM",
    reasonRequired: true,
  },
  suspend: {
    from: ["ACTIVE"],
    to: "SUSPENDED",
    actor: "PLATFORM",
    reasonRequired: true,
  },
  reactivate: {
    from: ["SUSPENDED"],
    to: "ACTIVE",
    actor: "PLATFORM",
    reasonRequired: false,
  },
};

/** The history label of a transition (a resubmission has its own). */
export type HistoryAction =
  | "REGISTERED"
  | "MIGRATED"
  | "SUBMITTED"
  | "RESUBMITTED"
  | "REVIEW_STARTED"
  | "APPROVED"
  | "REJECTED"
  | "SUSPENDED"
  | "REACTIVATED";

export function historyAction(
  action: LifecycleAction,
  from: LifecycleState,
): HistoryAction {
  if (action === "submit")
    return from === "REJECTED" ? "RESUBMITTED" : "SUBMITTED";
  return {
    startReview: "REVIEW_STARTED",
    approve: "APPROVED",
    reject: "REJECTED",
    suspend: "SUSPENDED",
    reactivate: "REACTIVATED",
  }[action] as HistoryAction;
}

/** The resulting state, or null when the action is not allowed from `from`. */
export function nextState(
  from: LifecycleState,
  action: LifecycleAction,
): LifecycleState | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

/** Only an ACTIVE academy may use the operational modules (players, batches,
 * sessions, attendance, finance, announcements, reports, messages). */
export function isOperationalState(state: LifecycleState | undefined) {
  return state === "ACTIVE";
}

/** States in which the owner may edit the academy profile and (re)submit. */
export function isOnboardingState(state: LifecycleState | undefined) {
  return (
    state === "CONFIGURING" ||
    state === "SUBMITTED" ||
    state === "PENDING_REVIEW" ||
    state === "REJECTED"
  );
}

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  CONFIGURING: "Setting up",
  SUBMITTED: "Submitted for approval",
  PENDING_REVIEW: "Pending review",
  REJECTED: "Not approved",
  ACTIVE: "Approved and active",
  SUSPENDED: "Suspended",
};

/** What the owner needs to know and do in each state. */
export const LIFECYCLE_OWNER_TEXT: Record<LifecycleState, string> = {
  CONFIGURING:
    "Complete your academy profile, then submit it for approval. Players, batches, sessions, fees and messages open once Sportozen approves your academy.",
  SUBMITTED:
    "Your application is waiting for a Sportozen reviewer. You will see the decision here.",
  PENDING_REVIEW:
    "A Sportozen reviewer is looking at your application. You will see the decision here.",
  REJECTED:
    "Your application was not approved. Read the feedback below, update your profile and submit it again.",
  ACTIVE: "Your academy is approved.",
  SUSPENDED: "This academy is suspended.",
};

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** A required item blocks submission until it is done. */
  required: boolean;
}
