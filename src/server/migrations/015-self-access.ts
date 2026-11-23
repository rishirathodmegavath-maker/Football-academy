import type { DatabaseSync } from "node:sqlite";

/**
 * A player who signs in for themselves (an adult, or a young person with no
 * parent in the academy).
 *
 * A player's own access uses exactly the same scoping as a guardian's: the
 * account is linked to the player record (guardian_relationships) and sees only
 * that record. The one new fact is that the link is the player's own, kept in
 * two small tables of its own so that no existing table changes:
 *
 * invitation_self      an invitation that is for the player themselves
 * player_self_login    an account that is the player themselves (one per player)
 *
 * Additive and idempotent. Reversible: DROP TABLE both; the links then simply
 * read as guardian links.
 */
export function migrateSelfAccess(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_self(
      invitationId TEXT PRIMARY KEY REFERENCES workspace_invitations(id)
    );
    CREATE TABLE IF NOT EXISTS player_self_login(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      playerId TEXT NOT NULL,
      PRIMARY KEY(academyId,userId,playerId)
    );
    CREATE INDEX IF NOT EXISTS player_self_login_player
      ON player_self_login(academyId,playerId);
  `);
}
