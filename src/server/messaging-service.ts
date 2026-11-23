import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { academyOperational } from "./academy-lifecycle-state";
import type {
  AudienceSummary,
  CommMessage,
  CommTemplate,
  DeliveryRow,
  GuardianMessage,
  MessageChannel,
  MessageData,
  MessagePreview,
  MessageRecipient,
  MessagingView,
  ShareItem,
} from "@/domain/messaging";
import { participates } from "@/domain/player-lifecycle";
import { academyDate } from "@/services/portal-records";
import { communicationRepository as comm } from "./communication-repository";
import { workspaceRepository as repo } from "./workspace-repository";
import {
  requireRole,
  requireModule,
  requireSport,
  visibleRecords,
  type WorkspaceAccess,
} from "./workspace-access";
import { atomic, audit, database } from "./database";
import { WorkspaceError } from "./auth";
import { assertGeneric, normalizedVerifiedPhone } from "./batch-announcement-service";

/**
 * Communications, the same steps as the badminton app: write, choose who and how, approve, schedule or send now, then each
 * family is listed under "Ready to send" (E-mail and WhatsApp, free, from the sender's own apps) while Portal messages show
 * in the family's app. The server never sends and never claims a message was delivered or read.
 *
 * Who may do what: the owner and admins see and approve everything; a coach writes drafts for their own players and sees
 * only their own messages. A parent who opted out of messages is never offered any channel. The wording must stay generic
 * (no child names or contact details): individual information belongs in a private conversation.
 */
const channelSchema = z.enum(["PORTAL", "EMAIL", "WHATSAPP"]);
const messageSchema = z.object({
  subject: z.string().trim().min(2).max(150),
  body: z.string().trim().min(3).max(2000),
  playerIds: z.array(z.string().min(1)).max(500),
  batchIds: z.array(z.string().min(1)).max(100),
  allBatches: z.boolean(),
  channels: z.array(channelSchema).min(1),
  templateId: z.string().nullable(),
});
type Audience = Pick<MessageData, "playerIds" | "batchIds" | "allBatches">;
const CHANNELS: MessageChannel[] = ["PORTAL", "EMAIL", "WHATSAPP"];
/** How long a processed Portal message stays on a parent's Home. */
const PORTAL_DAYS = 30;

function fail(status: number, message: string): never {
  throw new WorkspaceError(status, message);
}
function approver(ctx: WorkspaceAccess) {
  return ["OWNER", "ADMIN"].includes(ctx.membership.role);
}
function staff(ctx: WorkspaceAccess) {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH"]);
  requireModule(ctx, "update");
  requireSport(ctx, "football");
}
/** Re-reads the membership and the academy so a removed member or a paused academy is refused at once. */
function fresh(ctx: WorkspaceAccess) {
  const membership = repo.membership(ctx.academy.id, ctx.user.id),
    academy = repo.academy(ctx.academy.id);
  if (
    !membership ||
    !academy ||
    membership.role !== ctx.membership.role ||
    !academyOperational(ctx.academy.id)
  )
    fail(403, "Current academy membership required.");
  const next = { ...ctx, membership, academy };
  staff(next);
  return next;
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
const digest = (d: MessageData) =>
  createHash("sha256")
    .update(
      stable({
        subject: d.subject,
        body: d.body,
        channels: d.channels,
        recipients: d.recipients,
      }),
    )
    .digest("hex");

/** The players an audience covers: only those who take part, and only ones the sender is allowed to message. */
function coveredPlayers(ctx: WorkspaceAccess, a: Audience) {
  const visible = visibleRecords(ctx, "player").filter((p) =>
      p.sportIds.includes("football"),
    ),
    squads = visibleRecords(ctx, "squad");
  for (const id of a.playerIds)
    if (!visible.some((p) => p.id === id))
      fail(403, "Choose only players you are authorised to message.");
  for (const id of a.batchIds)
    if (!squads.some((s) => s.id === id))
      fail(403, "Choose only batches you are authorised to message.");
  const inBatch = new Set(
    squads.filter((s) => a.batchIds.includes(s.id)).flatMap((s) => s.playerIds),
  );
  return visible.filter(
    (p) =>
      participates(p.status) &&
      (a.allBatches || a.playerIds.includes(p.id) || inBatch.has(p.id)),
  );
}
type Guardian = {
  userId: string;
  name: string;
  email: string;
  playerIds: string[];
};
function guardiansOf(ctx: WorkspaceAccess, playerIds: string[]): Guardian[] {
  const wanted = new Set(playerIds);
  const out = new Map<string, Guardian>();
  const rows = database()
    .prepare(
      `SELECT g.userId AS userId, g.playerId AS playerId, u.name AS name, u.email AS email
       FROM guardian_relationships g JOIN "user" u ON u.id=g.userId WHERE g.academyId=? ORDER BY u.name, g.playerId`,
    )
    .all(ctx.academy.id);
  for (const r of rows) {
    const playerId = String(r.playerId),
      userId = String(r.userId);
    if (!wanted.has(playerId)) continue;
    if (repo.membership(ctx.academy.id, userId)?.role !== "PARENT") continue;
    // A player who signs in for themselves is not a guardian: staff messages are never addressed to a child's own login.
    if (
      database()
        .prepare("SELECT 1 FROM player_link_login WHERE academyId=? AND userId=?")
        .get(ctx.academy.id, userId)
    )
      continue;
    const entry = out.get(userId) ?? {
      userId,
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      playerIds: [],
    };
    if (!entry.playerIds.includes(playerId)) entry.playerIds.push(playerId);
    out.set(userId, entry);
  }
  return [...out.values()];
}
const optedOut = (ctx: WorkspaceAccess, userId: string) =>
  Boolean(comm.contact(ctx.academy.id, userId)?.optedOutAt);
/** The number saved for the person, else a verified one from the academy's contact record (digits only, no "+"). */
function phoneFor(academyId: string, userId: string): string | null {
  const saved = database()
    .prepare("SELECT phone FROM member_phones WHERE academyId=? AND userId=?")
    .get(academyId, userId);
  if (saved?.phone) return String(saved.phone);
  const contact = comm.contact(academyId, userId);
  const verified = contact ? normalizedVerifiedPhone(contact.phone) : undefined;
  return verified ? verified.slice(1) : null;
}

/**
 * Who a message reaches, and who could be reached on each channel. Portal needs a linked parent account; E-mail needs an
 * address; WhatsApp is offered to every parent (a missing number is added from the "Ready to send" list). A parent who has
 * opted out is left out of all channels and counted.
 */
function resolve(ctx: WorkspaceAccess, d: Audience & { channels: MessageChannel[] }) {
  const players = coveredPlayers(ctx, d),
    guardians = guardiansOf(
      ctx,
      players.map((p) => p.id),
    );
  const reach: Record<MessageChannel, number> = {
    PORTAL: 0,
    EMAIL: 0,
    WHATSAPP: 0,
  };
  let needNumber = 0,
    optedOutCount = 0;
  const recipients: MessageRecipient[] = [];
  for (const g of guardians) {
    if (optedOut(ctx, g.userId)) {
      optedOutCount++;
      continue;
    }
    const can: MessageChannel[] = ["PORTAL", "WHATSAPP"];
    if (g.email.includes("@")) can.push("EMAIL");
    for (const c of can) reach[c]++;
    if (!phoneFor(ctx.academy.id, g.userId)) needNumber++;
    const channels = CHANNELS.filter(
      (c) => d.channels.includes(c) && can.includes(c),
    );
    if (channels.length)
      recipients.push({
        userId: g.userId,
        name: g.name,
        playerIds: [...g.playerIds].sort(),
        channels,
      });
  }
  recipients.sort((a, b) => a.userId.localeCompare(b.userId));
  const audience: AudienceSummary = {
    players: players.length,
    playersWithParent: new Set(guardians.flatMap((g) => g.playerIds)).size,
    reach,
    needNumber,
    optedOut: optedOutCount,
  };
  return { recipients, audience };
}

const read = (row: Record<string, unknown>): CommMessage => ({
  id: String(row.id),
  academyId: String(row.academyId),
  version: Number(row.version),
  status: String(row.status) as CommMessage["status"],
  authorId: String(row.authorId),
  createdAt: String(row.createdAt),
  updatedAt: String(row.updatedAt),
  data: JSON.parse(String(row.data)) as MessageData,
});
const find = (academyId: string, id: string) => {
  const row = database()
    .prepare("SELECT * FROM comm_messages WHERE academyId=? AND id=?")
    .get(academyId, id);
  return row ? read(row) : undefined;
};
const store = (m: CommMessage) =>
  database()
    .prepare(
      `INSERT INTO comm_messages(id,academyId,version,status,authorId,createdAt,updatedAt,data) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,updatedAt=excluded.updatedAt,data=excluded.data`,
    )
    .run(
      m.id,
      m.academyId,
      m.version,
      m.status,
      m.authorId,
      m.createdAt,
      m.updatedAt,
      JSON.stringify(m.data),
    );
/** The messages this person may see: the owner and admins all of them, a coach only their own. */
function mine(ctx: WorkspaceAccess): CommMessage[] {
  return database()
    .prepare(
      "SELECT * FROM comm_messages WHERE academyId=? ORDER BY updatedAt DESC",
    )
    .all(ctx.academy.id)
    .map(read)
    .filter((m) => approver(ctx) || m.authorId === ctx.user.id);
}

export function messagingView(ctx: WorkspaceAccess): MessagingView {
  staff(ctx);
  const messages = mine(ctx),
    visibleIds = new Set(messages.map((m) => m.id));
  const squads = visibleRecords(ctx, "squad"),
    players = visibleRecords(ctx, "player").filter(
      (p) => p.sportIds.includes("football") && participates(p.status),
    );
  const subjects = new Map(messages.map((m) => [m.id, m.data.subject]));
  const deliveries: DeliveryRow[] = database()
    .prepare(
      `SELECT d.*, u.name AS name FROM comm_deliveries d LEFT JOIN "user" u ON u.id=d.userId
       WHERE d.academyId=? ORDER BY d.createdAt DESC LIMIT 400`,
    )
    .all(ctx.academy.id)
    .filter((r) => visibleIds.has(String(r.messageId)))
    .slice(0, 200)
    .map((r) => ({
      id: String(r.id),
      messageId: String(r.messageId),
      subject: subjects.get(String(r.messageId)) ?? "Message",
      userId: String(r.userId),
      name: String(r.name ?? ""),
      channel: String(r.channel) as MessageChannel,
      status: String(r.status) as DeliveryRow["status"],
      detail: String(r.detail ?? ""),
      createdAt: String(r.createdAt),
      openedAt: r.openedAt ? String(r.openedAt) : null,
    }));
  const templates: CommTemplate[] = database()
    .prepare(
      "SELECT id,name,subject,body FROM comm_templates WHERE academyId=? ORDER BY name",
    )
    .all(ctx.academy.id)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      subject: String(r.subject),
      body: String(r.body),
    }));
  return {
    permissions: { approve: approver(ctx), templates: approver(ctx) },
    academyName: ctx.academy.name,
    country: ctx.academy.country,
    timezone: ctx.academy.timezone,
    today: academyDate({ academy: ctx.academy }),
    messages,
    templates,
    deliveries,
    batches: squads.map((s) => ({
      id: s.id,
      name: s.name,
      players: s.playerIds.length,
    })),
    players: players.map((p) => ({ id: p.id, name: p.name })),
  };
}

export function previewMessage(ctx: WorkspaceAccess, input: unknown): MessagePreview {
  staff(ctx);
  const v = messageSchema.parse(input);
  return resolve(ctx, v);
}

export function saveMessage(ctx: WorkspaceAccess, input: unknown) {
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().nonnegative().optional(),
      action: z.enum(["save", "approve", "schedule", "revise"]),
      scheduledAt: z.string().nullable().optional(),
      data: messageSchema.optional(),
    })
    .parse(input);
  return atomic(() => {
    ctx = fresh(ctx);
    const old = v.id ? find(ctx.academy.id, v.id) : undefined;
    if (v.id && !old) fail(404, "Message unavailable.");
    if (old && !approver(ctx) && old.authorId !== ctx.user.id)
      fail(403, "You can only change messages you wrote.");
    if (old && v.version !== undefined && old.version !== v.version)
      fail(409, "This message changed. Reload before continuing.");
    const now = new Date().toISOString();
    let record: CommMessage;
    if (v.action === "save") {
      if (!v.data) fail(400, "Write the message first.");
      if (old && old.status !== "DRAFT")
        fail(409, "Revise this message first; an approved message cannot be edited.");
      assertGeneric(ctx, `${v.data.subject}\n${v.data.body}`);
      resolve(ctx, v.data); // refuses players or batches outside the sender's scope
      record = {
        id: old?.id ?? randomUUID(),
        academyId: ctx.academy.id,
        version: (old?.version ?? 0) + 1,
        status: "DRAFT",
        authorId: old?.authorId ?? ctx.user.id,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        data: {
          ...v.data,
          playerIds: [...new Set(v.data.playerIds)],
          batchIds: [...new Set(v.data.batchIds)],
          channels: CHANNELS.filter((c) => v.data!.channels.includes(c)),
          approvedBy: null,
          approvalHash: null,
          scheduledAt: null,
          processedAt: null,
          recipients: [],
        },
      };
    } else {
      if (!old) fail(400, "Save the message as a draft first.");
      record = {
        ...old,
        version: old.version + 1,
        updatedAt: now,
        data: { ...old.data },
      };
      if (v.action === "approve") {
        if (!approver(ctx))
          fail(403, "Only an owner or admin can approve a message.");
        if (old.status !== "DRAFT") fail(409, "Approve a saved draft.");
        assertGeneric(ctx, `${old.data.subject}\n${old.data.body}`);
        const resolved = resolve(ctx, old.data);
        if (!resolved.recipients.length)
          fail(
            409,
            "Nobody can receive this with the channels you ticked. Choose who it goes to, invite the parents, or tick Portal only.",
          );
        record.data.recipients = resolved.recipients;
        record.data.approvedBy = ctx.user.id;
        record.data.approvalHash = digest(record.data);
        record.status = "APPROVED";
      } else if (v.action === "schedule") {
        if (!approver(ctx))
          fail(403, "Only an owner or admin can schedule a message.");
        if (
          old.status !== "APPROVED" ||
          !old.data.approvalHash ||
          digest(old.data) !== old.data.approvalHash
        )
          fail(409, "Review and approve the exact message and recipients first.");
        if (!v.scheduledAt || !Number.isFinite(Date.parse(v.scheduledAt)))
          fail(400, "Choose a valid time.");
        record.data.scheduledAt = new Date(v.scheduledAt).toISOString();
        record.status = "SCHEDULED";
      } else {
        if (old.status === "DRAFT" || old.status === "PROCESSED")
          fail(409, "Only an approved or scheduled message can be revised.");
        record.data = {
          ...old.data,
          approvedBy: null,
          approvalHash: null,
          scheduledAt: null,
          recipients: [],
        };
        record.status = "DRAFT";
      }
    }
    store(record);
    audit(ctx.academy.id, ctx.user.id, `Message ${record.status}`, record.id);
    return record;
  });
}

/**
 * Runs the approved messages that are due. Each approved family and channel is checked again (a parent who opted out or was
 * unlinked since approval is skipped and logged). Portal rows become visible in the family's app; E-mail and WhatsApp rows
 * wait under "Ready to send" for a person to press a button. Nothing is sent from here.
 */
export function processMessages(ctx: WorkspaceAccess) {
  const out = { processed: 0, ready: 0, available: 0, skipped: 0, blocked: 0 };
  return atomic(() => {
    ctx = fresh(ctx);
    if (!approver(ctx)) fail(403, "Only an owner or admin can send messages.");
    const now = new Date().toISOString();
    const insert = database().prepare(
      `INSERT OR IGNORE INTO comm_deliveries(id,academyId,messageId,userId,channel,status,detail,createdAt) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const m of mine(ctx)) {
      if (m.status !== "SCHEDULED" || !m.data.scheduledAt || m.data.scheduledAt > now)
        continue;
      if (!m.data.approvalHash || digest(m.data) !== m.data.approvalHash) {
        out.blocked++;
        continue;
      }
      const eligible = new Map(
        resolve(ctx, m.data).recipients.map((r) => [r.userId, r.channels]),
      );
      for (const r of m.data.recipients)
        for (const channel of r.channels) {
          const ok = eligible.get(r.userId)?.includes(channel);
          const status = !ok
            ? "SKIPPED"
            : channel === "PORTAL"
              ? "AVAILABLE"
              : "READY_TO_SHARE";
          insert.run(
            randomUUID(),
            ctx.academy.id,
            m.id,
            r.userId,
            channel,
            status,
            ok
              ? channel === "PORTAL"
                ? "Visible in the family’s app."
                : "Nothing has been sent yet. Use the button in Ready to send."
              : "No longer eligible when processed (opted out or no longer linked).",
            now,
          );
          if (!ok) out.skipped++;
          else if (channel === "PORTAL") out.available++;
          else out.ready++;
        }
      const next: CommMessage = {
        ...m,
        version: m.version + 1,
        status: "PROCESSED",
        updatedAt: now,
        data: { ...m.data, processedAt: now },
      };
      store(next);
      audit(ctx.academy.id, ctx.user.id, "Message PROCESSED", m.id);
      out.processed++;
    }
    return out;
  });
}

/** The families to message by E-mail or WhatsApp: one row each, with the text ready. Staff only. */
export function shareList(ctx: WorkspaceAccess): { items: ShareItem[] } {
  staff(ctx);
  const visible = new Map(mine(ctx).map((m) => [m.id, m]));
  const rows = database()
    .prepare(
      `SELECT d.*, u.name AS name, u.email AS email FROM comm_deliveries d LEFT JOIN "user" u ON u.id=d.userId
       WHERE d.academyId=? AND d.channel IN ('EMAIL','WHATSAPP') AND d.status IN ('READY_TO_SHARE','OPENED')
       ORDER BY d.createdAt DESC, u.name LIMIT 400`,
    )
    .all(ctx.academy.id);
  const items: ShareItem[] = [];
  for (const r of rows) {
    const m = visible.get(String(r.messageId));
    if (!m) continue;
    const userId = String(r.userId),
      channel = String(r.channel) as ShareItem["channel"];
    items.push({
      id: String(r.id),
      messageId: m.id,
      userId,
      channel,
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      phone: channel === "WHATSAPP" ? phoneFor(ctx.academy.id, userId) : null,
      subject: m.data.subject,
      body: m.data.body,
      status: String(r.status) as ShareItem["status"],
    });
  }
  audit(ctx.academy.id, ctx.user.id, "Ready to send list opened");
  return { items };
}

/** Records that a button was pressed. It never means the message was sent, delivered or read. */
export function markOpened(ctx: WorkspaceAccess, id: string) {
  staff(ctx);
  const row = database()
    .prepare("SELECT messageId FROM comm_deliveries WHERE academyId=? AND id=?")
    .get(ctx.academy.id, id);
  const m = row ? find(ctx.academy.id, String(row.messageId)) : undefined;
  if (!m || (!approver(ctx) && m.authorId !== ctx.user.id))
    fail(404, "Message unavailable.");
  database()
    .prepare(
      "UPDATE comm_deliveries SET status='OPENED',openedAt=? WHERE academyId=? AND id=? AND status='READY_TO_SHARE'",
    )
    .run(new Date().toISOString(), ctx.academy.id, id);
  return { ok: true };
}

export function saveTemplate(ctx: WorkspaceAccess, input: unknown) {
  const v = z
    .object({
      name: z.string().trim().min(2).max(80),
      subject: z.string().trim().min(2).max(150),
      body: z.string().trim().min(3).max(2000),
    })
    .parse(input);
  return atomic(() => {
    ctx = fresh(ctx);
    if (!approver(ctx))
      fail(403, "Only an owner or admin can create templates.");
    assertGeneric(ctx, `${v.subject}\n${v.body}`);
    const template = { id: randomUUID(), ...v };
    database()
      .prepare(
        "INSERT INTO comm_templates(id,academyId,name,subject,body,createdAt,createdBy) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        template.id,
        ctx.academy.id,
        v.name,
        v.subject,
        v.body,
        new Date().toISOString(),
        ctx.user.id,
      );
    audit(ctx.academy.id, ctx.user.id, "Message template created", template.id);
    return template;
  });
}

/** What a parent reads in the app: processed Portal messages for their own children, for a month. */
export function guardianMessages(
  ctx: WorkspaceAccess,
  now = new Date(),
): GuardianMessage[] {
  requireRole(ctx, ["PARENT"]);
  requireModule(ctx, "update");
  requireSport(ctx, "football");
  const children = new Set(
    database()
      .prepare(
        "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
      )
      .all(ctx.academy.id, ctx.user.id)
      .map((l) => String(l.playerId))
      .filter((id) => {
        const child = repo.find(ctx.academy.id, "player", id);
        return child?.sportIds.includes("football") && participates(child.status);
      }),
  );
  if (!children.size) return [];
  const since = new Date(now.getTime() - PORTAL_DAYS * 86400000).toISOString();
  const shown = new Set(
    database()
      .prepare(
        "SELECT messageId FROM comm_deliveries WHERE academyId=? AND userId=? AND channel='PORTAL' AND status='AVAILABLE'",
      )
      .all(ctx.academy.id, ctx.user.id)
      .map((r) => String(r.messageId)),
  );
  return database()
    .prepare(
      "SELECT * FROM comm_messages WHERE academyId=? AND status='PROCESSED' ORDER BY updatedAt DESC",
    )
    .all(ctx.academy.id)
    .map(read)
    .filter(
      (m) =>
        shown.has(m.id) &&
        (m.data.processedAt ?? m.updatedAt) >= since &&
        m.data.recipients.some(
          (r) =>
            r.userId === ctx.user.id &&
            r.channels.includes("PORTAL") &&
            r.playerIds.some((id) => children.has(id)),
        ),
    )
    .map((m) => ({
      id: m.id,
      title: m.data.subject,
      body: m.data.body,
      at: m.data.processedAt ?? m.updatedAt,
    }));
}
