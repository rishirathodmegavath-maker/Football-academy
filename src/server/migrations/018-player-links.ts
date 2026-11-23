import type { DatabaseSync } from "node:sqlite";

/**
 * "Add player with invitation link": the owner makes one link for a player who has no record yet. The player opens it, signs in
 * and fills in their own details; the owner or an admin then confirms them (and that a parent or guardian has agreed), and only
 * then does the player record exist.
 *
 * Three small tables of their own, so no existing table changes (migration 015 already holds the player's own login):
 *
 * invitation_open_player   an invitation that is not tied to one email address: it works once, for anyone who holds it.
 *                          It carries the staff member the new player will be assigned to.
 * player_self_pending      a person who has used such a link and has not yet filled in their details. One row per account
 *                          per academy; it is removed in the same transaction that creates the player record.
 *
 * player_self_submission   the details the player typed, waiting for the owner or an admin to confirm them. No player record
 *                          exists until then. Removed in the same transaction that confirms (creates the record) or declines.
 *
 * player_link_login       the account of a child who joined through a link and was confirmed. It is what marks a "player login"
 *                          for the server rules that limit it (reports, updates, private messages, fees, recipient lists).
 *                          Older own-login accounts (015) are deliberately not in it and keep their access.
 *
 * Additive and idempotent. Reversible: DROP TABLE all four; nothing else refers to them.
 */
export function migratePlayerLinks(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_open_player(
      invitationId TEXT PRIMARY KEY REFERENCES workspace_invitations(id),
      coachId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_self_pending(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      invitationId TEXT NOT NULL,
      coachId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(academyId,userId)
    );
    CREATE TABLE IF NOT EXISTS player_self_submission(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      invitationId TEXT NOT NULL,
      coachId TEXT NOT NULL,
      name TEXT NOT NULL,
      birthDate TEXT NOT NULL,
      position TEXT NOT NULL,
      submittedAt TEXT NOT NULL,
      PRIMARY KEY(academyId,userId)
    );
    CREATE TABLE IF NOT EXISTS player_link_login(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      playerId TEXT NOT NULL,
      confirmedAt TEXT NOT NULL,
      confirmedBy TEXT NOT NULL,
      PRIMARY KEY(academyId,userId)
    );
  `);
}
