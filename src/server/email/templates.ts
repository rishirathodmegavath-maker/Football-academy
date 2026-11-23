// Every message the application sends is built here, from one layout, in two
// forms: plain text (always) and HTML (for mail programs that show it). Secrets
// appear only in the link in the body, never in the subject, and every message
// that carries a link says how long it works and what to do if the recipient
// did not ask for it. Text is UTF-8 and may be in any script: names are placed
// as given (control characters removed), never transliterated or guessed.
import { headerSafe } from "./address";
import { formatInstant, formatMoney, type RecipientLocale } from "./format";

export type RenderedEmail = { subject: string; text: string; html: string };

type Content = {
  subject: string;
  name?: string;
  /** Paragraphs before the action. */
  intro: string[];
  /** The one link or button the message is about. */
  action?: { label: string; url: string };
  /** Label/value rows (a receipt, a session). */
  details?: [string, string][];
  /** Paragraphs after the action. */
  outro?: string[];
};

const FOOTER =
  "Sportozen Academy\nThis is an automated message; replies are not read.";
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const greeting = (name?: string) =>
  `Hello ${headerSafe(name ?? "") || "there"},`;

function toText(c: Content) {
  const parts = [greeting(c.name), ...c.intro];
  if (c.action) parts.push(c.action.url);
  if (c.details?.length)
    parts.push(
      c.details.map(([label, value]) => `${label}: ${value}`).join("\n"),
    );
  parts.push(...(c.outro ?? []));
  return `${parts.join("\n\n")}\n\n${FOOTER}\n`;
}

function toHtml(c: Content) {
  const p = (text: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#0f172a">${escapeHtml(text)}</p>`;
  const rows = (c.details ?? [])
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#475569;font-size:14px">${escapeHtml(label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const button = c.action
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(c.action.url)}" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 22px;border-radius:8px">${escapeHtml(c.action.label)}</a></p><p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#475569;word-break:break-all">${escapeHtml(c.action.url)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Noto Sans','Segoe UI',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0f172a;padding:18px 28px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.02em">Sportozen <span style="color:#4ade80">ACADEMY</span></td></tr>
<tr><td style="padding:28px">${p(greeting(c.name))}${c.intro.map(p).join("")}${button}${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows}</table>` : ""}${(c.outro ?? []).map(p).join("")}</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.5">Sportozen Academy<br>This is an automated message; replies are not read.</td></tr>
</table></td></tr></table></body></html>`;
}

function render(c: Content): RenderedEmail {
  return { subject: headerSafe(c.subject), text: toText(c), html: toHtml(c) };
}

export function verificationEmail(input: {
  name: string;
  url: string;
  hours: number;
}): RenderedEmail {
  return render({
    subject: "Confirm your Sportozen Academy email address",
    name: input.name,
    intro: [
      "Confirm this email address to finish setting up your Sportozen Academy account:",
    ],
    action: { label: "Confirm email address", url: input.url },
    outro: [
      `The link works for ${input.hours} hours. If you did not create an account, you can ignore this message; nothing will happen.`,
    ],
  });
}

export function passwordResetEmail(input: {
  name: string;
  url: string;
  minutes: number;
}): RenderedEmail {
  return render({
    subject: "Reset your Sportozen Academy password",
    name: input.name,
    intro: [
      "We received a request to reset the password for your Sportozen Academy account. Choose a new password here:",
    ],
    action: { label: "Choose a new password", url: input.url },
    outro: [
      `The link works once and expires in ${input.minutes} minutes. If you did not ask for this, ignore this message: your password has not changed. Signing in again also stays possible with your current password.`,
    ],
  });
}

const ROLE_WORDS: Record<string, string> = {
  OWNER: "the owner",
  ADMIN: "an administrator",
  COACH: "a coach",
  PARENT: "a parent or guardian",
  PLAYER: "a player",
  SUPPORT: "a support reviewer",
};
export function invitationEmail(input: {
  academyName: string;
  role: string;
  url: string;
  days: number;
}): RenderedEmail {
  const academy = headerSafe(input.academyName);
  return render({
    subject: `You are invited to ${academy} on Sportozen Academy`,
    intro: [
      `You have been invited to join ${academy} on Sportozen Academy as ${ROLE_WORDS[input.role] ?? "a member"}.`,
      "To accept, sign in (or create an account) with THIS email address, then open:",
    ],
    action: { label: "Open the invitation", url: input.url },
    outro: [
      `The invitation can be used once and expires in ${input.days} days. If you were not expecting it, you can ignore this message; no access is granted until you accept.`,
    ],
  });
}

/** A session or booking notice: when, where, what changed. */
export function sessionNoticeEmail(
  input: {
    name: string;
    academyName: string;
    headline: string;
    startsAt: string;
    place?: string;
    url?: string;
  } & RecipientLocale,
): RenderedEmail {
  const details: [string, string][] = [
    ["When", formatInstant(input.startsAt, input)],
  ];
  if (input.place) details.push(["Where", headerSafe(input.place)]);
  return render({
    subject: `${headerSafe(input.headline)} - ${headerSafe(input.academyName)}`,
    name: input.name,
    intro: [
      `${headerSafe(input.headline)} at ${headerSafe(input.academyName)}.`,
    ],
    details,
    action: input.url
      ? { label: "Open in Sportozen", url: input.url }
      : undefined,
    outro: [
      "Times are shown in your time zone where one is set, otherwise in UTC.",
    ],
  });
}

/** A payment receipt. The amount is in minor units (paise, cents) of its currency. */
export function paymentReceiptEmail(
  input: {
    name: string;
    academyName: string;
    receiptNumber: string;
    amountMinor: number;
    currency: string;
    paidAt: string;
    url?: string;
  } & RecipientLocale,
): RenderedEmail {
  return render({
    subject: `Payment received - ${headerSafe(input.academyName)}`,
    name: input.name,
    intro: [
      `${headerSafe(input.academyName)} has recorded your payment. Thank you.`,
    ],
    details: [
      ["Receipt", headerSafe(input.receiptNumber)],
      ["Amount", formatMoney(input.amountMinor, input.currency, input)],
      ["Paid", formatInstant(input.paidAt, input)],
    ],
    action: input.url
      ? { label: "View the receipt", url: input.url }
      : undefined,
  });
}

/** A report is ready: a link to a signed-in page, never the report itself. */
export function reportReadyEmail(input: {
  name: string;
  academyName: string;
  reportTitle: string;
  url: string;
}): RenderedEmail {
  return render({
    subject: `A report is ready - ${headerSafe(input.academyName)}`,
    name: input.name,
    intro: [
      `${headerSafe(input.reportTitle)} from ${headerSafe(input.academyName)} is ready. Sign in to read it.`,
    ],
    action: { label: "Open the report", url: input.url },
    outro: ["The report itself is not attached to this message."],
  });
}

/** Any other account or academy notice. */
export function notificationEmail(input: {
  name: string;
  subject: string;
  paragraphs: string[];
  url?: string;
  actionLabel?: string;
}): RenderedEmail {
  return render({
    subject: input.subject,
    name: input.name,
    intro: input.paragraphs,
    action: input.url
      ? { label: input.actionLabel ?? "Open Sportozen", url: input.url }
      : undefined,
  });
}

/** To a platform administrator: an academy asked for approval. */
export function academySubmittedEmail(input: {
  name: string;
  academyName: string;
  resubmission: boolean;
  url: string;
}): RenderedEmail {
  const academy = headerSafe(input.academyName);
  return render({
    subject: `${input.resubmission ? "Resubmitted" : "New"} academy application - ${academy}`,
    name: input.name,
    intro: [
      `${academy} ${input.resubmission ? "has updated and resubmitted" : "has submitted"} its application for approval.`,
    ],
    action: { label: "Open the review queue", url: input.url },
  });
}

export type AcademyOutcome = "approved" | "rejected" | "suspended" | "reactivated";
const OUTCOME_TEXT: Record<AcademyOutcome, { subject: string; line: string }> = {
  approved: {
    subject: "Your academy was approved",
    line: "has been approved. Players, batches, sessions, fees and messages are now open.",
  },
  rejected: {
    subject: "Your academy application was not approved",
    line: "was not approved yet. Please read the feedback, update your academy profile and submit it again.",
  },
  suspended: {
    subject: "Your academy was suspended",
    line: "has been suspended. Nobody in the academy can use it until it is reactivated.",
  },
  reactivated: {
    subject: "Your academy was reactivated",
    line: "has been reactivated and is open again.",
  },
};
/** To the academy owner: a decision on the application or a suspension. */
export function academyDecisionEmail(input: {
  name: string;
  academyName: string;
  outcome: AcademyOutcome;
  reason?: string;
  url?: string;
}): RenderedEmail {
  const academy = headerSafe(input.academyName),
    text = OUTCOME_TEXT[input.outcome];
  return render({
    subject: `${text.subject} - ${academy}`,
    name: input.name,
    intro: [`${academy} ${text.line}`],
    details: input.reason
      ? [["Feedback from Sportozen", headerSafe(input.reason)]]
      : undefined,
    action: input.url
      ? { label: "Open your academy", url: input.url }
      : undefined,
  });
}
