import type { DatabaseSync } from "node:sqlite";

/**
 * Two small tables for free sharing.
 *
 * calendar_feeds   one private calendar link per person per academy. Only a hash of the link's secret is kept, so a
 *                  database copy cannot be used to read anyone's calendar. Making a new link replaces the old one.
 * member_phones    an optional WhatsApp number for a person, entered by that person or by the owner or an admin, so a
 *                  session message can open the right chat. Never shown to anyone who is not staff of the academy.
 *
 * Additive and idempotent. Reversible: DROP TABLE both; nothing else reads them.
 */
export function migrateCalendarAndContacts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_feeds(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(academyId,userId)
    );
    CREATE TABLE IF NOT EXISTS member_phones(
      academyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      phone TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      PRIMARY KEY(academyId,userId)
    );
  `);
}
