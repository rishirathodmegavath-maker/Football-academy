import "server-only";
import { database } from "./database";
import { WorkspaceError } from "./auth";

/**
 * A "player login" is the account of a child who joined through a player invitation link and was confirmed by the academy.
 * Such accounts are recorded in their own table, `player_link_login`. Older own-login accounts (`player_self_login`,
 * migration 015) are NOT in it, so they keep exactly the access they had: nothing about an existing account changes.
 *
 * Every server rule that limits a player login asks this module, so there is one definition. Hiding something in the
 * screen is never relied on.
 */
export function isPlayerLinkLogin(academyId: string, userId: string) {
  return !!database()
    .prepare("SELECT 1 FROM player_link_login WHERE academyId=? AND userId=?")
    .get(academyId, userId);
}

/** The key under which one read (an academy payload, a record list) shares its answer. See scopedLookup in workspace-access.ts. */
export const playerLoginKey = (academyId: string, userId: string) =>
  `player-link-login:${academyId}:${userId}`;

type Who = {
  academy: { id: string };
  user: { id: string };
  membership: { role: string };
};
/**
 * Player invitation links create logins for people under 18. They are OFF unless the operator sets
 * SPORTOZEN_PLAYER_LINKS_ENABLED=1, and the operator should do that only after the academy has had legal advice on
 * parental consent for children's data (see docs/ROLES_AND_INVITATIONS.md). Nothing in this codebase decides that for them.
 * While it is off no link can be made or used and no player's details can be sent or confirmed; declining and cancelling
 * still work so nothing is left stuck.
 */
export function playerLinksEnabled() {
  return process.env.SPORTOZEN_PLAYER_LINKS_ENABLED === "1";
}
export function requirePlayerLinksEnabled() {
  if (!playerLinksEnabled())
    throw new WorkspaceError(
      403,
      "Player invitation links are switched off for this deployment until the academy has had legal advice on parental consent for players under 18.",
      {},
      "PLAYER_LINKS_DISABLED",
    );
}

/** True when the signed-in account is a confirmed player login (always a PARENT-scoped member). */
export function isRestrictedPlayerLogin(ctx: Who) {
  return (
    ctx.membership.role === "PARENT" &&
    isPlayerLinkLogin(ctx.academy.id, ctx.user.id)
  );
}

/** Refuse a player login with 403. `what` completes "... is not available from a player's own login". */
export function requireNotPlayerLogin(ctx: Who, what: string) {
  if (isRestrictedPlayerLogin(ctx))
    throw new WorkspaceError(
      403,
      `${what} is not available from a player's own login. It is shared with the player's parent or guardian.`,
    );
}

/**
 * What a player login never reads from the server: the content written for parents and guardians. Reports, plans (the
 * weekly plan and the report's plan, which is where the "practice at home" section comes from), updates, private
 * conversations, dietary notes and fees. Their own player record, schedule and the academy's announcements stay.
 */
export const PLAYER_LOGIN_HIDDEN_KINDS: ReadonlySet<string> = new Set([
  "weekly",
  "plan",
  "report",
  "update",
  "conversation",
  "dietary",
  "fee",
]);
