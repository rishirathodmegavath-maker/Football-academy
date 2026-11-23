import type { DatabaseSync } from "node:sqlite";

/**
 * Global e-mail delivery. Three changes, all keeping every existing row:
 *
 * 1. email_outbox is rebuilt (SQLite cannot change a CHECK constraint in
 *    place) so that it accepts the new message kinds, and gains htmlBody (the
 *    HTML form of a message; erased with textBody once the message is finished)
 *    and the provider's delivery outcome: deliveryStatus (DELIVERED, DELAYED,
 *    BOUNCED, COMPLAINED), deliveredAt and bouncedAt. `status` keeps meaning
 *    "what this application did"; `deliveryStatus` means "what the recipient's
 *    mail system did", reported later by the provider's webhook.
 * 2. email_events records each provider event once (the provider and its event
 *    id are unique, so a replayed webhook changes nothing).
 * 3. email_suppressions lists addresses that hard-bounced or complained; nothing
 *    more is queued for them until an operator removes the row.
 *
 * Idempotent and safe to run from several processes starting together: the
 * rebuild re-checks inside an IMMEDIATE transaction.
 */
const PURPOSES = [
  "VERIFICATION",
  "PASSWORD_RESET",
  "INVITATION",
  "SESSION_NOTICE",
  "PAYMENT_RECEIPT",
  "REPORT_READY",
  "NOTIFICATION",
];

const OUTBOX = (name: string) => `
  CREATE TABLE ${name}(
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK(purpose IN (${PURPOSES.map((p) => `'${p}'`).join(",")})),
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
    finishedAt TEXT,
    htmlBody TEXT,
    deliveryStatus TEXT CHECK(deliveryStatus IS NULL OR deliveryStatus IN ('DELIVERED','DELAYED','BOUNCED','COMPLAINED')),
    deliveredAt TEXT,
    bouncedAt TEXT
  );`;
const INDEXES = `
  CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, nextAttemptAt);
  CREATE INDEX IF NOT EXISTS email_outbox_related ON email_outbox(relatedId);
  CREATE INDEX IF NOT EXISTS email_outbox_recipient ON email_outbox(toAddress, purpose, createdAt);
  CREATE INDEX IF NOT EXISTS email_outbox_provider ON email_outbox(providerMessageId);`;
const OLD_COLUMNS =
  "id,purpose,toAddress,subject,textBody,academyId,relatedId,status,attempts,nextAttemptAt,leaseUntil,lastError,providerMessageId,createdAt,expiresAt,finishedAt";

const rebuilt = (db: DatabaseSync) =>
  String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='email_outbox'").get()
      ?.sql ?? "",
  ).includes("bouncedAt");

export function migrateEmailDelivery(db: DatabaseSync) {
  if (!rebuilt(db)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!rebuilt(db)) {
        db.exec(`${OUTBOX("email_outbox_new")}
          INSERT INTO email_outbox_new(${OLD_COLUMNS}) SELECT ${OLD_COLUMNS} FROM email_outbox;
          DROP TABLE email_outbox;
          ALTER TABLE email_outbox_new RENAME TO email_outbox;`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The failing statement may already have ended the transaction.
      }
      throw error;
    }
  }
  db.exec(`${INDEXES}
    CREATE TABLE IF NOT EXISTS email_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      eventId TEXT NOT NULL,
      providerMessageId TEXT,
      outboxId TEXT,
      kind TEXT NOT NULL,
      detail TEXT,
      occurredAt TEXT NOT NULL,
      receivedAt TEXT NOT NULL,
      UNIQUE(provider, eventId)
    );
    CREATE INDEX IF NOT EXISTS email_events_message ON email_events(providerMessageId);
    CREATE TABLE IF NOT EXISTS email_suppressions(
      address TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );`);
}
