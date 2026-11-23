// The contract between Sportozen's e-mail code and any provider. This file has
// no imports, so every other e-mail file can depend on it without a cycle.

export type OutgoingEmail = {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
};
export type SendResult = { providerMessageId: string };

/** A failure the transport can classify. `permanent` failures (bad address,
 * rejected content, authentication failure) are never retried; anything else
 * is retried with backoff. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    public permanent: boolean,
    public code: string,
  ) {
    super(message);
  }
}
export interface EmailTransport {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/**
 * What the recipient's mail system did with a message, as reported later by
 * the provider (webhook). Recorded once per provider event id, applied to the
 * outbox row it concerns, and, for a permanent bounce or a spam complaint,
 * turned into a suppression so nothing more is sent to that address.
 */
export type DeliveryKind = "DELIVERED" | "DELAYED" | "BOUNCED" | "COMPLAINED";
export type DeliveryEvent = {
  provider: string;
  eventId: string;
  providerMessageId: string;
  kind: DeliveryKind;
  detail?: string;
  occurredAt: string;
};

/**
 * A provider is everything the application needs to know about one way of
 * sending mail, in one object. The business code, the outbox, the templates and
 * the delivery tracking never name a provider: they call the EmailTransport the
 * configured provider creates and read the DeliveryEvents its webhook adapter
 * produces.
 */
export interface ProviderEnv {
  name: string;
  /** Said to the operator when the variable is missing. */
  description: string;
}
export interface WebhookAdapter {
  /** Variables that must be set before the endpoint opens (until then it answers 404). */
  requiredEnv: readonly string[];
  /** Extra condition for the endpoint to open (for example a minimum secret length). */
  configured?(env: Record<string, string | undefined>): boolean;
  /** True when the request is authentic. Compare secrets in constant time. */
  authenticate(
    headers: Headers,
    env: Record<string, string | undefined>,
  ): boolean;
  /** Zero or more events this application acts on; payloads it does not use give none. */
  parse(body: unknown, now: number): DeliveryEvent[];
}
export interface EmailProvider {
  /** The value of SPORTOZEN_EMAIL_TRANSPORT. */
  name: string;
  /**
   * real:  sends to real mailboxes; allowed in a deployment.
   * local: writes messages to disk with their live links; only on localhost.
   * test:  in memory; refused in production.
   */
  kind: "real" | "local" | "test";
  requiredEnv: readonly ProviderEnv[];
  create(env: Record<string, string | undefined>): EmailTransport;
  webhook?: WebhookAdapter;
}
