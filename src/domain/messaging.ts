/**
 * Communications (announcements to families). The same steps as the badminton app: write, choose who and how, approve,
 * schedule or send now, then each family appears under "Ready to send" for E-mail and WhatsApp (free, from the sender's own
 * apps) while Portal messages show in the family's app. Nothing here ever claims a message was delivered or read.
 */
export type MessageChannel = "PORTAL" | "EMAIL" | "WHATSAPP";
export type MessageStatus = "DRAFT" | "APPROVED" | "SCHEDULED" | "PROCESSED";

export interface MessageRecipient {
  userId: string;
  name: string;
  playerIds: string[];
  channels: MessageChannel[];
}
export interface MessageData {
  subject: string;
  body: string;
  playerIds: string[];
  batchIds: string[];
  allBatches: boolean;
  channels: MessageChannel[];
  templateId: string | null;
  approvedBy: string | null;
  approvalHash: string | null;
  scheduledAt: string | null;
  processedAt: string | null;
  /** Frozen at approval: the families this message goes to and the channels each agreed to. */
  recipients: MessageRecipient[];
}
export interface CommMessage {
  id: string;
  academyId: string;
  version: number;
  status: MessageStatus;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  data: MessageData;
}
export interface CommTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}
/** Who a message would reach, before any channel is chosen. */
export interface AudienceSummary {
  /** Players the audience covers (only those who take part). */
  players: number;
  /** Of those, how many have a parent account linked. */
  playersWithParent: number;
  /** Distinct parents who can be offered each channel (a parent who opted out is in none). */
  reach: Record<MessageChannel, number>;
  /** Parents with no WhatsApp number saved yet: they can still be messaged once a number is added. */
  needNumber: number;
  /** Parents left out because they opted out of messages. */
  optedOut: number;
}
export interface MessagePreview {
  recipients: MessageRecipient[];
  audience: AudienceSummary;
}
export interface DeliveryRow {
  id: string;
  messageId: string;
  subject: string;
  userId: string;
  name: string;
  channel: MessageChannel;
  /** AVAILABLE (Portal), READY_TO_SHARE, OPENED, or SKIPPED (no longer eligible when processed). */
  status: "AVAILABLE" | "READY_TO_SHARE" | "OPENED" | "SKIPPED";
  detail: string;
  createdAt: string;
  openedAt: string | null;
}
export interface ShareItem {
  id: string;
  messageId: string;
  userId: string;
  channel: Exclude<MessageChannel, "PORTAL">;
  name: string;
  email: string;
  phone: string | null;
  subject: string;
  body: string;
  status: "READY_TO_SHARE" | "OPENED";
}
export interface MessagingView {
  permissions: { approve: boolean; templates: boolean };
  academyName: string;
  country: string;
  timezone: string;
  /** Academy-local date, YYYY-MM-DD. */
  today: string;
  messages: CommMessage[];
  templates: CommTemplate[];
  deliveries: DeliveryRow[];
  batches: { id: string; name: string; players: number }[];
  players: { id: string; name: string }[];
}
/** What a parent reads in the app for a processed Portal message (the same shape as an announcement, plus a title). */
export interface GuardianMessage {
  id: string;
  title: string;
  body: string;
  at: string;
}
