import "server-only";
import { atomic, database } from "../database";
import { log } from "../log";
import { sanitize } from "./outbox";
import type { DeliveryEvent, DeliveryKind } from "./types";

export type { DeliveryEvent, DeliveryKind } from "./types";
// A later report never undoes a worse one (a "delivered" that arrives after a
// bounce, a "delayed" after a delivery).
const RANK: Record<DeliveryKind, number> = {
  DELAYED: 1,
  DELIVERED: 2,
  BOUNCED: 3,
  COMPLAINED: 4,
};
const iso = (ms: number) => new Date(ms).toISOString();

/** Returns false for an event that was already recorded (a replayed webhook). */
export function recordDeliveryEvent(
  event: DeliveryEvent,
  now = Date.now(),
): { recorded: boolean; matched: boolean } {
  return atomic(() => {
    const db = database();
    const row = db
      .prepare(
        "SELECT id,toAddress,deliveryStatus FROM email_outbox WHERE providerMessageId=?",
      )
      .get(event.providerMessageId) as
      | { id: string; toAddress: string; deliveryStatus: string | null }
      | undefined;
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO email_events(provider,eventId,providerMessageId,outboxId,kind,detail,occurredAt,receivedAt)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.provider,
        event.eventId,
        event.providerMessageId,
        row?.id ?? null,
        event.kind,
        event.detail ? sanitize(event.detail) : null,
        event.occurredAt,
        iso(now),
      ).changes;
    if (!inserted) return { recorded: false, matched: !!row };
    if (row) {
      const current = row.deliveryStatus as DeliveryKind | null;
      if (!current || RANK[event.kind] >= RANK[current])
        db.prepare(
          `UPDATE email_outbox SET deliveryStatus=?,
             deliveredAt=CASE WHEN ?='DELIVERED' THEN ? ELSE deliveredAt END,
             bouncedAt=CASE WHEN ? IN ('BOUNCED','COMPLAINED') THEN ? ELSE bouncedAt END,
             lastError=CASE WHEN ? IN ('BOUNCED','COMPLAINED') THEN ? ELSE lastError END
           WHERE id=?`,
        ).run(
          event.kind,
          event.kind,
          event.occurredAt,
          event.kind,
          event.occurredAt,
          event.kind,
          `${event.kind}${event.detail ? `: ${sanitize(event.detail)}` : ""}`,
          row.id,
        );
      if (event.kind === "BOUNCED" || event.kind === "COMPLAINED")
        db.prepare(
          "INSERT OR IGNORE INTO email_suppressions(address,reason,source,createdAt) VALUES(?,?,?,?)",
        ).run(row.toAddress, event.kind, event.provider, iso(now));
    }
    // Identifiers and the kind only: no address, no link, no message text.
    log("info", "email.delivery_event", {
      messageId: row?.id,
      kind: event.kind,
      provider: event.provider,
      matched: !!row,
    });
    return { recorded: true, matched: !!row };
  });
}

// Provider webhook adapters (parsing and authentication) live with their
// provider, e.g. postmark.ts; kept exported here for existing imports.
export { parsePostmarkEvent } from "./postmark";
