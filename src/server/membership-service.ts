import "server-only";
import { academyOperational } from "./academy-lifecycle-state";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { workspaceRepository as repo } from "./workspace-repository";
import { database, atomic, audit } from "./database";
import { authenticatedUser, WorkspaceError } from "./auth";
import { isPlayerLinkLogin, requirePlayerLinksEnabled } from "./player-login";
import {
  requireRole,
  requirePlayer,
  type WorkspaceAccess,
} from "./workspace-access";
import { inviteSchema } from "./workspace-schemas";
import { cancelEmails, deliveryStatuses } from "./email/outbox";
import { INVITATION_DAYS, kickOutbox, queueInvitationEmail } from "./email";
import { requireVerifiedEmail } from "./verified-email";
import { COUNTRY_CALLING_CODE, normalizePhone } from "@/services/share-links";
const now = () => new Date().toISOString();
/** The sign-in account table belongs to the authentication service; a bare
 * academy database (some tests) does not have it. */
const hasAccountTable = () =>
  (
    database().prepare('PRAGMA table_info("user")').all() as { name: string }[]
  ).some((column) => column.name === "emailVerified");
export function invite(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const value = inviteSchema.parse(input);
  // Only coaches and parents/guardians are invited by email. A player joins with a player link (player-link-service.ts).
  const storedRole = value.role;
  if (value.role === "COACH" && value.playerIds.length)
    throw new WorkspaceError(
      400,
      "Staff invitations cannot create guardian relationships.",
    );
  if (
    value.role === "PARENT" &&
    (!value.guardianVerified || !value.playerIds.length)
  )
    throw new WorkspaceError(
      400,
      "Explicitly verify the guardian relationship and linked player.",
    );
  value.playerIds.forEach((id) => requirePlayer(ctx, id));
  const token = randomBytes(32).toString("hex"),
    id = randomUUID(),
    expiresAt = new Date(Date.now() + 86400000 * INVITATION_DAYS).toISOString();
  let queued = false;
  // An invitation without its audit record (or the reverse) must not exist, and
  // neither may an invitation whose e-mail was not queued with it.
  atomic(() => {
    database()
      .prepare(
        "INSERT INTO workspace_invitations(id,academyId,email,role,playerIds,tokenHash,expiresAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        ctx.academy.id,
        value.email.toLowerCase(),
        storedRole,
        JSON.stringify(value.playerIds),
        createHash("sha256").update(token).digest("hex"),
        expiresAt,
      );
    queued = queueInvitationEmail({
      to: value.email,
      academyId: ctx.academy.id,
      academyName: ctx.academy.name,
      role: value.role,
      token,
      invitationId: id,
      expiresAt,
    });
    audit(
      ctx.academy.id,
      ctx.user.id,
      queued
        ? "Invitation prepared; email queued for delivery"
        : "Invitation prepared for manual sharing; not sent",
      id,
    );
  });
  if (queued) kickOutbox();
  // The token stays in the response: it is the existing manual-sharing path and
  // the fallback when an email cannot be delivered.
  return { id, token, status: queued ? "QUEUED" : "NOT_SENT" };
}
/**
 * `phone` is the WhatsApp number the person typed on the invitation page, so the academy can reach them without asking
 * again. It is optional and is read in the academy's own country when typed without a country code. It is saved with the
 * membership in one step: a refused invitation, or a number that cannot be read, saves nothing and joins nobody.
 */
export async function acceptInvitation(
  headers: Headers,
  token: string,
  phone?: string,
) {
  return acceptInvitationAs(await authenticatedUser(headers), token, phone);
}
/**
 * The whole acceptance for an account that is already signed in. Synchronous from the first database read to the claim,
 * and exported so a test can run it in several real processes at once against one database file.
 */
export function acceptInvitationAs(
  user: Awaited<ReturnType<typeof authenticatedUser>>,
  token: string,
  phone?: string,
) {
  const hash = createHash("sha256").update(token).digest("hex");
  requireVerifiedEmail(user);
  const invitation = database()
    .prepare(
      "SELECT * FROM workspace_invitations WHERE tokenHash=? AND acceptedAt IS NULL AND expiresAt>?",
    )
    .get(hash, now());
  // A player link is the one kind of invitation that is not tied to an email address: it works once, for whoever holds it.
  const openLink = invitation
    ? (database()
        .prepare("SELECT coachId FROM invitation_open_player WHERE invitationId=?")
        .get(String(invitation.id)) as { coachId: string } | undefined)
    : undefined;
  if (
    !invitation ||
    (!openLink &&
      String(invitation.email).toLowerCase() !== user.email.toLowerCase())
  )
    throw new WorkspaceError(
      403,
      "Invitation is invalid or belongs to a different account.",
    );
  const academyId = String(invitation.academyId);
  // A player link makes a login for a person under 18: it works only while the deployment has switched that on.
  if (openLink) requirePlayerLinksEnabled();
  // Nobody joins an academy that is not open (not yet approved, or suspended).
  if (!academyOperational(academyId))
    throw new WorkspaceError(
      403,
      "This academy is not open yet. Ask the academy to send the invitation again once it is approved.",
      {},
      "ACADEMY_NOT_APPROVED",
    );
  // An active guardian accepting another verified guardian invitation (for
  // example for a sibling) keeps existing links; other roles stay unchanged.
  const addsGuardianLinks = (role?: string) =>
    role === "PARENT" && invitation.role === "PARENT";
  const existing = repo.membership(academyId, user.id);
  // Someone who already belongs to the academy (a coach, a parent, another player) cannot use a player link.
  if (existing && (openLink || !addsGuardianLinks(existing.role)))
    throw new WorkspaceError(
      409,
      "Account already has an active academy membership.",
    );
  // A player's own login is limited to its own player. Letting it collect more guardian links (a sibling, a squad-mate) would
  // widen what it can read while the limits stayed on, so it cannot accept a guardian invitation while it is a player login.
  if (existing && isPlayerLinkLogin(academyId, user.id))
    throw new WorkspaceError(
      409,
      "A player's own login cannot be used to accept a guardian invitation. The guardian should use their own account.",
    );
  let phoneDigits: string | null = null;
  if (phone?.trim()) {
    phoneDigits = normalizePhone(
      phone,
      COUNTRY_CALLING_CODE[repo.academy(academyId)?.country ?? ""] ?? null,
    );
    if (!phoneDigits)
      throw new WorkspaceError(
        400,
        "Enter the number with its country code, for example +91 98765 43210, or leave it empty.",
      );
  }
  atomic(() => {
    const current = repo.membership(academyId, user.id);
    if (
      !!current !== !!existing ||
      (current && !addsGuardianLinks(current.role))
    )
      throw new WorkspaceError(
        409,
        "Academy membership changed. Reopen the invitation and try again.",
      );
    if (!current) {
      database()
        .prepare(
          // A row can exist here only if an earlier membership was revoked or
          // lapsed. The invitation defines the new membership completely, so
          // nothing of the old one (expiry, sport restriction) may survive.
          "INSERT INTO academy_memberships(id,academyId,userId,role,active) VALUES(?,?,?,?,1) ON CONFLICT(academyId,userId) DO UPDATE SET role=excluded.role,active=1,expiresAt=NULL,sportIds='[]'",
        )
        .run(randomUUID(), academyId, user.id, String(invitation.role));
      database()
        .prepare(
          "DELETE FROM guardian_relationships WHERE academyId=? AND userId=?",
        )
        .run(academyId, user.id);
      database()
        .prepare("DELETE FROM player_self_login WHERE academyId=? AND userId=?")
        .run(academyId, user.id);
      database()
        .prepare("DELETE FROM player_self_pending WHERE academyId=? AND userId=?")
        .run(academyId, user.id);
      database()
        .prepare("DELETE FROM player_self_submission WHERE academyId=? AND userId=?")
        .run(academyId, user.id);
      // A new membership defines the account completely: a former player login must not keep its limits as, say, a guardian.
      database()
        .prepare("DELETE FROM player_link_login WHERE academyId=? AND userId=?")
        .run(academyId, user.id);
    }
    if (openLink)
      database()
        .prepare(
          "INSERT INTO player_self_pending(academyId,userId,invitationId,coachId,createdAt) VALUES(?,?,?,?,?)",
        )
        .run(academyId, user.id, String(invitation.id), openLink.coachId, now());
    const ownLogin = !!database()
      .prepare("SELECT 1 FROM invitation_self WHERE invitationId=?")
      .get(String(invitation.id));
    for (const playerId of (invitation.role === "PARENT"
      ? JSON.parse(String(invitation.playerIds))
      : []) as string[])
      database()
        .prepare(
          "INSERT OR IGNORE INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)",
        )
        .run(academyId, user.id, playerId);
    if (ownLogin)
      for (const playerId of JSON.parse(
        String(invitation.playerIds),
      ) as string[])
        database()
          .prepare(
            "INSERT OR IGNORE INTO player_self_login(academyId,userId,playerId) VALUES(?,?,?)",
          )
          .run(academyId, user.id, playerId);
    // One use, enforced where it is claimed: a second claim finds the invitation already taken and undoes everything above.
    const claimed = database()
      .prepare(
        "UPDATE workspace_invitations SET acceptedAt=? WHERE id=? AND acceptedAt IS NULL",
      )
      .run(now(), String(invitation.id));
    if (Number(claimed.changes) !== 1)
      throw new WorkspaceError(409, "This invitation has already been used.");
    if (phoneDigits) {
      database()
        .prepare(
          "INSERT INTO member_phones(academyId,userId,phone,updatedAt,updatedBy) VALUES(?,?,?,?,?) ON CONFLICT(academyId,userId) DO UPDATE SET phone=excluded.phone, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy",
        )
        .run(academyId, user.id, phoneDigits, now(), user.id);
      audit(academyId, user.id, "Phone number saved", user.id);
    }
    audit(
      academyId,
      user.id,
      existing
        ? "Verified guardian invitation added linked players"
        : openLink
          ? "Player invitation link used; the player's details are still to be filled in"
          : "Explicit academy invitation accepted",
      String(invitation.id),
    );
  });
  return { academyId };
}
const handoverInput = z
  .object({
    replacementCoachId: z.string().min(1).max(100).optional(),
    leaveUnassigned: z.boolean().optional(),
  })
  .refine((v) => !(v.replacementCoachId && v.leaveUnassigned), {
    message:
      "Choose a replacement coach or leave the work unassigned, not both.",
  });
/** What still points at a coach: their players, their future sessions that
 * have not started, and their active weekly series. Sessions already held keep
 * their coach, and a session in progress is left alone. */
export function coachAssignments(academyId: string, coachUserId: string) {
  const at = now();
  return {
    players: repo
      .list(academyId, "player")
      .filter((p) => p.coachId === coachUserId),
    sessions: repo.list(academyId, "session").filter(
      (s) =>
        // A draft may have no date yet; a scheduled session must still be ahead.
        (s.status === "DRAFT" ||
          (s.status === "SCHEDULED" && s.startAt > at)) &&
        s.coachIds.includes(coachUserId),
    ),
    series: repo
      .list(academyId, "series")
      .filter((s) => s.status === "ACTIVE" && s.coachIds.includes(coachUserId)),
  };
}
/**
 * Revokes an academy membership. Revoking a coach who still has players,
 * future sessions or weekly series needs a decision (P1-04): either a
 * replacement coach, who takes all of it over in the same transaction, or an
 * explicit "leave unassigned". Nothing is reassigned silently, past sessions
 * keep their coach, and the move is audited. Revocation of other roles is
 * unchanged; who may revoke whom is not changed here.
 */
export function revokeMembership(
  ctx: WorkspaceAccess,
  id: string,
  input?: unknown,
) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const membership = database()
    .prepare("SELECT * FROM academy_memberships WHERE academyId=? AND id=?")
    .get(ctx.academy.id, id);
  if (!membership) throw new WorkspaceError(404, "Membership not found.");
  if (membership.role === "OWNER")
    throw new WorkspaceError(
      403,
      "Owner transfer is required before revocation.",
    );
  return atomic(() => {
    const coachUserId = String(membership.userId);
    let moved = { players: 0, sessions: 0, series: 0 };
    let replacementCoachId: string | undefined;
    if (membership.role === "COACH" && membership.active) {
      const work = coachAssignments(ctx.academy.id, coachUserId),
        total = work.players.length + work.sessions.length + work.series.length;
      if (total > 0) {
        const choice = handoverInput.safeParse(input ?? {});
        if (!choice.success)
          throw new WorkspaceError(400, choice.error.issues[0].message);
        const { replacementCoachId: replacement, leaveUnassigned } =
          choice.data;
        if (!replacement && !leaveUnassigned)
          throw new WorkspaceError(
            409,
            `This coach still looks after ${work.players.length} player${work.players.length === 1 ? "" : "s"}, ${work.sessions.length} upcoming session${work.sessions.length === 1 ? "" : "s"} and ${work.series.length} weekly series. Choose a replacement coach, or confirm that this work stays unassigned.`,
          );
        if (replacement) {
          const target = repo.membership(ctx.academy.id, replacement);
          if (
            !target ||
            replacement === coachUserId ||
            !["OWNER", "ADMIN", "COACH"].includes(target.role) ||
            (target.sportIds.length && !target.sportIds.includes("football"))
          )
            throw new WorkspaceError(
              400,
              "Choose another active football staff member of this academy as the replacement.",
            );
          const swap = (ids: string[]) => [
            ...new Set(ids.map((x) => (x === coachUserId ? replacement : x))),
          ];
          const at = now();
          for (const player of work.players)
            repo.save(ctx.academy.id, "player", {
              ...player,
              recordVersion: undefined,
              coachId: replacement,
            });
          for (const [kind, rows] of [
            ["session", work.sessions],
            ["series", work.series],
          ] as const)
            for (const row of rows) {
              const next = {
                ...row,
                coachIds: swap(row.coachIds),
                version: row.version + 1,
                updatedAt: at,
                updatedBy: ctx.user.id,
              };
              repo.save(ctx.academy.id, kind, next as never);
              database()
                .prepare(
                  "INSERT INTO training_history(academyId,kind,recordId,version,body,actorId,at) VALUES(?,?,?,?,?,?,?)",
                )
                .run(
                  ctx.academy.id,
                  kind,
                  row.id,
                  next.version,
                  JSON.stringify(next),
                  ctx.user.id,
                  at,
                );
            }
          moved = {
            players: work.players.length,
            sessions: work.sessions.length,
            series: work.series.length,
          };
          replacementCoachId = replacement;
        }
        audit(
          ctx.academy.id,
          ctx.user.id,
          replacement
            ? `Coach hand-over: ${moved.players} players, ${moved.sessions} sessions, ${moved.series} series moved to ${replacement}`
            : `Coach hand-over: ${work.players.length} players, ${work.sessions.length} sessions, ${work.series.length} series explicitly left unassigned`,
          id,
        );
      }
    }
    database()
      .prepare(
        "UPDATE academy_memberships SET active=0 WHERE academyId=? AND id=?",
      )
      .run(ctx.academy.id, id);
    audit(ctx.academy.id, ctx.user.id, "Membership revoked", id);
    return { ok: true as const, handover: { ...moved, replacementCoachId } };
  });
}

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  /** 1 when the invitation is for the player themselves. */
  self: number;
  /** 1 for a player link: not tied to an email address, works once. */
  open: number;
  playerIds: string;
  expiresAt: string;
  acceptedAt: string | null;
};
/** What the academy sees for an invitation: a player's own login is "PLAYER". */
const shownRole = (row: { role: string; self: number; open: number }) =>
  row.self || row.open ? "PLAYER" : row.role;


/** Pending and recent invitations with their delivery state. Never returns tokens. */
export function listInvitations(ctx: WorkspaceAccess) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const rows = database()
    .prepare(
      "SELECT id,email,role,(SELECT COUNT(*) FROM invitation_self x WHERE x.invitationId=workspace_invitations.id) AS self,(SELECT COUNT(*) FROM invitation_open_player o WHERE o.invitationId=workspace_invitations.id) AS open,playerIds,expiresAt,acceptedAt FROM workspace_invitations WHERE academyId=? ORDER BY expiresAt DESC LIMIT 100",
    )
    .all(ctx.academy.id) as InvitationRow[];
  const delivery = deliveryStatuses(rows.map((row) => row.id));
  return {
    invitations: rows.map((row) => ({
      id: row.id,
      email: row.open ? "" : row.email,
      open: Boolean(row.open),
      role: shownRole(row),
      players: (JSON.parse(row.playerIds) as string[])
        .map((playerId) => repo.find(ctx.academy.id, "player", playerId)?.name)
        .filter((name): name is string => !!name),
      expiresAt: row.expiresAt,
      state: row.acceptedAt
        ? "ACCEPTED"
        : row.expiresAt <= now()
          ? "EXPIRED"
          : "PENDING",
      delivery: delivery.get(row.id) ?? "NOT_SENT",
    })),
  };
}
function pendingInvitation(ctx: WorkspaceAccess, id: string) {
  const row = database()
    .prepare(
      "SELECT id,email,role,(SELECT COUNT(*) FROM invitation_self x WHERE x.invitationId=workspace_invitations.id) AS self,(SELECT COUNT(*) FROM invitation_open_player o WHERE o.invitationId=workspace_invitations.id) AS open,playerIds,expiresAt,acceptedAt FROM workspace_invitations WHERE academyId=? AND id=?",
    )
    .get(ctx.academy.id, id) as InvitationRow | undefined;
  if (!row) throw new WorkspaceError(404, "Invitation not found.");
  if (row.acceptedAt)
    throw new WorkspaceError(409, "This invitation was already accepted.");
  return row;
}
/**
 * Replaces the invitation's token and expiry and queues a new message. The old
 * token and any unsent message stop working at once.
 */
export function resendInvitation(ctx: WorkspaceAccess, id: string) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  const row = pendingInvitation(ctx, id);
  const token = randomBytes(32).toString("hex"),
    expiresAt = new Date(Date.now() + 86400000 * INVITATION_DAYS).toISOString();
  let queued = false;
  atomic(() => {
    database()
      .prepare(
        "UPDATE workspace_invitations SET tokenHash=?, expiresAt=? WHERE id=? AND acceptedAt IS NULL",
      )
      .run(createHash("sha256").update(token).digest("hex"), expiresAt, id);
    cancelEmails(id);
    // A player link has no address to send to: the owner shares the new link by hand.
    queued = row.open
      ? false
      : queueInvitationEmail({
          to: row.email,
          academyId: ctx.academy.id,
          academyName: ctx.academy.name,
          role: shownRole(row),
          token,
          invitationId: id,
          expiresAt,
        });
    audit(
      ctx.academy.id,
      ctx.user.id,
      queued
        ? "Invitation renewed; email queued for delivery"
        : "Invitation renewed for manual sharing; not sent",
      id,
    );
  });
  if (queued) kickOutbox();
  return { id, token, status: queued ? "QUEUED" : "NOT_SENT" };
}
/** Ends a pending invitation: its token stops working and unsent mail is withdrawn. */
export function revokeInvitation(ctx: WorkspaceAccess, id: string) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  pendingInvitation(ctx, id);
  atomic(() => {
    database()
      .prepare(
        "UPDATE workspace_invitations SET expiresAt=? WHERE id=? AND acceptedAt IS NULL",
      )
      .run(now(), id);
    cancelEmails(id);
    audit(ctx.academy.id, ctx.user.id, "Invitation revoked", id);
  });
  return { id, state: "EXPIRED" };
}

const looksLikeToken = (token: string) => /^[0-9a-f]{64}$/.test(token);
const invitationByToken = (token: string) =>
  looksLikeToken(token)
    ? (database()
        .prepare(
          "SELECT *,(SELECT COUNT(*) FROM invitation_self x WHERE x.invitationId=workspace_invitations.id) AS self,(SELECT COUNT(*) FROM invitation_open_player o WHERE o.invitationId=workspace_invitations.id) AS open FROM workspace_invitations WHERE tokenHash=?",
        )
        .get(createHash("sha256").update(token).digest("hex")) as
        (InvitationRow & { academyId: string }) | undefined)
    : undefined;

export type InvitationPreview =
  | { state: "INVALID" | "USED" | "EXPIRED" | "ACADEMY_NOT_OPEN" }
  | {
      state: "OPEN";
      academyId: string;
      academyName: string;
      role: string;
      /** Empty for a player link: it is not tied to an address. */
      email: string;
      /** A player link: whoever holds it can use it once, and then fills in their own details. */
      open: boolean;
      playerNames: string[];
      /** An account for this address exists, so the person signs in instead of creating one. */
      accountExists: boolean;
    };
/**
 * What the invitation link says, for the page the link opens. It needs no
 * sign-in (the person has no account yet) and holds the single-use secret in
 * its address; it reveals only the academy, the role, the invited address and
 * the linked players' names, and only for a link that is still usable.
 */
export function previewInvitation(token: string): InvitationPreview {
  const row = invitationByToken(token);
  if (!row) return { state: "INVALID" };
  if (row.acceptedAt) return { state: "USED" };
  if (row.expiresAt <= now()) return { state: "EXPIRED" };
  if (!academyOperational(row.academyId)) return { state: "ACADEMY_NOT_OPEN" };
  const stored = database()
    .prepare("SELECT config FROM academy_workspaces WHERE id=?")
    .get(row.academyId) as { config: string } | undefined;
  const academy = stored
    ? (JSON.parse(stored.config) as { name?: string })
    : undefined;
  if (!academy?.name) return { state: "INVALID" };
  return {
    state: "OPEN",
    academyId: row.academyId,
    academyName: academy.name,
    role: shownRole(row),
    email: row.open ? "" : row.email,
    open: Boolean(row.open),
    playerNames: (JSON.parse(row.playerIds) as string[])
      .map((playerId) => repo.find(row.academyId, "player", playerId)?.name)
      .filter((name): name is string => !!name),
    accountExists:
      !row.open &&
      hasAccountTable() &&
      !!database()
        .prepare('SELECT 1 FROM "user" WHERE lower(email)=?')
        .get(row.email.toLowerCase()),
  };
}
/**
 * Opening the link is the proof that the person owns the invited address (it
 * was sent to that address and works once), so an account for that address that
 * is still waiting for its confirmation e-mail is confirmed now. Without this a
 * person would need a second e-mail before they could use the first.
 */
export function confirmInvitationEmail(token: string) {
  const preview = previewInvitation(token);
  // A player link proves nothing about any address, so it never confirms one.
  if (preview.state !== "OPEN" || preview.open || !hasAccountTable())
    return { confirmed: false };
  const user = database()
    .prepare('SELECT id,emailVerified FROM "user" WHERE lower(email)=?')
    .get(preview.email.toLowerCase()) as
    { id: string; emailVerified: number | null } | undefined;
  if (!user || user.emailVerified) return { confirmed: false };
  database()
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .run(user.id);
  audit(
    preview.academyId,
    user.id,
    "Email address confirmed by opening the invitation link",
  );
  return { confirmed: true };
}
