import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { checkRecipient } from "./address";
import {
  EmailSendError,
  type DeliveryEvent,
  type EmailProvider,
  type EmailTransport,
  type WebhookAdapter,
} from "./types";

// The Postmark adapter: the only file that knows Postmark's API and webhook
// format. It is one entry in the provider registry (transport.ts); nothing else
// in the application refers to it.

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Postmark (https://postmarkapp.com), transactional stream. Credentials are
 * read from the environment by emailConfig (the server token never appears in a
 * log, an error message or the stored outbox row). Open and link tracking are
 * off: tracking would rewrite the secret links. Responses are mapped onto the
 * outbox's retry contract: network failures, timeouts, 429 and 5xx are
 * transient; authentication failures and every other rejection are permanent.
 */
export function postmarkTransport(options: {
  token: string;
  stream: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  endpoint?: string;
}): EmailTransport {
  const doFetch: FetchLike =
    options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  return {
    name: "postmark",
    async send(email) {
      const to = checkRecipient(email.to);
      if (!to.ok)
        throw new EmailSendError(
          "Recipient is not a valid address.",
          true,
          "INVALID_RECIPIENT",
        );
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(
          options.endpoint ?? "https://api.postmarkapp.com/email",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json; charset=utf-8",
              "X-Postmark-Server-Token": options.token,
            },
            body: JSON.stringify({
              From: email.from,
              To: to.ascii,
              Subject: email.subject,
              TextBody: email.text,
              ...(email.html ? { HtmlBody: email.html } : {}),
              MessageStream: options.stream,
              TrackOpens: false,
              TrackLinks: "None",
              Metadata: { outboxId: email.id },
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
          },
        );
      } catch {
        // Timeout, DNS or connection failure. The request may or may not have
        // reached the provider: delivery is at-least-once.
        throw new EmailSendError(
          "The email provider could not be reached.",
          false,
          "NETWORK",
        );
      }
      let body: { ErrorCode?: number; MessageID?: string } = {};
      try {
        body = JSON.parse(await response.text());
      } catch {
        // A non-JSON body is classified by status alone.
      }
      if (response.status === 200 && body.ErrorCode === 0 && body.MessageID)
        return { providerMessageId: body.MessageID };
      if (response.status === 429 || response.status >= 500)
        throw new EmailSendError(
          `Provider answered ${response.status}.`,
          false,
          response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
        );
      if (response.status === 401 || response.status === 403)
        throw new EmailSendError(
          "The provider refused the credentials.",
          true,
          "AUTH",
        );
      // 422 carries Postmark's own code; 406 is an inactive (bounced, complained
      // or suppressed) recipient, 300/400/409 and the rest are rejected requests.
      throw new EmailSendError(
        `Provider rejected the message (code ${body.ErrorCode ?? response.status}).`,
        true,
        body.ErrorCode === 406 ? "INACTIVE_RECIPIENT" : "REJECTED",
      );
    },
  };
}

// Postmark webhook payloads (https://postmarkapp.com/developer/webhooks). Only
// the fields used here are read; anything else is ignored.
const PERMANENT_BOUNCES = new Set([
  "HardBounce",
  "BadEmailAddress",
  "ManuallyDeactivated",
  "SpamNotification",
  "VirusNotification",
]);
const postmark = z.discriminatedUnion("RecordType", [
  z.object({
    RecordType: z.literal("Delivery"),
    MessageID: z.string().min(1),
    DeliveredAt: z.string().optional(),
  }),
  z.object({
    RecordType: z.literal("Bounce"),
    ID: z.union([z.number(), z.string()]),
    MessageID: z.string().min(1),
    Type: z.string().optional(),
    Description: z.string().optional(),
    BouncedAt: z.string().optional(),
  }),
  z.object({
    RecordType: z.literal("SpamComplaint"),
    ID: z.union([z.number(), z.string()]),
    MessageID: z.string().min(1),
    BouncedAt: z.string().optional(),
  }),
]);
const iso = (ms: number) => new Date(ms).toISOString();
/** Null for a payload this application does not act on (other record types). */
export function parsePostmarkEvent(
  body: unknown,
  now = Date.now(),
): DeliveryEvent | null {
  const parsed = postmark.safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data;
  const at = (value?: string) => {
    const t = value ? Date.parse(value) : NaN;
    return Number.isNaN(t) ? iso(now) : iso(t);
  };
  if (p.RecordType === "Delivery")
    return {
      provider: "postmark",
      eventId: `delivery:${p.MessageID}`,
      providerMessageId: p.MessageID,
      kind: "DELIVERED",
      occurredAt: at(p.DeliveredAt),
    };
  if (p.RecordType === "SpamComplaint")
    return {
      provider: "postmark",
      eventId: `complaint:${p.ID}`,
      providerMessageId: p.MessageID,
      kind: "COMPLAINED",
      detail: "SpamComplaint",
      occurredAt: at(p.BouncedAt),
    };
  return {
    provider: "postmark",
    eventId: `bounce:${p.ID}`,
    providerMessageId: p.MessageID,
    // A soft bounce (full mailbox, temporary failure, auto-reply) is a delay,
    // not a reason to stop writing to the address.
    kind: p.Type && PERMANENT_BOUNCES.has(p.Type) ? "BOUNCED" : "DELAYED",
    detail: [p.Type, p.Description].filter(Boolean).join(": "),
    occurredAt: at(p.BouncedAt),
  };
}

// Postmark signs nothing; it calls the URL with the HTTP Basic credentials set
// in its webhook settings. The endpoint is closed (404) until both variables
// are set (the password at least 16 characters).
const digest = (value: string) => createHash("sha256").update(value).digest();
const postmarkWebhook: WebhookAdapter = {
  requiredEnv: [
    "SPORTOZEN_POSTMARK_WEBHOOK_USER",
    "SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD",
  ],
  configured: (env) =>
    (env.SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD ?? "").length >= 16,
  authenticate(headers, env) {
    const user = env.SPORTOZEN_POSTMARK_WEBHOOK_USER ?? "",
      password = env.SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD ?? "";
    if (!user || password.length < 16) return false;
    const given = /^Basic (.+)$/i.exec(headers.get("authorization") ?? "");
    const supplied = given
      ? Buffer.from(given[1]!, "base64").toString("utf8")
      : "";
    return timingSafeEqual(digest(supplied), digest(`${user}:${password}`));
  },
  parse(body, now) {
    const event = parsePostmarkEvent(body, now);
    return event ? [event] : [];
  },
};

export const postmarkProvider: EmailProvider = {
  name: "postmark",
  kind: "real",
  requiredEnv: [
    { name: "SPORTOZEN_POSTMARK_TOKEN", description: "the Server API token" },
  ],
  create: (env) =>
    postmarkTransport({
      token: env.SPORTOZEN_POSTMARK_TOKEN ?? "",
      stream: env.SPORTOZEN_POSTMARK_STREAM || "outbound",
    }),
  webhook: postmarkWebhook,
};
