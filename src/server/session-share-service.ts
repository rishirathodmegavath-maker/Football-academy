import "server-only";
import { z } from "zod";
import { isArchived } from "@/domain/player-lifecycle";
import { COUNTRY_CALLING_CODE, normalizePhone } from "@/services/share-links";
import { database, audit } from "./database";
import { WorkspaceError } from "./auth";
import { workspaceRepository as repo } from "./workspace-repository";
import {
  requireRole,
  visibleRecord,
  type WorkspaceAccess,
} from "./workspace-access";

/**
 * "Tell everyone about this session", for free. The server only lists who is in the session and how to reach them: the
 * coaches running it, and the parents of the players on it. The person sending presses a button per row, their own
 * WhatsApp or mail app opens with the message ready, and they press Send. Nothing is sent from here, and nothing here
 * claims a message was delivered.
 *
 * Who may ask: the owner, an admin, or a coach who is assigned to the session (the same rule that lets them open it).
 * A parent's e-mail address and number are shown only to those people, only for a session they may open.
 */
export type ShareTarget = {
  userId: string;
  role: "COACH" | "PARENT";
  name: string;
  email: string;
  phone: string | null;
  /** First names of the children on this session (parents only). */
  children: string[];
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function sessionShare(ctx: WorkspaceAccess, sessionId: string) {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH"]);
  const session = visibleRecord(ctx, "session", sessionId),
    academyId = ctx.academy.id,
    now = new Date().toISOString();
  if (session.status === "DRAFT")
    throw new WorkspaceError(
      409,
      "This session is still a draft. Confirm it before telling anyone.",
    );
  const phones = new Map(
    database()
      .prepare("SELECT userId,phone FROM member_phones WHERE academyId=?")
      .all(academyId)
      .map((r) => [String(r.userId), String(r.phone)] as const),
  );
  const people = new Map<string, ShareTarget>();
  const add = (
    userId: string,
    role: ShareTarget["role"],
    name: string,
    email: string,
    child?: string,
  ) => {
    const entry = people.get(userId) ?? {
      userId,
      role,
      name,
      email,
      phone: phones.get(userId) ?? null,
      children: [],
    };
    if (child && !entry.children.includes(child)) entry.children.push(child);
    people.set(userId, entry);
  };
  for (const coachId of session.coachIds) {
    const row = database()
      .prepare(
        `SELECT u.name AS name, u.email AS email FROM academy_memberships m JOIN "user" u ON u.id=m.userId
         WHERE m.academyId=? AND m.userId=? AND m.active=1 AND (m.expiresAt IS NULL OR m.expiresAt>?)`,
      )
      .get(academyId, coachId, now);
    if (row) add(coachId, "COACH", String(row.name ?? ""), String(row.email ?? ""));
  }
  const wanted = [...new Set(session.roster.map((p) => p.playerId))];
  for (const playerId of wanted) {
    const player = repo.find(academyId, "player", playerId);
    // Archived players are not told about new sessions.
    if (!player || isArchived(player.status)) continue;
    const rows = database()
      .prepare(
        `SELECT g.userId AS userId, u.name AS name, u.email AS email
         FROM guardian_relationships g
         JOIN academy_memberships m ON m.academyId=g.academyId AND m.userId=g.userId AND m.role='PARENT' AND m.active=1 AND (m.expiresAt IS NULL OR m.expiresAt>?)
         JOIN "user" u ON u.id=g.userId
         WHERE g.academyId=? AND g.playerId=? AND NOT EXISTS (SELECT 1 FROM player_link_login pl WHERE pl.academyId=g.academyId AND pl.userId=g.userId)`,
      )
      .all(now, academyId, playerId);
    for (const row of rows)
      add(
        String(row.userId),
        "PARENT",
        String(row.name ?? ""),
        String(row.email ?? ""),
        firstName(player.name),
      );
  }
  const batch = repo.find(academyId, "squad", session.squadId)?.name ?? "Training";
  return {
    academyName: ctx.academy.name,
    country: ctx.academy.country,
    session: {
      id: session.id,
      status: session.status,
      title: session.title?.trim() || `${batch} training`,
      batch,
      startAt: session.startAt,
      endAt: session.endAt,
      timezone: session.timezone,
      location: session.location,
      drills: (session.agenda ?? []).map((a) => ({
        name: a.drill.name,
        minutes: a.duration,
      })),
    },
    people: [...people.values()].sort(
      (a, b) =>
        (a.role === b.role ? 0 : a.role === "COACH" ? -1 : 1) ||
        a.name.localeCompare(b.name),
    ),
  };
}

/**
 * The parents who may be told about one approved report. Only an approved report can be shared (a draft or a withdrawn
 * report has no snapshot to send), only by someone who may open it, and the message carries no clinical or private
 * content: the report itself is a PDF the sender attaches, or a private page the parent signs in to read.
 */
export function reportShare(ctx: WorkspaceAccess, reportId: string) {
  requireRole(ctx, ["OWNER", "ADMIN", "COACH"]);
  const report = visibleRecord(ctx, "report", reportId),
    academyId = ctx.academy.id;
  if (report.status !== "Approved" || !report.snapshot)
    throw new WorkspaceError(
      409,
      "Only an approved report can be shared with a parent.",
    );
  const player = repo.find(academyId, "player", report.playerId);
  if (!player) throw new WorkspaceError(404, "Player not found.");
  const phones = new Map(
    database()
      .prepare("SELECT userId,phone FROM member_phones WHERE academyId=?")
      .all(academyId)
      .map((r) => [String(r.userId), String(r.phone)] as const),
  );
  const parents = database()
    .prepare(
      `SELECT g.userId AS userId, u.name AS name, u.email AS email
       FROM guardian_relationships g
       JOIN academy_memberships m ON m.academyId=g.academyId AND m.userId=g.userId AND m.role='PARENT' AND m.active=1 AND (m.expiresAt IS NULL OR m.expiresAt>?)
       JOIN "user" u ON u.id=g.userId
       WHERE g.academyId=? AND g.playerId=? AND NOT EXISTS (SELECT 1 FROM player_link_login pl WHERE pl.academyId=g.academyId AND pl.userId=g.userId)
       ORDER BY u.name`,
    )
    .all(new Date().toISOString(), academyId, report.playerId)
    .map((r) => ({
      userId: String(r.userId),
      role: "PARENT" as const,
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      phone: phones.get(String(r.userId)) ?? null,
      children: [firstName(player.name)],
    }));
  audit(academyId, ctx.user.id, "Report share list opened", report.id);
  return {
    academyName: ctx.academy.name,
    country: ctx.academy.country,
    report: {
      id: report.id,
      period: report.period,
      childFirstName: firstName(player.name),
    },
    people: parents,
  };
}

const phoneInput = z.object({
  userId: z.string().min(1),
  phone: z.string().max(40),
});

/**
 * Saves (or, when empty, removes) a person's WhatsApp number. The owner or an admin may set it for anyone in the
 * academy; a coach may set it for the parents of a session they run; anyone may set their own.
 */
export function setMemberPhone(ctx: WorkspaceAccess, input: unknown) {
  const v = phoneInput.parse(input),
    academyId = ctx.academy.id;
  const member = repo.membership(academyId, v.userId);
  if (!member)
    throw new WorkspaceError(404, "That person is not a member of this academy.");
  const own = v.userId === ctx.user.id,
    manager = ["OWNER", "ADMIN"].includes(ctx.membership.role);
  if (!own && !manager) {
    // A coach may add a number for a parent of a child they coach.
    if (ctx.membership.role !== "COACH" || member.role !== "PARENT")
      throw new WorkspaceError(403, "You cannot change this person's number.");
    const children = database()
      .prepare(
        "SELECT playerId FROM guardian_relationships WHERE academyId=? AND userId=?",
      )
      .all(academyId, v.userId)
      .map((r) => String(r.playerId));
    const coaches = children.some(
      (id) => repo.find(academyId, "player", id)?.coachId === ctx.user.id,
    );
    if (!coaches)
      throw new WorkspaceError(403, "You cannot change this person's number.");
  }
  if (!v.phone.trim()) {
    database()
      .prepare("DELETE FROM member_phones WHERE academyId=? AND userId=?")
      .run(academyId, v.userId);
    audit(academyId, ctx.user.id, "Phone number removed", v.userId);
    return { phone: null };
  }
  const digits = normalizePhone(
    v.phone,
    COUNTRY_CALLING_CODE[ctx.academy.country] ?? null,
  );
  if (!digits)
    throw new WorkspaceError(
      400,
      "Enter the number with its country code, for example +91 98765 43210.",
    );
  database()
    .prepare(
      "INSERT INTO member_phones(academyId,userId,phone,updatedAt,updatedBy) VALUES(?,?,?,?,?) ON CONFLICT(academyId,userId) DO UPDATE SET phone=excluded.phone, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy",
    )
    .run(academyId, v.userId, digits, new Date().toISOString(), ctx.user.id);
  audit(academyId, ctx.user.id, "Phone number saved", v.userId);
  return { phone: digits };
}

/** The signed-in person's own saved WhatsApp number (digits), or null. Read on demand by the Account tab. */
export function myPhone(ctx: WorkspaceAccess) {
  const row = database()
    .prepare("SELECT phone FROM member_phones WHERE academyId=? AND userId=?")
    .get(ctx.academy.id, ctx.user.id) as { phone: string } | undefined;
  return { phone: row?.phone ?? null };
}
