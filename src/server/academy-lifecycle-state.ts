import "server-only";
import { database } from "./database";
import {
  isOperationalState,
  LIFECYCLE_STATES,
  type LifecycleState,
} from "@/domain/academy-lifecycle";

// The lowest layer of the approval workflow: reads only, no imports from the
// access layer, so workspace-access.ts and every service that re-checks an
// academy can use it without a cycle. The transitions live in
// academy-lifecycle.ts.

export interface Lifecycle {
  academyId: string;
  state: LifecycleState;
  version: number;
  submissions: number;
  submittedAt: string | null;
  reviewerId: string | null;
  reviewStartedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
  updatedAt: string;
}

export function lifecycleOf(academyId: string): Lifecycle | undefined {
  const row = database()
    .prepare("SELECT * FROM academy_lifecycle WHERE academyId=?")
    .get(academyId);
  if (!row) return undefined;
  // A value outside the table would mean the CHECK constraint was bypassed;
  // treat it as no lifecycle (not operational) rather than guess.
  if (!LIFECYCLE_STATES.includes(row.state as LifecycleState)) return undefined;
  return {
    academyId: String(row.academyId),
    state: row.state as LifecycleState,
    version: Number(row.version),
    submissions: Number(row.submissions),
    submittedAt: (row.submittedAt as string | null) ?? null,
    reviewerId: (row.reviewerId as string | null) ?? null,
    reviewStartedAt: (row.reviewStartedAt as string | null) ?? null,
    decidedAt: (row.decidedAt as string | null) ?? null,
    decidedBy: (row.decidedBy as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    updatedAt: String(row.updatedAt),
  };
}

/**
 * The one answer to "may this academy run operations (send messages, take
 * payments, use player data)?": its platform entitlement is ACTIVE and its
 * approval lifecycle is ACTIVE. An academy with no lifecycle row is not
 * operational (fail closed). Used by the worker and every service that
 * re-checks an academy outside a request.
 */
export function academyOperational(academyId: string): boolean {
  const entitlement = database()
    .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
    .get(academyId);
  return (
    entitlement?.status === "ACTIVE" &&
    isOperationalState(lifecycleOf(academyId)?.state)
  );
}
