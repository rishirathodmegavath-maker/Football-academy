import "server-only";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { database, atomic, audit } from "./database";
import { WorkspaceError } from "./auth";
import {
  requireRole,
  requireSport,
  scopedLookup,
  type WorkspaceAccess,
} from "./workspace-access";
import { workspaceRepository as repo } from "./workspace-repository";
import { requireUnder18 } from "./player-age-service";
import { academyToday } from "./drill-library-service";
import { INVITATION_DAYS } from "./email";
import type { WorkspacePlayer } from "@/domain/workspace";
import {
  isPlayerLinkLogin,
  playerLinksEnabled,
  playerLoginKey,
  requirePlayerLinksEnabled,
} from "./player-login";

/**
 * "Add player with invitation link".
 *
 * The owner makes ONE link for a player who has no record yet. The link is not tied to an email address: whoever holds it can
 * use it, once, within INVITATION_DAYS. Using it signs the person in as a member of the academy with no player attached. They
 * then fill in their own name and date of birth, which WAIT for the owner or an admin. When the owner confirms them, and
 * records that a parent or guardian has agreed, the player record exists, linked to that account (the same guardian-scoped link
 * a parent has, plus the "own login" mark of migration 015). Until then the account sees no player at all.
 *
 * What the person can and cannot set: name, date of birth and position. The staff member who looks after them comes from the
 * link, the status is always Active, the batch is left for the owner to assign, and the under-18 rule is the same one every
 * other way of adding a player uses (requireUnder18).
 */
const STAFF = ["OWNER", "ADMIN", "COACH"];
const linkSchema = z.object({
  coachId: z.string().min(1).max(100).optional(),
});
const detailsSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(200),
  birthDate: z.string().trim().max(10),
  position: z.string().trim().max(200).default(""),
  guardianAware: z.literal(true, {
    error: "Confirm that a parent or guardian knows you are joining.",
  }),
});

/** Owner or admin: a new single-use link. Nothing is sent; the owner shares it. The token is returned once and only its hash is kept. */
export function createPlayerLink(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  requireSport(ctx, "football");
  requirePlayerLinksEnabled();
  const { coachId = ctx.user.id } = linkSchema.parse(input ?? {});
  const staff = repo.membership(ctx.academy.id, coachId);
  if (
    !staff ||
    !staff.active ||
    !STAFF.includes(staff.role) ||
    (staff.sportIds.length && !staff.sportIds.includes("football"))
  )
    throw new WorkspaceError(
      400,
      "Choose an active football staff member of this academy to look after the new player.",
    );
  const token = randomBytes(32).toString("hex"),
    id = randomUUID(),
    expiresAt = new Date(Date.now() + 86400000 * INVITATION_DAYS).toISOString();
  atomic(() => {
    // The address column cannot be empty and must never equal a real address: "player-link:" + id has no "@".
    database()
      .prepare(
        "INSERT INTO workspace_invitations(id,academyId,email,role,playerIds,tokenHash,expiresAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        ctx.academy.id,
        `player-link:${id}`,
        "PARENT",
        "[]",
        createHash("sha256").update(token).digest("hex"),
        expiresAt,
      );
    database()
      .prepare(
        "INSERT INTO invitation_open_player(invitationId,coachId) VALUES(?,?)",
      )
      .run(id, coachId);
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Player invitation link prepared for manual sharing; not sent",
      id,
    );
  });
  return { id, token, status: "NOT_SENT" as const, expiresAt };
}

/**
 * Whether this account is the login of a child who joined through a player link (not a guardian's, and not an older
 * own-login account: those are untouched, see player-login.ts).
 */
export const isPlayersOwnLogin = isPlayerLinkLogin;
/** The signed-in person as the portal receives them: `playerLogin` is present (true) only for a confirmed player's own account. */
export function viewerOf(ctx: WorkspaceAccess): {
  id: string;
  name: string;
  playerLogin?: true;
} {
  const base = { id: ctx.user.id, name: ctx.user.name };
  return ctx.membership.role === "PARENT" &&
    scopedLookup(playerLoginKey(ctx.academy.id, ctx.user.id), () =>
      isPlayersOwnLogin(ctx.academy.id, ctx.user.id),
    )
    ? { ...base, playerLogin: true }
    : base;
}
/**
 * A child's own login does not start or continue private one-to-one conversations with staff. A guardian does; a child is
 * reached through the academy's batch announcements and at training. This is a safeguarding default the owner can lift.
 */
export function requireNoPrivateChat(ctx: WorkspaceAccess) {
  if (
    ctx.membership.role === "PARENT" &&
    isPlayersOwnLogin(ctx.academy.id, ctx.user.id)
  )
    throw new WorkspaceError(
      403,
      "Private messages to staff are not available from a player's own login. Ask your parent or guardian, or speak to your coach at training.",
    );
}

/**
 * Where this signed-in member is in joining. "details": they used a player link and still have to type their own details.
 * "waiting": they have typed them and the academy has not confirmed yet. "none": neither. `playerLogin` is true for the account
 * of a confirmed player (the screens then show a player's view, not a parent's). Only the member's own rows are read.
 */
export function selfPlayerStatus(ctx: WorkspaceAccess) {
  if (ctx.membership.role !== "PARENT")
    return { state: "none" as const, playerLogin: false };
  const details = !!database()
    .prepare("SELECT 1 FROM player_self_pending WHERE academyId=? AND userId=?")
    .get(ctx.academy.id, ctx.user.id);
  const waiting = !!database()
    .prepare("SELECT 1 FROM player_self_submission WHERE academyId=? AND userId=?")
    .get(ctx.academy.id, ctx.user.id);
  const state = details
    ? ("details" as const)
    : waiting
      ? ("waiting" as const)
      : ("none" as const);
  return { state, playerLogin: isPlayersOwnLogin(ctx.academy.id, ctx.user.id) };
}

/**
 * The member sends their own details. NO player record is made: the details wait for the owner or an admin to confirm them
 * (see decideSelfPlayer). Until then the account sees nothing about any player.
 */
export function submitSelfPlayer(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["PARENT"]);
  requirePlayerLinksEnabled();
  const value = detailsSchema.parse(input ?? {});
  return atomic(() => {
    const pending = database()
      .prepare(
        "SELECT invitationId,coachId FROM player_self_pending WHERE academyId=? AND userId=?",
      )
      .get(ctx.academy.id, ctx.user.id);
    if (!pending)
      throw new WorkspaceError(
        409,
        "There are no player details to fill in for this account.",
      );
    requireUnder18(
      { birthDate: value.birthDate, status: "ACTIVE" },
      academyToday(ctx),
      null,
    );
    database()
      .prepare(
        "INSERT INTO player_self_submission(academyId,userId,invitationId,coachId,name,birthDate,position,submittedAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        ctx.academy.id,
        ctx.user.id,
        String(pending.invitationId),
        String(pending.coachId),
        value.name,
        value.birthDate,
        value.position,
        new Date().toISOString(),
      );
    database()
      .prepare("DELETE FROM player_self_pending WHERE academyId=? AND userId=?")
      .run(ctx.academy.id, ctx.user.id);
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Player sent their own details after using an invitation link; waiting for the academy to confirm and to record that a parent or guardian has agreed",
      ctx.user.id,
    );
    return { state: "waiting" as const };
  });
}

/** Owner or admin: the details players have sent that are waiting for confirmation. Never returns an email address. */
export function listSelfPlayers(ctx: WorkspaceAccess) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  requireSport(ctx, "football");
  const rows = database()
    .prepare(
      'SELECT s.userId,s.name,s.birthDate,s.position,s.submittedAt,c.name AS coachName FROM player_self_submission s JOIN academy_memberships m ON m.academyId=s.academyId AND m.userId=s.userId AND m.active=1 LEFT JOIN "user" c ON c.id=s.coachId WHERE s.academyId=? ORDER BY s.submittedAt',
    )
    .all(ctx.academy.id);
  return {
    // false while links are switched off: the screens then say so instead of offering a button that would be refused.
    enabled: playerLinksEnabled(),
    items: rows.map((r) => ({
      userId: String(r.userId),
      name: String(r.name),
      birthDate: String(r.birthDate),
      position: String(r.position),
      submittedAt: String(r.submittedAt),
      coachName: r.coachName ? String(r.coachName) : "",
      possibleDuplicates: possibleDuplicates(
        ctx.academy.id,
        String(r.name),
        String(r.birthDate),
      ),
    })),
  };
}

const wordsOf = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
/**
 * Players already in this academy who may be the same person as a request. This only WARNS: nothing is merged, linked or
 * changed. A match is the same words in the name (in any order) with the same date of birth, or the same name alone, or the
 * same date of birth with the same first word. Archived players are included: a returning player is the usual case.
 */
export function possibleDuplicates(
  academyId: string,
  name: string,
  birthDate: string,
) {
  const mine = wordsOf(name),
    mineKey = [...mine].sort().join(" ");
  const found: {
    id: string;
    name: string;
    birthDate: string;
    status: string;
    reason: string;
    rank: number;
  }[] = [];
  for (const p of repo.list(academyId, "player")) {
    const theirs = wordsOf(String(p.name)),
      sameName = !!mineKey && [...theirs].sort().join(" ") === mineKey,
      sameBirth = !!birthDate && p.birthDate === birthDate,
      sameFirst = !!mine[0] && theirs[0] === mine[0];
    const reason =
      sameName && sameBirth
        ? { rank: 1, text: "Same name and date of birth" }
        : sameName
          ? { rank: 2, text: "Same name" }
          : sameBirth && sameFirst
            ? { rank: 3, text: "Same date of birth and first name" }
            : null;
    if (reason)
      found.push({
        id: p.id,
        name: String(p.name),
        birthDate: String(p.birthDate ?? ""),
        status: String(p.status),
        reason: reason.text,
        rank: reason.rank,
      });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((d) => ({
      id: d.id,
      name: d.name,
      birthDate: d.birthDate,
      status: d.status,
      reason: d.reason,
    }));
}

const decisionSchema = z.object({
  userId: z.string().min(1).max(100),
  decision: z.enum(["approve", "decline"]),
  consentOnFile: z.boolean().optional(),
  // The owner says the request is a different person from the possible duplicates shown. Never merges anything.
  differentPlayer: z.boolean().optional(),
});

/**
 * Owner or admin confirms or declines the details a player sent.
 * Approve needs the owner's statement that a parent or guardian has agreed (consent is collected by the academy outside this
 * screen); the date of birth is checked again against today's date. Only then are the player record and the links created, in
 * one step. Decline removes the request and the account's access to the academy.
 */
export function decideSelfPlayer(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER", "ADMIN"]);
  requireSport(ctx, "football");
  const value = decisionSchema.parse(input ?? {});
  if (value.decision === "approve") requirePlayerLinksEnabled();
  if (value.decision === "approve" && value.consentOnFile !== true)
    throw new WorkspaceError(
      400,
      "Confirm that a parent or guardian has agreed before you approve this player.",
    );
  return atomic(() => {
    const request = database()
      .prepare(
        "SELECT s.coachId,s.name,s.birthDate,s.position FROM player_self_submission s JOIN academy_memberships m ON m.academyId=s.academyId AND m.userId=s.userId AND m.active=1 AND m.role='PARENT' WHERE s.academyId=? AND s.userId=?",
      )
      .get(ctx.academy.id, value.userId);
    if (!request)
      throw new WorkspaceError(
        409,
        "This request is no longer waiting for confirmation.",
      );
    if (value.decision === "decline") {
      database()
        .prepare("DELETE FROM player_self_submission WHERE academyId=? AND userId=?")
        .run(ctx.academy.id, value.userId);
      database()
        .prepare(
          "UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=? AND role='PARENT'",
        )
        .run(ctx.academy.id, value.userId);
      audit(
        ctx.academy.id,
        ctx.user.id,
        "Player request declined; the account was removed from the academy",
        value.userId,
      );
      return { declined: true as const };
    }
    requireUnder18(
      { birthDate: String(request.birthDate), status: "ACTIVE" },
      academyToday(ctx),
      null,
    );
    // Checked here, inside the same transaction as the insert, so a player added a moment ago is seen. It only warns.
    const same = possibleDuplicates(
      ctx.academy.id,
      String(request.name),
      String(request.birthDate),
    );
    if (same.length && value.differentPlayer !== true)
      throw new WorkspaceError(
        409,
        `This may be a player you already have: ${same
          .map((p) => `${p.name} (${p.reason.toLowerCase()})`)
          .join(", ")}. Check, then confirm that this is a different player. Nothing is merged.`,
        {},
        "POSSIBLE_DUPLICATE_PLAYER",
      );
    // The staff member the link named, or the owner if that person no longer has access.
    let coachId = String(request.coachId);
    const staff = repo.membership(ctx.academy.id, coachId);
    if (!staff || !staff.active || !STAFF.includes(staff.role)) {
      const owner = database()
        .prepare(
          "SELECT userId FROM academy_memberships WHERE academyId=? AND role='OWNER' AND active=1 LIMIT 1",
        )
        .get(ctx.academy.id);
      if (!owner)
        throw new WorkspaceError(
          409,
          "This academy has no staff to look after a new player.",
        );
      coachId = String(owner.userId);
    }
    const id = randomUUID();
    const player: WorkspacePlayer = {
      id,
      academyId: ctx.academy.id,
      name: String(request.name),
      sportIds: ["football"],
      squad: "",
      squadId: "",
      birthDate: String(request.birthDate),
      position: String(request.position),
      status: "ACTIVE",
      coachId,
    };
    repo.save(ctx.academy.id, "player", player);
    database()
      .prepare(
        "INSERT INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)",
      )
      .run(ctx.academy.id, value.userId, id);
    database()
      .prepare(
        "INSERT INTO player_self_login(academyId,userId,playerId) VALUES(?,?,?)",
      )
      .run(ctx.academy.id, value.userId, id);
    // This row, not player_self_login, is what limits the login (see player-login.ts).
    database()
      .prepare(
        "INSERT INTO player_link_login(academyId,userId,playerId,confirmedAt,confirmedBy) VALUES(?,?,?,?,?)",
      )
      .run(ctx.academy.id, value.userId, id, new Date().toISOString(), ctx.user.id);
    database()
      .prepare("DELETE FROM player_self_submission WHERE academyId=? AND userId=?")
      .run(ctx.academy.id, value.userId);
    audit(
      ctx.academy.id,
      ctx.user.id,
      "Player confirmed by the academy; the academy recorded that a parent or guardian has agreed (consent held by the academy)",
      id,
    );
    return { declined: false as const, playerId: id };
  });
}
