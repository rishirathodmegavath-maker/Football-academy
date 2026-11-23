import "server-only";
import { randomUUID } from "node:crypto";
import { database } from "../database";
import { log, errorFields } from "../log";
import { checkRecipient } from "./address";
import { emailConfig } from "./config";
import {
  createTransport,
  EmailSendError,
  type EmailTransport,
} from "./transport";

/** Seconds to wait after the 1st, 2nd, ... failed attempt. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
/** A claimed message that is not finished within this time is picked up again. */
export const LEASE_SECONDS = 120;
/** At most this many messages of one kind to one address per hour. */
export const RECIPIENT_HOURLY_LIMIT = 5;
const RETENTION_DAYS = 90;

export type EmailPurpose =
  | "VERIFICATION"
  | "PASSWORD_RESET"
  | "INVITATION"
  | "SESSION_NOTICE"
  | "PAYMENT_RECEIPT"
  | "REPORT_READY"
  | "NOTIFICATION";
export type EmailStatus =
  "QUEUED" | "SENDING" | "SENT" | "FAILED" | "EXPIRED" | "CANCELLED";
export type DeliveryStatus =
  "NOT_SENT" | "QUEUED" | "SENT" | "FAILED" | "EXPIRED";

const iso = (ms: number) => new Date(ms).toISOString();
/** Removes anything that looks like a link or a token before text is stored or logged. */
export function sanitize(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .slice(0, 200);
}

/**
 * Adds a message to the queue. Returns null, silently, when this address
 * already received the per-hour maximum of this kind (mail-bombing guard).
 * Synchronous, so it can run inside the same transaction that creates the
 * invitation or token it announces.
 */
export function enqueueEmail(input: EnqueueInput): { id: string } | null {
  const result = enqueueEmailChecked(input);
  return "refused" in result ? null : { id: result.id };
}

export type EnqueueInput = {
  purpose: EmailPurpose;
  to: string;
  subject: string;
  text: string;
  html?: string;
  expiresAt: string;
  academyId?: string;
  relatedId?: string;
  now?: number;
};
export type EnqueueRefusal = "INVALID" | "SUPPRESSED" | "RATE_LIMIT";
/** Most messages of one kind to one address in 24 hours when messages that
 * would exceed the hourly limit are held back instead of dropped. */
export const DEFERRED_DAILY_LIMIT = 20;

/**
 * `enqueueEmail` with the reason spelled out. A caller that must account for
 * every recipient (a cancellation notice) uses this, so a refusal is reported,
 * not silently lost.
 *
 * `onLimit: "defer"` queues a message that would exceed the hourly limit for
 * delivery after the oldest message of that hour has aged out of it, instead
 * of dropping it. The mail-bombing guard still holds: past
 * DEFERRED_DAILY_LIMIT in 24 hours the message is refused and reported.
 */
export function enqueueEmailChecked(
  input: EnqueueInput & { onLimit?: "drop" | "defer" },
): { id: string; deferred: boolean } | { refused: EnqueueRefusal } {
  const db = database(),
    now = input.now ?? Date.now(),
    checked = checkRecipient(input.to);
  // Any valid address in any country is accepted; an invalid one is dropped
  // (nothing is logged about it: it may be a person's address).
  if (!checked.ok) {
    log("warn", "email.recipient_invalid", { purpose: input.purpose });
    return { refused: "INVALID" };
  }
  const to = checked.address.toLowerCase();
  // A hard bounce or a spam complaint stops further mail to that address.
  if (isSuppressed(to)) {
    log("warn", "email.recipient_suppressed", { purpose: input.purpose });
    return { refused: "SUPPRESSED" };
  }
  const window = db
    .prepare(
      "SELECT COUNT(*) n, MIN(createdAt) oldest FROM email_outbox WHERE toAddress=? AND purpose=? AND createdAt>?",
    )
    .get(to, input.purpose, iso(now - 3600_000));
  let sendAt = now,
    deferred = false;
  if (Number(window?.n) >= RECIPIENT_HOURLY_LIMIT) {
    if (input.onLimit !== "defer") return { refused: "RATE_LIMIT" };
    const day = Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE toAddress=? AND purpose=? AND createdAt>?",
        )
        .get(to, input.purpose, iso(now - 86_400_000))?.n,
    );
    if (day >= DEFERRED_DAILY_LIMIT) return { refused: "RATE_LIMIT" };
    sendAt = Date.parse(String(window?.oldest)) + 3600_000 + 1000;
    deferred = true;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO email_outbox(id,purpose,toAddress,subject,textBody,htmlBody,academyId,relatedId,status,attempts,nextAttemptAt,createdAt,expiresAt)
     VALUES(?,?,?,?,?,?,?,?,'QUEUED',0,?,?,?)`,
  ).run(
    id,
    input.purpose,
    to,
    input.subject,
    input.text,
    input.html ?? null,
    input.academyId ?? null,
    input.relatedId ?? null,
    iso(sendAt),
    iso(now),
    input.expiresAt,
  );
  return { id, deferred };
}

/** Withdraws unsent messages for something that no longer applies (a re-sent
 * or revoked invitation). Their secret links are erased. */
export function cancelEmails(relatedId: string, now = Date.now()): number {
  return Number(
    database()
      .prepare(
        `UPDATE email_outbox SET status='CANCELLED', textBody=NULL, htmlBody=NULL, finishedAt=?
         WHERE relatedId=? AND status IN ('QUEUED','SENDING')`,
      )
      .run(iso(now), relatedId).changes,
  );
}

/** Delivery state of the most recent message for each id, for administrators. */
export function deliveryStatuses(relatedIds: string[]) {
  const out = new Map<string, DeliveryStatus>();
  const db = database();
  for (const id of relatedIds) {
    const row = db
      .prepare(
        "SELECT status,deliveryStatus FROM email_outbox WHERE relatedId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
      )
      .get(id);
    // The recipient's mail system refusing the message (reported later by the
    // provider) counts as a failed delivery for the administrator.
    const status = row
      ? row.deliveryStatus === "BOUNCED" || row.deliveryStatus === "COMPLAINED"
        ? "FAILED"
        : String(row.status)
      : null;
    out.set(
      id,
      status === null || status === "CANCELLED"
        ? "NOT_SENT"
        : status === "SENDING"
          ? "QUEUED"
          : (status as DeliveryStatus),
    );
  }
  return out;
}

type Row = {
  id: string;
  purpose: string;
  toAddress: string;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  attempts: number;
  expiresAt: string;
};
function claim(now: number, limit: number): Row[] {
  return database()
    .prepare(
      `UPDATE email_outbox SET status='SENDING', attempts=attempts+1, leaseUntil=?
       WHERE id IN (
         SELECT id FROM email_outbox
         WHERE (status='QUEUED' AND nextAttemptAt<=?) OR (status='SENDING' AND leaseUntil<?)
         ORDER BY nextAttemptAt LIMIT ?)
       RETURNING id,purpose,toAddress,subject,textBody,htmlBody,attempts,expiresAt`,
    )
    .all(iso(now + LEASE_SECONDS * 1000), iso(now), iso(now), limit) as Row[];
}
function finish(
  id: string,
  status: EmailStatus,
  now: number,
  extra: { error?: string; provider?: string } = {},
) {
  database()
    .prepare(
      `UPDATE email_outbox SET status=?, textBody=NULL, htmlBody=NULL, leaseUntil=NULL, finishedAt=?, lastError=?, providerMessageId=? WHERE id=?`,
    )
    .run(status, iso(now), extra.error ?? null, extra.provider ?? null, id);
}
export type RunSummary = {
  sent: number;
  retried: number;
  failed: number;
  expired: number;
};

/**
 * Sends everything that is due. Safe to run from several processes at once:
 * each message is claimed atomically. At-least-once: a crash between the
 * provider accepting a message and the database recording it can send twice.
 */
export async function processOutbox(
  options: {
    transport?: EmailTransport | null;
    now?: () => number;
    limit?: number;
  } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { sent: 0, retried: 0, failed: 0, expired: 0 };
  const config = emailConfig();
  const transport =
    options.transport === undefined
      ? createTransport(config)
      : options.transport;
  if (!transport) return summary;
  const clock = options.now ?? Date.now;
  for (const row of claim(clock(), options.limit ?? 20)) {
    const now = clock();
    if (Date.parse(row.expiresAt) <= now || row.textBody === null) {
      finish(row.id, "EXPIRED", now, {
        error: row.textBody === null ? "NO_CONTENT" : "LINK_EXPIRED",
      });
      summary.expired++;
      continue;
    }
    try {
      const result = await transport.send({
        id: row.id,
        to: row.toAddress,
        from: config.from,
        subject: row.subject,
        text: row.textBody,
        ...(row.htmlBody ? { html: row.htmlBody } : {}),
      });
      finish(row.id, "SENT", clock(), { provider: result.providerMessageId });
      summary.sent++;
    } catch (error) {
      const code = error instanceof EmailSendError ? error.code : "UNEXPECTED";
      const permanent = error instanceof EmailSendError && error.permanent;
      const reason = `${code}: ${sanitize(error instanceof Error ? error.message : "unknown error")}`;
      // Identifiers and codes only: no address, no link, no message text.
      log("warn", "email.attempt_failed", {
        messageId: row.id,
        purpose: row.purpose,
        attempt: row.attempts,
        code,
        permanent,
      });
      if (permanent || row.attempts >= MAX_ATTEMPTS) {
        finish(row.id, "FAILED", clock(), {
          error: permanent
            ? reason
            : `RETRIES_EXHAUSTED after ${row.attempts} attempts; ${reason}`,
        });
        summary.failed++;
      } else {
        const wait =
          BACKOFF_SECONDS[row.attempts - 1] ?? BACKOFF_SECONDS.at(-1)!;
        database()
          .prepare(
            "UPDATE email_outbox SET status='QUEUED', leaseUntil=NULL, nextAttemptAt=?, lastError=? WHERE id=?",
          )
          .run(iso(clock() + wait * 1000), reason, row.id);
        summary.retried++;
      }
    }
  }
  return summary;
}

let running = false;
/** Starts a delivery run without making the caller wait for the provider. */
export function kickOutbox() {
  if (running || !emailConfig().enabled) return;
  running = true;
  setImmediate(() => {
    processOutbox()
      .catch((error) =>
        log("error", "email.outbox_run_failed", errorFields(error)),
      )
      .finally(() => {
        running = false;
      });
  });
}

/** Deletes finished rows older than the retention period. Returns the count. */
export function purgeFinished(now = Date.now(), days = RETENTION_DAYS) {
  const cutoff = iso(now - days * 86_400_000),
    db = database();
  const removed = Number(
    db
      .prepare(
        "DELETE FROM email_outbox WHERE status IN ('SENT','FAILED','EXPIRED','CANCELLED') AND finishedAt<?",
      )
      .run(cutoff).changes,
  );
  // Provider events follow the retention of the messages they describe.
  db.prepare("DELETE FROM email_events WHERE receivedAt<?").run(cutoff);
  return removed;
}

/** True when this address hard-bounced or complained; no mail is queued for it. */
export function isSuppressed(address: string): boolean {
  return !!database()
    .prepare("SELECT 1 FROM email_suppressions WHERE address=?")
    .get(address.trim().toLowerCase());
}
