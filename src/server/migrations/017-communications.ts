import type { DatabaseSync } from "node:sqlite";

/**
 * The Communications screen (announcements to families, templates, the free "ready to send" list and the delivery log).
 *
 * comm_messages     one row per announcement: draft, approved, scheduled or processed. The people it goes to and the
 *                   channels are kept as JSON in `data`, frozen when it is approved.
 * comm_templates    saved subject and message pairs an owner or admin can reuse.
 * comm_deliveries   one row per family and channel once a message is processed: PORTAL rows are visible in the app,
 *                   E-mail and WhatsApp rows are "ready to share" until someone presses a button (then "opened").
 *                   "Opened" never means delivered or read.
 *
 * Additive and idempotent. Reversible: DROP TABLE the three; nothing else reads them.
 */
export function migrateMessaging(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comm_messages(
      id TEXT PRIMARY KEY,
      academyId TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      authorId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comm_messages_academy ON comm_messages(academyId,updatedAt);
    CREATE TABLE IF NOT EXISTS comm_templates(
      id TEXT PRIMARY KEY,
      academyId TEXT NOT NULL,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comm_templates_academy ON comm_templates(academyId);
    CREATE TABLE IF NOT EXISTS comm_deliveries(
      id TEXT PRIMARY KEY,
      academyId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      userId TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      openedAt TEXT,
      UNIQUE(messageId,userId,channel)
    );
    CREATE INDEX IF NOT EXISTS comm_deliveries_academy ON comm_deliveries(academyId,createdAt);
  `);
}
