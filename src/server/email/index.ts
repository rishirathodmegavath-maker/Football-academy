import "server-only";
import { emailConfig } from "./config";
import { enqueueEmail, enqueueEmailChecked, kickOutbox } from "./outbox";
import {
  academyDecisionEmail,
  academySubmittedEmail,
  invitationEmail,
  notificationEmail,
  passwordResetEmail,
  paymentReceiptEmail,
  reportReadyEmail,
  sessionNoticeEmail,
  verificationEmail,
  type AcademyOutcome,
  type RenderedEmail,
} from "./templates";
import type { RecipientLocale } from "./format";

export { emailConfig } from "./config";
export { kickOutbox } from "./outbox";

// The one place the application sends mail from. Every feature queues through
// the functions below; they render the shared layout (templates.ts), put the
// message in the outbox (outbox.ts: retries, expiry, per-address cap,
// suppression, erased-after-sending) and start a delivery run without making
// the caller wait. The provider is chosen once by configuration
// (transport.ts); no feature talks to a provider or has its own sender.

export const VERIFICATION_HOURS = 24;
export const RESET_MINUTES = 60;
export const INVITATION_DAYS = 7;
/** Notices without a secret link stay deliverable for this long. */
export const NOTICE_DAYS = 14;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Where an address lands after following the emailed verification link. */
export const VERIFIED_LANDING = "/sign-in?verified=1";

/** Only links on this deployment's own origin are ever put in a message. */
function ownLink(url: string, origin: string) {
  const link = new URL(url, origin);
  if (link.origin !== origin)
    throw new Error("Refusing a link to another origin.");
  return link;
}

export function queueVerificationEmail(
  user: { email: string; name?: string | null },
  url: string,
) {
  const config = emailConfig();
  const link = ownLink(url, config.origin);
  link.searchParams.set("callbackURL", VERIFIED_LANDING);
  const message = verificationEmail({
    name: user.name ?? "",
    url: link.toString(),
    hours: VERIFICATION_HOURS,
  });
  enqueueEmail({
    purpose: "VERIFICATION",
    to: user.email,
    ...message,
    expiresAt: inMs(VERIFICATION_HOURS * 3600_000),
  });
  kickOutbox();
}

export function queuePasswordResetEmail(
  user: { email: string; name?: string | null },
  url: string,
) {
  const link = ownLink(url, emailConfig().origin);
  const message = passwordResetEmail({
    name: user.name ?? "",
    url: link.toString(),
    minutes: RESET_MINUTES,
  });
  enqueueEmail({
    purpose: "PASSWORD_RESET",
    to: user.email,
    ...message,
    expiresAt: inMs(RESET_MINUTES * 60_000),
  });
  kickOutbox();
}

/**
 * Queues an invitation message. Synchronous so the caller can do it inside the
 * transaction that creates the invitation (no invitation without its message,
 * no message without its invitation); the caller calls kickOutbox() after the
 * commit. Returns false when nothing was queued (e-mail disabled, or this
 * address already received the maximum per hour).
 */
export function queueInvitationEmail(input: {
  to: string;
  academyId: string;
  academyName: string;
  role: string;
  token: string;
  invitationId: string;
  expiresAt: string;
}): boolean {
  const config = emailConfig();
  if (!config.enabled) return false;
  const url = new URL("/workspace", config.origin);
  url.searchParams.set("invitation", input.token);
  const message = invitationEmail({
    academyName: input.academyName,
    role: input.role,
    url: url.toString(),
    days: INVITATION_DAYS,
  });
  return (
    enqueueEmail({
      purpose: "INVITATION",
      to: input.to,
      ...message,
      expiresAt: input.expiresAt,
      academyId: input.academyId,
      relatedId: input.invitationId,
    }) !== null
  );
}

/** Shared by the notice kinds below: queue, then start delivery. False when
 * e-mail is off or the recipient was refused (invalid, suppressed, capped). */
function queueNotice(
  purpose: "SESSION_NOTICE" | "PAYMENT_RECEIPT" | "REPORT_READY" | "NOTIFICATION",
  to: string,
  message: RenderedEmail,
  related: { academyId?: string; relatedId?: string } = {},
): boolean {
  if (!emailConfig().enabled) return false;
  const queued = enqueueEmail({
    purpose,
    to,
    ...message,
    expiresAt: inMs(NOTICE_DAYS * 86_400_000),
    ...related,
  });
  if (queued) kickOutbox();
  return queued !== null;
}
/** Where a notice links to: this deployment's own origin, never a caller's. */
function ownPath(path: string | undefined) {
  return path ? ownLink(path, emailConfig().origin).toString() : undefined;
}

/** A session or booking change. `startsAt` is a UTC instant; the message shows
 * it in the recipient's time zone when one is given, otherwise in UTC. */
export function queueSessionNotice(
  to: string,
  input: Omit<Parameters<typeof sessionNoticeEmail>[0], "url"> & {
    path?: string;
    academyId?: string;
    relatedId?: string;
  },
) {
  const { academyId, relatedId, path, ...content } = input;
  return queueNotice(
    "SESSION_NOTICE",
    to,
    sessionNoticeEmail({ ...content, url: ownPath(path) }),
    { academyId, relatedId },
  );
}

export type CancellationNoticeResult =
  "QUEUED" | "DEFERRED" | "DISABLED" | "REFUSED";
/**
 * A cancellation notice. Unlike queueSessionNotice it reports what happened, so
 * the caller can account for every recipient, and a message that would exceed
 * the per-address hourly limit is held back for later delivery instead of being
 * dropped. REFUSED means an invalid or suppressed address, or the daily ceiling.
 */
export function queueSessionCancellation(
  to: string,
  input: Omit<Parameters<typeof sessionNoticeEmail>[0], "url"> & {
    path?: string;
    academyId?: string;
    relatedId?: string;
  },
): CancellationNoticeResult {
  if (!emailConfig().enabled) return "DISABLED";
  const { academyId, relatedId, path, ...content } = input;
  const result = enqueueEmailChecked({
    purpose: "SESSION_NOTICE",
    to,
    ...sessionNoticeEmail({ ...content, url: ownPath(path) }),
    expiresAt: inMs(NOTICE_DAYS * 86_400_000),
    academyId,
    relatedId,
    onLimit: "defer",
  });
  if ("refused" in result) return "REFUSED";
  kickOutbox();
  return result.deferred ? "DEFERRED" : "QUEUED";
}

/** A payment receipt. `amountMinor` is in the minor units (paise, cents) of `currency`. */
export function queuePaymentReceipt(
  to: string,
  input: Omit<Parameters<typeof paymentReceiptEmail>[0], "url"> & {
    path?: string;
    academyId?: string;
    relatedId?: string;
  },
) {
  const { academyId, relatedId, path, ...content } = input;
  return queueNotice(
    "PAYMENT_RECEIPT",
    to,
    paymentReceiptEmail({ ...content, url: ownPath(path) }),
    { academyId, relatedId },
  );
}

/** "A report is ready": a link to the signed-in page, never the report. */
export function queueReportReady(
  to: string,
  input: Omit<Parameters<typeof reportReadyEmail>[0], "url"> & {
    path: string;
    academyId?: string;
    relatedId?: string;
  },
) {
  const { academyId, relatedId, path, ...content } = input;
  return queueNotice(
    "REPORT_READY",
    to,
    reportReadyEmail({ ...content, url: ownPath(path)! }),
    { academyId, relatedId },
  );
}

/** Any other account or academy notice. */
export function queueNotification(
  to: string,
  input: Parameters<typeof notificationEmail>[0] & {
    academyId?: string;
    relatedId?: string;
  },
) {
  const { academyId, relatedId, url, ...content } = input;
  return queueNotice(
    "NOTIFICATION",
    to,
    notificationEmail({ ...content, url: ownPath(url) }),
    { academyId, relatedId },
  );
}

/** To a platform administrator: an academy submitted (or resubmitted) its application. */
export function queueAcademySubmittedNotice(
  to: string,
  input: {
    name: string;
    academyName: string;
    resubmission: boolean;
    academyId: string;
  },
) {
  return queueNotice(
    "NOTIFICATION",
    to,
    academySubmittedEmail({
      name: input.name,
      academyName: input.academyName,
      resubmission: input.resubmission,
      url: ownPath("/platform")!,
    }),
    { academyId: input.academyId, relatedId: input.academyId },
  );
}

/** To the owner: the application was approved or rejected, or the academy was
 * suspended or reactivated. `reason` is the reviewer's written feedback. */
export function queueAcademyDecisionNotice(
  to: string,
  input: {
    name: string;
    academyName: string;
    outcome: AcademyOutcome;
    reason?: string;
    academyId: string;
  },
) {
  return queueNotice(
    "NOTIFICATION",
    to,
    academyDecisionEmail({
      name: input.name,
      academyName: input.academyName,
      outcome: input.outcome,
      reason: input.reason,
      url: ownPath(`/workspace/${input.academyId}`),
    }),
    { academyId: input.academyId, relatedId: input.academyId },
  );
}

export type { RecipientLocale };
