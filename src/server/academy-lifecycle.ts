import "server-only";
import { z } from "zod";
import { WorkspaceError } from "./auth";
import { atomic, audit, database } from "./database";
import { log } from "./log";
import { workspaceRepository as repo } from "./workspace-repository";
import { requireRole, type WorkspaceAccess } from "./workspace-access";
import { lifecycleOf, type Lifecycle } from "./academy-lifecycle-state";
import {
  queueAcademyDecisionNotice,
  queueAcademySubmittedNotice,
} from "./email";
import {
  historyAction,
  LIFECYCLE_LABEL,
  LIFECYCLE_OWNER_TEXT,
  nextState,
  REASON_MAX,
  REASON_MIN,
  TRANSITIONS,
  type ChecklistItem,
  type HistoryAction,
  type LifecycleAction,
  type LifecycleActor,
  type LifecycleState,
} from "@/domain/academy-lifecycle";
import type { AcademyConfiguration } from "@/domain/workspace";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- checklist
/**
 * What the owner sees as onboarding progress and what blocks submission. The
 * REQUIRED items are the ones the academy form already makes mandatory (so a
 * normally created academy always satisfies them) plus "at least one module".
 * Which of the optional items must become required before approval is a
 * business decision that has not been taken: to change it, flip `required`
 * here; nothing else needs to change.
 */
export function onboardingChecklist(
  academy: AcademyConfiguration,
): ChecklistItem[] {
  const has = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  return [
    {
      id: "name",
      label: "Academy name",
      done: has(academy.name) && academy.name.trim().length >= 2,
      required: true,
    },
    {
      id: "contactEmail",
      label: "Contact email",
      done: has(academy.contactEmail),
      required: true,
    },
    {
      id: "region",
      label: "Country, currency and time zone",
      done:
        has(academy.country) && has(academy.currency) && has(academy.timezone),
      required: true,
    },
    {
      id: "modules",
      label: "At least one module chosen",
      done: Array.isArray(academy.modules) && academy.modules.length > 0,
      required: true,
    },
    {
      id: "location",
      label: "Location",
      done: has(academy.location),
      required: false,
    },
    {
      id: "phone",
      label: "Contact phone",
      done: has(academy.phone),
      required: false,
    },
    {
      id: "about",
      label: "Short description",
      done: has(academy.about),
      required: false,
    },
    {
      id: "logo",
      label: "Logo",
      done: has(academy.logoData),
      required: false,
    },
    {
      id: "website",
      label: "Website",
      done: has(academy.website),
      required: false,
    },
  ];
}

// -------------------------------------------------------------- bookkeeping
interface HistoryRow {
  academyId: string;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  action: HistoryAction;
  actorId: string;
  actorKind: "OWNER" | "PLATFORM" | "SYSTEM";
  reason?: string | null;
  configVersion?: number | null;
}
function writeHistory(row: HistoryRow) {
  database()
    .prepare(
      "INSERT INTO academy_lifecycle_history(academyId,fromState,toState,action,actorId,actorKind,reason,configVersion,at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      row.academyId,
      row.fromState,
      row.toState,
      row.action,
      row.actorId,
      row.actorKind,
      row.reason ?? null,
      row.configVersion ?? null,
      nowIso(),
    );
}

/**
 * How a new academy gets approved on this deployment. "direct" (the default) approves
 * it when it is created, like a product with no review step. "required" (only when
 * SPORTOZEN_ACADEMY_APPROVAL=required is set) sends it through the platform
 * administrator's review. Only the operator sets this, through the server's
 * environment; nothing a user sends can change it, and the whole review workflow
 * stays in place for "required".
 */
export function academyApprovalMode(): "required" | "direct" {
  // Owner decision (23 Nov 2026): a new academy opens straight away. The platform review stays in the code and is switched
  // on only by setting SPORTOZEN_ACADEMY_APPROVAL=required.
  return process.env.SPORTOZEN_ACADEMY_APPROVAL?.trim().toLowerCase() ===
    "required"
    ? "required"
    : "direct";
}

/** Called by createAcademy inside its transaction: every new academy starts in
 * CONFIGURING, and in "direct" mode is approved in the same transaction.
 * Nothing outside this module can make it start anywhere else. */
export function registerAcademyLifecycle(
  academyId: string,
  ownerId: string,
  configVersion: number,
) {
  const at = nowIso();
  const direct = academyApprovalMode() === "direct";
  database()
    .prepare(
      "INSERT INTO academy_lifecycle(academyId,state,version,submissions,updatedAt) VALUES(?,?,1,0,?)",
    )
    .run(academyId, direct ? "ACTIVE" : "CONFIGURING", at);
  writeHistory({
    academyId,
    fromState: null,
    toState: "CONFIGURING",
    action: "REGISTERED",
    actorId: ownerId,
    actorKind: "OWNER",
    configVersion,
  });
  if (direct)
    writeHistory({
      academyId,
      fromState: "CONFIGURING",
      toState: "ACTIVE",
      action: "APPROVED",
      actorId: ownerId,
      actorKind: "SYSTEM",
      reason:
        "Approved automatically: this deployment does not require a platform review.",
      configVersion,
    });
}

/**
 * Called by updateAcademy inside its transaction. While an application is
 * waiting for or under review, an edit changes what the reviewer is looking
 * at, so it advances the lifecycle version: a decision made on the earlier
 * version is refused and the reviewer must look again. (Editing is not
 * blocked: the owner is never locked out of their own profile.)
 */
export function touchLifecycleForEdit(academyId: string) {
  database()
    .prepare(
      "UPDATE academy_lifecycle SET version=version+1, updatedAt=? WHERE academyId=? AND state IN ('SUBMITTED','PENDING_REVIEW')",
    )
    .run(nowIso(), academyId);
}

// ---------------------------------------------------------------- the core
interface Move {
  academyId: string;
  action: LifecycleAction;
  actorId: string;
  actorKind: LifecycleActor;
  expectedVersion: number;
  reason?: string;
}
/**
 * The single place a state changes. One transaction: the version and state
 * guards, the new state, the entitlement that follows a suspension, the
 * history row and the academy's own audit entry stand or fall together. The
 * conditional UPDATE is the concurrency control: two requests that read the
 * same version cannot both change one row.
 */
function move(m: Move): { from: LifecycleState; to: LifecycleState } {
  const rule = TRANSITIONS[m.action];
  if (rule.actor !== m.actorKind)
    throw new WorkspaceError(403, "That action belongs to a different role.");
  const reason = (m.reason ?? "").trim();
  if (rule.reasonRequired && reason.length < REASON_MIN)
    throw new WorkspaceError(
      400,
      `A written reason of at least ${REASON_MIN} characters is required.`,
    );
  if (reason.length > REASON_MAX)
    throw new WorkspaceError(
      400,
      `The reason can be at most ${REASON_MAX} characters.`,
    );
  return atomic(() => {
    const current = lifecycleOf(m.academyId);
    if (!current) throw new WorkspaceError(404, "Academy not found.");
    if (current.version !== m.expectedVersion)
      throw new WorkspaceError(
        409,
        "This application changed since you opened it. Reload it and review the current state.",
        {},
        "STALE_VERSION",
      );
    const to = nextState(current.state, m.action);
    if (!to)
      throw new WorkspaceError(
        409,
        `That action is not available while the academy is "${LIFECYCLE_LABEL[current.state]}".`,
        {},
        "INVALID_TRANSITION",
      );
    const at = nowIso();
    const decision = m.actorKind === "PLATFORM";
    const result = database()
      .prepare(
        `UPDATE academy_lifecycle SET
           state=?, version=version+1, updatedAt=?,
           submissions=submissions+?,
           submittedAt=CASE WHEN ?=1 THEN ? ELSE submittedAt END,
           reviewerId=CASE WHEN ?='startReview' THEN ? ELSE reviewerId END,
           reviewStartedAt=CASE WHEN ?='startReview' THEN ? ELSE reviewStartedAt END,
           decidedAt=CASE WHEN ?=1 AND ?<>'startReview' THEN ? ELSE decidedAt END,
           decidedBy=CASE WHEN ?=1 AND ?<>'startReview' THEN ? ELSE decidedBy END,
           reason=CASE WHEN ?=1 AND ?<>'startReview' THEN ? ELSE reason END
         WHERE academyId=? AND version=? AND state=?`,
      )
      .run(
        to,
        at,
        m.action === "submit" ? 1 : 0,
        m.action === "submit" ? 1 : 0,
        at,
        m.action,
        m.actorId,
        m.action,
        at,
        decision ? 1 : 0,
        m.action,
        at,
        decision ? 1 : 0,
        m.action,
        m.actorId,
        decision ? 1 : 0,
        m.action,
        reason || null,
        m.academyId,
        m.expectedVersion,
        current.state,
      );
    if (result.changes !== 1)
      throw new WorkspaceError(
        409,
        "This application changed since you opened it. Reload it and review the current state.",
        {},
        "STALE_VERSION",
      );
    // A suspension closes the academy through the one switch every request
    // already honours; reactivation opens it again. Approval changes nothing
    // else: the entitlement of a new academy is already ACTIVE.
    if (m.action === "suspend" || m.action === "reactivate")
      database()
        .prepare("UPDATE platform_entitlements SET status=? WHERE academyId=?")
        .run(m.action === "suspend" ? "PAUSED" : "ACTIVE", m.academyId);
    const configVersion = repo.academy(m.academyId)?.configVersion ?? 0;
    writeHistory({
      academyId: m.academyId,
      fromState: current.state,
      toState: to,
      action: historyAction(m.action, current.state),
      actorId: m.actorId,
      actorKind: m.actorKind,
      reason: reason || null,
      configVersion,
    });
    audit(
      m.academyId,
      m.actorId,
      `Academy approval: ${historyAction(m.action, current.state)}`,
      m.academyId,
    );
    return { from: current.state, to };
  });
}

// --------------------------------------------------------- notifications
function ownerRecipients(academyId: string) {
  return database()
    .prepare(
      `SELECT u.email,u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId
       WHERE m.academyId=? AND m.role='OWNER' AND m.active=1`,
    )
    .all(academyId) as { email: string; name: string }[];
}
function platformRecipients() {
  return database()
    .prepare(
      `SELECT u.email,u.name FROM platform_administrators p JOIN "user" u ON u.id=p.userId`,
    )
    .all() as { email: string; name: string }[];
}
/** The in-app status is the source of truth; mail is best effort and never
 * undoes or delays a decision. Nothing is sent while e-mail is disabled. */
function notify(fn: () => void) {
  try {
    fn();
  } catch (error) {
    log("warn", "lifecycle.notice_failed", {
      note: "decision recorded; notice not queued",
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// -------------------------------------------------------- owner: the view
const submitInput = z.object({
  action: z.literal("submit"),
  expectedVersion: z.number().int().positive(),
});

export function lifecycleView(ctx: WorkspaceAccess) {
  const life = lifecycleOf(ctx.academy.id);
  if (!life) throw new WorkspaceError(404, "Academy not found.");
  const manager = ["OWNER", "ADMIN"].includes(ctx.membership.role);
  const checklist = onboardingChecklist(ctx.academy);
  const base = {
    state: life.state,
    label: LIFECYCLE_LABEL[life.state],
    text: LIFECYCLE_OWNER_TEXT[life.state],
    version: life.version,
  };
  // Parents and coaches learn only whether the academy is open.
  if (!manager) return base;
  const missing = checklist.filter((c) => c.required && !c.done);
  return {
    ...base,
    submissions: life.submissions,
    submittedAt: life.submittedAt,
    decidedAt: life.decidedAt,
    // Feedback from the reviewer (a rejection reason, or a note with an
    // approval). Reviewers are not named to the academy.
    feedback: life.reason,
    checklist,
    progress: {
      done: checklist.filter((c) => c.done).length,
      total: checklist.length,
    },
    canSubmit:
      ctx.membership.role === "OWNER" &&
      (life.state === "CONFIGURING" || life.state === "REJECTED") &&
      missing.length === 0,
    canEdit: [
      "CONFIGURING",
      "SUBMITTED",
      "PENDING_REVIEW",
      "REJECTED",
    ].includes(life.state),
    history: (
      database()
        .prepare(
          "SELECT action,toState,reason,at FROM academy_lifecycle_history WHERE academyId=? ORDER BY id DESC LIMIT 50",
        )
        .all(ctx.academy.id) as {
        action: string;
        toState: string;
        reason: string | null;
        at: string;
      }[]
    ).map((h) => ({
      action: h.action,
      state: h.toState,
      reason: h.reason,
      at: h.at,
    })),
  };
}

export function submitForApproval(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER"]);
  const value = submitInput.parse(input);
  const checklist = onboardingChecklist(ctx.academy),
    missing = checklist.filter((c) => c.required && !c.done);
  if (missing.length)
    throw new WorkspaceError(
      409,
      `Complete these before submitting: ${missing.map((c) => c.label).join(", ")}.`,
      {},
      "INCOMPLETE",
    );
  const result = move({
    academyId: ctx.academy.id,
    action: "submit",
    actorId: ctx.user.id,
    actorKind: "OWNER",
    expectedVersion: value.expectedVersion,
  });
  notify(() => {
    for (const admin of platformRecipients())
      queueAcademySubmittedNotice(admin.email, {
        name: admin.name,
        academyName: ctx.academy.name,
        resubmission: result.from === "REJECTED",
        academyId: ctx.academy.id,
      });
  });
  return lifecycleView(ctx);
}

// --------------------------------------------------- platform administrators
const decisionInput = z.object({
  decision: z.enum([
    "startReview",
    "approve",
    "reject",
    "suspend",
    "reactivate",
  ]),
  reason: z
    .string()
    .max(REASON_MAX + 200)
    .optional(),
  expectedVersion: z.number().int().positive(),
});
const listQuery = z.object({
  state: z
    .enum([
      "CONFIGURING",
      "SUBMITTED",
      "PENDING_REVIEW",
      "REJECTED",
      "ACTIVE",
      "SUSPENDED",
    ])
    .optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const STATE_ORDER = `CASE l.state WHEN 'SUBMITTED' THEN 0 WHEN 'PENDING_REVIEW' THEN 1 WHEN 'REJECTED' THEN 2 WHEN 'CONFIGURING' THEN 3 WHEN 'SUSPENDED' THEN 4 ELSE 5 END`;

function academyName(id: string) {
  return repo.academy(id)?.name ?? "";
}

/** The review queue: applications waiting for a decision first, oldest first. */
export function applicationList(params: URLSearchParams) {
  const q = listQuery.parse({
    state: params.get("state") ?? undefined,
    q: params.get("q") ?? undefined,
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
  const where: string[] = [],
    args: (string | number)[] = [];
  if (q.state) {
    where.push("l.state=?");
    args.push(q.state);
  }
  if (q.q) {
    where.push("lower(json_extract(a.config,'$.name')) LIKE ? ESCAPE '\\'");
    args.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
  }
  const rows = database()
    .prepare(
      `SELECT l.*, a.config, e.tier, e.status AS entitlement,
              (SELECT u.name FROM "user" u WHERE u.id=l.reviewerId) AS reviewerName,
              (SELECT u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId
                 WHERE m.academyId=l.academyId AND m.role='OWNER' AND m.active=1 ORDER BY m.rowid LIMIT 1) AS ownerName,
              EXISTS(SELECT 1 FROM academy_lifecycle_history h WHERE h.academyId=l.academyId AND h.action='MIGRATED') AS carriedOver
       FROM academy_lifecycle l
       JOIN academy_workspaces a ON a.id=l.academyId
       LEFT JOIN platform_entitlements e ON e.academyId=l.academyId
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${STATE_ORDER}, COALESCE(l.submittedAt,l.updatedAt), l.academyId
       LIMIT ? OFFSET ?`,
    )
    .all(...args, q.limit + 1, q.offset);
  const page = rows.slice(0, q.limit).map((r) => {
    const config = JSON.parse(String(r.config)) as AcademyConfiguration;
    return {
      id: String(r.academyId),
      name: config.name,
      country: config.country,
      state: r.state as LifecycleState,
      label: LIFECYCLE_LABEL[r.state as LifecycleState],
      version: Number(r.version),
      submissions: Number(r.submissions),
      resubmitted: Number(r.submissions) > 1,
      submittedAt: (r.submittedAt as string | null) ?? null,
      reviewerName: (r.reviewerName as string | null) ?? null,
      decidedAt: (r.decidedAt as string | null) ?? null,
      ownerName: (r.ownerName as string | null) ?? null,
      tier: r.tier ? String(r.tier) : null,
      entitlement: r.entitlement ? String(r.entitlement) : null,
      carriedOver: Boolean(r.carriedOver),
    };
  });
  const waiting = Number(
    database()
      .prepare(
        "SELECT COUNT(*) n FROM academy_lifecycle WHERE state IN ('SUBMITTED','PENDING_REVIEW')",
      )
      .get()?.n,
  );
  return {
    applications: page,
    waiting,
    nextOffset: rows.length > q.limit ? q.offset + q.limit : null,
  };
}

/** Everything a reviewer needs and nothing about children: the profile the
 * owner submitted, who the owner is, and the full decision history. */
export function applicationDetail(academyId: string) {
  const life = lifecycleOf(academyId),
    academy = repo.academy(academyId);
  if (!life || !academy) throw new WorkspaceError(404, "Academy not found.");
  const history = database()
    .prepare(
      `SELECT h.id,h.fromState,h.toState,h.action,h.actorKind,h.reason,h.configVersion,h.at,
              CASE WHEN h.actorKind='SYSTEM' THEN h.actorId ELSE u.name END AS actorName
       FROM academy_lifecycle_history h LEFT JOIN "user" u ON u.id=h.actorId
       WHERE h.academyId=? ORDER BY h.id DESC`,
    )
    .all(academyId);
  const owners = database()
    .prepare(
      `SELECT u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId
       WHERE m.academyId=? AND m.role='OWNER' AND m.active=1 ORDER BY m.rowid`,
    )
    .all(academyId)
    .map((r) => String(r.name));
  const reviewer = life.reviewerId
    ? database()
        .prepare(`SELECT name FROM "user" WHERE id=?`)
        .get(life.reviewerId)
    : undefined;
  const entitlement = database()
    .prepare(
      "SELECT tier,status,modules FROM platform_entitlements WHERE academyId=?",
    )
    .get(academyId);
  const checklist = onboardingChecklist(academy);
  return {
    id: academyId,
    state: life.state,
    label: LIFECYCLE_LABEL[life.state],
    version: life.version,
    submissions: life.submissions,
    resubmitted: life.submissions > 1,
    submittedAt: life.submittedAt,
    reviewStartedAt: life.reviewStartedAt,
    reviewerName: reviewer ? String(reviewer.name) : null,
    decidedAt: life.decidedAt,
    feedback: life.reason,
    owners,
    profile: {
      name: academy.name,
      contactEmail: academy.contactEmail,
      country: academy.country,
      location: academy.location ?? "",
      phone: academy.phone ?? "",
      website: academy.website ?? "",
      about: academy.about ?? "",
      language: academy.language,
      currency: academy.currency,
      timezone: academy.timezone,
      modules: academy.modules,
      hasLogo: Boolean(academy.logoData),
      configVersion: academy.configVersion ?? 0,
      demo: Boolean(academy.demo),
    },
    subscription: entitlement
      ? {
          tier: String(entitlement.tier),
          status: String(entitlement.status),
          modules: JSON.parse(String(entitlement.modules)) as string[],
        }
      : null,
    checklist,
    carriedOver: history.some((h) => h.action === "MIGRATED"),
    allowed: (Object.keys(TRANSITIONS) as LifecycleAction[]).filter(
      (a) => TRANSITIONS[a].actor === "PLATFORM" && nextState(life.state, a),
    ),
    history: history.map((h) => ({
      id: Number(h.id),
      from: (h.fromState as string | null) ?? null,
      to: String(h.toState),
      action: String(h.action),
      actorKind: String(h.actorKind),
      actorName: h.actorName ? String(h.actorName) : null,
      reason: (h.reason as string | null) ?? null,
      configVersion:
        h.configVersion === null || h.configVersion === undefined
          ? null
          : Number(h.configVersion),
      at: String(h.at),
    })),
  };
}

/**
 * A platform administrator's decision. The caller has already authenticated
 * the administrator (platform-service.platformAccess); this adds the rules
 * that are about the academy:
 *  - an administrator cannot decide an academy they belong to (separation of
 *    duties; a temporary support grant is not a membership for this purpose);
 *  - the transition table, the mandatory reason and the version guard (move()).
 */
export function decideApplication(
  adminId: string,
  academyId: string,
  input: unknown,
) {
  const value = decisionInput.parse(input);
  if (!lifecycleOf(academyId))
    throw new WorkspaceError(404, "Academy not found.");
  const conflicted = database()
    .prepare(
      "SELECT 1 FROM academy_memberships WHERE academyId=? AND userId=? AND active=1 AND role<>'SUPPORT'",
    )
    .get(academyId, adminId);
  if (conflicted)
    throw new WorkspaceError(
      403,
      "A platform administrator cannot decide on an academy they belong to. Ask another administrator.",
      {},
      "CONFLICT_OF_INTEREST",
    );
  const result = move({
    academyId,
    action: value.decision,
    actorId: adminId,
    actorKind: "PLATFORM",
    expectedVersion: value.expectedVersion,
    reason: value.reason,
  });
  const reason = (value.reason ?? "").trim();
  if (
    value.decision === "approve" ||
    value.decision === "reject" ||
    value.decision === "suspend" ||
    value.decision === "reactivate"
  )
    notify(() => {
      const outcome = (
        {
          approve: "approved",
          reject: "rejected",
          suspend: "suspended",
          reactivate: "reactivated",
        } as const
      )[value.decision as "approve" | "reject" | "suspend" | "reactivate"];
      for (const owner of ownerRecipients(academyId))
        queueAcademyDecisionNotice(owner.email, {
          name: owner.name,
          academyName: academyName(academyId),
          outcome,
          reason: reason || undefined,
          academyId,
        });
    });
  return { ...result, application: applicationDetail(academyId) };
}

export type { Lifecycle };
