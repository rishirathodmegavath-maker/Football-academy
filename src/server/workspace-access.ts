import "server-only";
import type {
  AcademyRole,
  WorkspaceKind,
  WorkspaceRecords,
} from "@/domain/workspace";
import { workspaceRepository as repository } from "./workspace-repository";
import { authenticatedUser, WorkspaceError } from "./auth";
import { audit, database } from "./database";
import {
  isPlayerLinkLogin,
  playerLoginKey,
  PLAYER_LOGIN_HIDDEN_KINDS,
} from "./player-login";
import { enforceWriteLimit, markWriteRequest } from "./rate-limit";
import { requireMfa } from "./mfa-policy";
import { isTrustedOrigin } from "./app-origin";
import { parentReportSnapshot } from "@/services/reports/report-presentation";
import { isOperationalState, type LifecycleState } from "@/domain/academy-lifecycle";
import { lifecycleOf } from "./academy-lifecycle-state";
import { ARCHIVED_MESSAGE, isArchived } from "@/domain/player-lifecycle";
/**
 * What a request may reach in an academy that is not yet approved.
 *  - "operational" (the default, so a new route is closed until someone
 *    decides otherwise): players, batches, sessions, attendance, finance,
 *    announcements, messages, reports. Only an ACTIVE academy.
 *  - "onboarding": the academy profile, the approval status and the
 *    submit/resubmit action. Any academy that is set up or awaiting a decision,
 *    and an ACTIVE one; never a suspended academy.
 */
export type AccessScope = "operational" | "onboarding";
function notOpenYet(state: string | undefined, role: string) {
  if (role !== "OWNER" && role !== "ADMIN")
    return "This academy is not open yet.";
  if (state === "CONFIGURING")
    return "This academy has not been approved yet. Complete the academy profile and submit it for approval.";
  if (state === "SUBMITTED" || state === "PENDING_REVIEW")
    return "This academy is waiting for approval. Operational features open once Sportozen approves it.";
  if (state === "REJECTED")
    return "This academy was not approved. Read the feedback, update the profile and submit it again.";
  return "This academy workspace is not available.";
}
export async function access(
  headers: Headers,
  academyId: string,
  scope: AccessScope = "operational",
) {
  const user = await authenticatedUser(headers);
  // State-changing requests (marked by sameOrigin) are limited per verified user.
  enforceWriteLimit(headers, user.id);
  const membership = repository.membership(academyId, user.id),
    academy = repository.academy(academyId);
  if (!membership || !academy)
    throw new WorkspaceError(403, "No active membership in this academy.");
  const entitlement = database()
    .prepare("SELECT status FROM platform_entitlements WHERE academyId=?")
    .get(academyId);
  if (entitlement?.status !== "ACTIVE")
    throw new WorkspaceError(
      403,
      "This academy workspace is currently suspended.",
    );
  // The approval lifecycle is decided on the server for every request; a screen
  // that hides a button is not the control.
  const state = lifecycleOf(academyId)?.state;
  if (
    scope === "operational"
      ? !isOperationalState(state)
      : !state || state === "SUSPENDED"
  )
    throw new WorkspaceError(
      403,
      notOpenYet(state, membership.role),
      {},
      "ACADEMY_NOT_APPROVED",
    );
  // Two-step verification, where the owner's policy requires it for this role.
  requireMfa(user, membership.role, academyId);
  return { user, membership, academy, lifecycleState: state };
}
/** Who is calling and in which academy. `lifecycleState` is the approval state
 * the access check already read, so the bootstrap needs no second query; code
 * that builds a context by hand may leave it out. */
export type WorkspaceAccess = Omit<
  Awaited<ReturnType<typeof access>>,
  "lifecycleState"
> & { lifecycleState?: LifecycleState };
export function requireRole(ctx: WorkspaceAccess, roles: AcademyRole[]) {
  if (!roles.includes(ctx.membership.role))
    throw new WorkspaceError(
      403,
      "Your academy role cannot perform this action.",
    );
}
export function requireSport(ctx: WorkspaceAccess, sportId: string) {
  if (
    sportId !== "football" ||
    !ctx.academy.sportIds.includes(sportId) ||
    (ctx.membership.sportIds.length &&
      !ctx.membership.sportIds.includes(sportId))
  )
    throw new WorkspaceError(
      403,
      "Only football is available in this release and academy assignment.",
    );
}
const parentKinds = new Set<WorkspaceKind>([
  "weekly",
  "player",
  "plan",
  "report",
  "update",
  "conversation",
  "preference",
  "dietary",
  "fee",
]);
// Repeated reads inside ONE synchronous read operation (an academy payload, a
// finance view, a record list) are shared through a lookup scope. The scope
// closes when that call returns: node:sqlite is synchronous and nothing inside
// awaits, so no other request runs while it is open, nothing is reused across
// requests, and every request still checks access against the database. A
// function returning a promise keeps the scope for its synchronous part only.
let lookupScope: Map<string, unknown> | undefined;
export function withLookupScope<T>(read: () => T): T {
  if (lookupScope) return read();
  lookupScope = new Map();
  try {
    return read();
  } finally {
    lookupScope = undefined;
  }
}
/** The value computed earlier in the open lookup scope, else computes it.
 * Thrown errors are not remembered; outside a scope it always computes. */
export function scopedLookup<T>(key: string, compute: () => T): T {
  if (!lookupScope) return compute();
  if (!lookupScope.has(key)) lookupScope.set(key, compute());
  return lookupScope.get(key) as T;
}
/**
 * The one definition of a coach's reach over players: a coach covers a group
 * only when every player in it is assigned to that coach. Sessions, batches
 * and assignment checks all use this, so the rule cannot drift between them.
 */
export function coachCoversPlayers(
  academyId: string,
  coachId: string,
  playerIds: readonly string[],
) {
  return playerIds.every(
    (id) => find(academyId, "player", id)?.coachId === coachId,
  );
}
function find<K extends WorkspaceKind>(academyId: string, kind: K, id: string) {
  return scopedLookup(`record\u0000${academyId}\u0000${kind}\u0000${id}`, () =>
    repository.find(academyId, kind, id),
  );
}
// Historical sports remain in storage; customer APIs never expose or mutate them.
function activeFootballRecords<K extends WorkspaceKind>(
  ctx: WorkspaceAccess,
  records: WorkspaceRecords[K][],
): WorkspaceRecords[K][] {
  return records
    .filter((record) => {
      if ("sportId" in record && record.sportId !== "football") return false;
      if ("sportIds" in record && !record.sportIds.includes("football"))
        return false;
      if ("playerId" in record) {
        const player = find(ctx.academy.id, "player", record.playerId);
        if (!player?.sportIds.includes("football")) return false;
      }
      return true;
    })
    .map((record) =>
      "sportIds" in record ? { ...record, sportIds: ["football"] } : record,
    );
}
export function moduleEnabled(ctx: WorkspaceAccess, kind: WorkspaceKind) {
  const required =
    kind === "fee"
      ? "fees"
      : kind === "report"
        ? "reports"
        : ["update", "conversation", "preference", "dietary"].includes(kind)
          ? "communication"
          : [
                "player",
                "plan",
                "drill",
                "program",
                "squad",
                "venue",
                "session",
                "attendance",
                "evidence",
                "series",
                "wrapup",
                "closure",
                "enquiry",
                "weekly",
              ].includes(kind)
            ? "development"
            : undefined;
  if (!required) return true;
  const row = scopedLookup(`entitlement\u0000${ctx.academy.id}`, () =>
    database()
      .prepare("SELECT modules FROM platform_entitlements WHERE academyId=?")
      .get(ctx.academy.id),
  );
  return (
    ctx.academy.modules.includes(required) &&
    Boolean(row && JSON.parse(String(row.modules)).includes(required))
  );
}
export function requireModule(ctx: WorkspaceAccess, kind: WorkspaceKind) {
  if (!moduleEnabled(ctx, kind))
    throw new WorkspaceError(
      403,
      "This module is not enabled for the academy subscription and configuration.",
    );
}
export function visibleRecords<K extends WorkspaceKind>(
  ctx: WorkspaceAccess,
  kind: K,
): WorkspaceRecords[K][] {
  return withLookupScope(() =>
    // Support reads are audited on every call, so they are never shared.
    ctx.membership.role === "SUPPORT"
      ? readVisibleRecords(ctx, kind)
      : [
          ...scopedLookup(
            `visible\u0000${ctx.academy.id}\u0000${ctx.membership.id}\u0000${ctx.user.id}\u0000${ctx.membership.role}\u0000${kind}`,
            () => readVisibleRecords(ctx, kind),
          ),
        ],
  );
}
function readVisibleRecords<K extends WorkspaceKind>(
  ctx: WorkspaceAccess,
  kind: K,
): WorkspaceRecords[K][] {
  if (!moduleEnabled(ctx, kind)) return [];
  if (kind === "fee" && ["COACH", "SUPPORT"].includes(ctx.membership.role))
    return [];
  // Prospects: a child's name and a guardian's contact. Owner and admin only.
  if (kind === "enquiry" && !["OWNER", "ADMIN"].includes(ctx.membership.role))
    return [];
  const { academy, membership, user } = ctx,
    restricted = membership.role === "PARENT" || membership.role === "SUPPORT";
  if (!restricted) {
    return activeFootballRecords(ctx, repository.list(academy.id, kind))
      .filter(
        (r) =>
          !("sportId" in r) ||
          !membership.sportIds.length ||
          membership.sportIds.includes(r.sportId),
      )
      .filter((r) => {
        if (membership.role !== "COACH") return true;
        if (kind === "session")
          return (
            (r as WorkspaceRecords["session"]).coachIds.includes(user.id) &&
            coachCoversPlayers(
              academy.id,
              user.id,
              (r as WorkspaceRecords["session"]).roster.map((p) => p.playerId),
            )
          );
        if (kind === "squad")
          return coachCoversPlayers(
            academy.id,
            user.id,
            (r as WorkspaceRecords["squad"]).playerIds,
          );
        // A recurring series is visible to a coach assigned to it who covers
        // its whole squad, exactly as a single session is.
        if (kind === "series") {
          const series = r as WorkspaceRecords["series"],
            squad = find(academy.id, "squad", series.squadId);
          return (
            series.coachIds.includes(user.id) &&
            !!squad &&
            coachCoversPlayers(academy.id, user.id, squad.playerIds)
          );
        }
        // A wrap-up follows its session: assigned to it and covering its roster.
        if (kind === "wrapup") {
          const session = find(
            academy.id,
            "session",
            (r as WorkspaceRecords["wrapup"]).sessionId,
          );
          return (
            !!session &&
            session.coachIds.includes(user.id) &&
            coachCoversPlayers(
              academy.id,
              user.id,
              session.roster.map((p) => p.playerId),
            )
          );
        }
        if (
          "sessionId" in r &&
          !find(academy.id, "session", r.sessionId)?.coachIds.includes(user.id)
        )
          return false;
        if (kind === "player")
          return (r as WorkspaceRecords["player"]).coachId === user.id;
        if ("playerId" in r) {
          const p = find(academy.id, "player", r.playerId);
          return p?.coachId === user.id;
        }
        return true;
      });
  }
  if (!parentKinds.has(kind)) return [];
  // A player's own login (a child who joined through a player link) never reads what is written for parents and
  // guardians: reports and their PDFs, plans and the practice section built from them, updates, private conversations,
  // dietary notes and fees. This is the one place every list, single-record read and PDF route goes through.
  if (
    membership.role === "PARENT" &&
    PLAYER_LOGIN_HIDDEN_KINDS.has(kind) &&
    // Asked once per read: an academy payload visits every kind, and the statement count of that read is pinned by a test.
    scopedLookup(playerLoginKey(academy.id, user.id), () =>
      isPlayerLinkLogin(academy.id, user.id),
    )
  )
    return [];
  if (
    membership.role === "SUPPORT" &&
    ["preference", "dietary", "conversation", "update"].includes(kind)
  )
    return [];
  let values: unknown[];
  if (kind === "preference")
    values = database()
      .prepare(
        "SELECT body FROM workspace_records WHERE academyId=? AND kind=? AND json_extract(body,'$.userId')=? ORDER BY rowid",
      )
      .all(academy.id, kind, user.id)
      .map((r) => JSON.parse(String(r.body)));
  else if (kind === "plan") {
    const reports = visibleRecords(ctx, "report");
    values = reports
      .map((r) => r.approvedPlan)
      .filter(Boolean)
      .sort((a, b) => (b?.recordVersion ?? 0) - (a?.recordVersion ?? 0))
      .filter((p, i, list) => list.findIndex((q) => q?.id === p?.id) === i);
  } else
    values = database()
      .prepare(
        `SELECT r.body FROM workspace_records r JOIN ${membership.role === "SUPPORT" ? "support_relationships" : "guardian_relationships"} g ON g.academyId=r.academyId AND g.playerId=r.playerId WHERE r.academyId=? AND r.kind=? AND g.userId=? ORDER BY r.rowid`,
      )
      .all(academy.id, kind, user.id)
      .map((r) => JSON.parse(String(r.body)));
  // Exclude preserved historical sports before interpreting report snapshots.
  // Their old schemas need not contain the current football report fields.
  values = activeFootballRecords(ctx, values as WorkspaceRecords[K][]);
  if (kind === "report")
    values = (values as WorkspaceRecords["report"][])
      .filter((r) => r.status === "Approved" && r.snapshot)
      .map((r) => ({
        ...r,
        monthlySources: undefined,
        sourceEvidenceIds: undefined,
        withdrawal: undefined,
        snapshot: parentReportSnapshot(r.snapshot!),
      }));
  if (kind === "weekly")
    values = (values as WorkspaceRecords["weekly"][])
      .filter((r) => r.status === "APPROVED" && r.snapshot && r.issuedAt)
      .map((r) => ({ ...r, content: r.snapshot! }));
  if (kind === "update")
    values = (values as WorkspaceRecords["update"][])
      .filter(
        (r) =>
          r.approvalStatus === "APPROVED" &&
          r.inAppPublicationStatus === "PUBLISHED" &&
          r.publishedGuardianIds?.includes(user.id),
      )
      .map((r) => ({
        ...r,
        approvedSource:
          r.approvedSource && "reportId" in r.approvedSource
            ? parentReportSnapshot(r.approvedSource)
            : r.approvedSource,
      }));
  if (kind === "conversation")
    values = (values as WorkspaceRecords["conversation"][])
      .filter((r) => r.guardianId === user.id)
      .map((r) => ({ ...r, messages: r.messages.filter((m) => !m.internal) }));
  if (kind === "dietary")
    values = (values as WorkspaceRecords["dietary"][]).filter(
      (r) => r.userId === user.id,
    );
  if (membership.role === "SUPPORT")
    audit(academy.id, user.id, "Authorised support read", kind);
  return activeFootballRecords(ctx, values as WorkspaceRecords[K][]);
}
export function visibleRecord<K extends WorkspaceKind>(
  ctx: WorkspaceAccess,
  kind: K,
  id: string,
) {
  const value = visibleRecords(ctx, kind).find((r) => r.id === id);
  if (!value)
    throw new WorkspaceError(
      404,
      "Record not available in this academy and role.",
    );
  return value;
}
export function requirePlayer(ctx: WorkspaceAccess, playerId: string) {
  return visibleRecord(ctx, "player", playerId);
}
/** For every path that CREATES a record about a player: the player must be
 * visible to the caller and must not be archived. Reads and history use
 * `requirePlayer`, so an archived profile stays readable. */
export function requireOpenPlayer(ctx: WorkspaceAccess, playerId: string) {
  const player = requirePlayer(ctx, playerId);
  if (isArchived(player.status))
    throw new WorkspaceError(409, ARCHIVED_MESSAGE);
  return player;
}
/** First check of every state-changing route: the request must come from this
 * application's own origin. It also marks the request as a write, so the first
 * authenticated step applies the per-user write limit. */
export function sameOrigin(request: Request) {
  // The same exact list sign-in trusts (app-origin.ts), so a page that signed in
  // can also save.
  if (!isTrustedOrigin(request.headers.get("origin")))
    throw new WorkspaceError(403, "A same-origin request is required.");
  markWriteRequest(request);
}
// Response helpers live in ./http; re-exported for existing route imports.
export { privateJson, compressibleJson, apiError, readJson } from "./http";
