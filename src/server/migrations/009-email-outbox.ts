import type { DatabaseSync } from "node:sqlite";

/**
 * Additive: one new table and two indexes, nothing existing is touched.
 *
 * email_outbox is a queue, not a history. A message that carries a secret link
 * (verification, password reset, invitation) keeps its text only until it is
 * sent, expires or is cancelled; after that textBody is NULL, so a backup or a
 * database copy never holds a usable link for long.
 */
export function migrateEmailOutbox(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_outbox(
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('VERIFICATION','PASSWORD_RESET','INVITATION')),
      toAddress TEXT NOT NULL,
      subject TEXT NOT NULL,
      textBody TEXT,
      academyId TEXT,
      relatedId TEXT,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','SENDING','SENT','FAILED','EXPIRED','CANCELLED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      nextAttemptAt TEXT NOT NULL,
      leaseUntil TEXT,
      lastError TEXT,
      providerMessageId TEXT,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      finishedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, nextAttemptAt);
    CREATE INDEX IF NOT EXISTS email_outbox_related ON email_outbox(relatedId);
    CREATE INDEX IF NOT EXISTS email_outbox_recipient ON email_outbox(toAddress, purpose, createdAt);
  `);
}
