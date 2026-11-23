import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { FootballSession } from "@/domain/training";
import { buildIcs, type IcsEvent } from "@/services/calendar-ics";
import { database, audit } from "./database";
import { workspaceRepository as repo } from "./workspace-repository";
import { academyOperational } from "./academy-lifecycle-state";
import { WorkspaceError } from "./auth";
import { parentSchedule } from "./parent-schedule-service";
import {
  moduleEnabled,
  visibleRecords,
  type WorkspaceAccess,
} from "./workspace-access";
import { enforceRateLimit, type RateLimit } from "./rate-limit";

/**
 * A private calendar link for each person: coaches see the sessions they run, owners and admins every session, and a
 * parent only the sessions their own child is on. The link is a read-only subscription (webcal): once it is added to
 * Google, Apple or Outlook calendar, new, changed and cancelled sessions follow by themselves, with the drills in the
 * description. It is free and uses no account with Google or anyone else.
 *
 * Safety:
 *  - The secret is 32 random bytes; only its SHA-256 is stored. A new link replaces the old one, which stops working.
 *  - The feed is rebuilt from the same visibility rules as the app on every request, and it stops with the person's
 *    membership, the academy's suspension, or its loss of approval.
 *  - Staff events never carry a player's name (a calendar lives in a third-party service); a parent's events carry only
 *    their own child's first name. No private note or objective is ever included.
 *  - A wrong link answers 404 and writes nothing.
 */
export const FEED_LIMIT: RateLimit = {
  name: "calendar-feed",
  max: 240,
  windowSeconds: 3600,
};
const PAST_DAYS = 14;
const CANCELLED_STAFF_DAYS = 7;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Creates (or replaces) this person's calendar link and returns the secret once. */
export function issueCalendarToken(ctx: WorkspaceAccess): { token: string } {
  if (ctx.membership.role === "SUPPORT")
    throw new WorkspaceError(403, "A calendar link is not available for this role.");
  const token = randomBytes(32).toString("base64url");
  database()
    .prepare(
      "INSERT INTO calendar_feeds(academyId,userId,tokenHash,createdAt) VALUES(?,?,?,?) ON CONFLICT(academyId,userId) DO UPDATE SET tokenHash=excluded.tokenHash, createdAt=excluded.createdAt",
    )
    .run(ctx.academy.id, ctx.user.id, hash(token), new Date().toISOString());
  audit(ctx.academy.id, ctx.user.id, "Calendar link created", ctx.user.id);
  return { token };
}

export function hasCalendarLink(ctx: WorkspaceAccess): boolean {
  return !!database()
    .prepare("SELECT 1 FROM calendar_feeds WHERE academyId=? AND userId=?")
    .get(ctx.academy.id, ctx.user.id);
}

function agendaText(session: FootballSession): string {
  if (!session.agenda?.length) return "";
  return (
    "Drills:\n" +
    session.agenda
      .map(
        (item, i) =>
          `${i + 1}. ${item.drill.name}${item.duration ? ` (${item.duration} min)` : ""}`,
      )
      .join("\n")
  );
}

function batchName(academyId: string, session: FootballSession) {
  return repo.find(academyId, "squad", session.squadId)?.name ?? "Training";
}

function staffEvent(
  academyId: string,
  academyName: string,
  session: FootballSession,
): IcsEvent {
  const batch = batchName(academyId, session),
    cancelled = session.status === "CANCELLED";
  const description = [
    `${batch} · ${session.roster.length} player${session.roster.length === 1 ? "" : "s"}`,
    cancelled ? "This session was cancelled." : agendaText(session),
    academyName,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    uid: `${session.id}@sportozen`,
    title: `${cancelled ? "Cancelled: " : ""}${session.title?.trim() || `${batch} training`}`,
    startAt: session.startAt,
    endAt: session.endAt,
    location: session.location,
    description,
    status: cancelled ? "CANCELLED" : "CONFIRMED",
    sequence: session.version,
    updatedAt: session.updatedAt,
  };
}

/** The events this person may see, from the same rules the app uses. */
export function calendarEventsFor(ctx: WorkspaceAccess): IcsEvent[] {
  const academyId = ctx.academy.id,
    now = Date.now(),
    since = now - PAST_DAYS * 86_400_000;
  if (!moduleEnabled(ctx, "session")) return [];
  if (ctx.membership.role === "PARENT") {
    const rows = parentSchedule(ctx).filter(
      (s) => Date.parse(s.endAt) >= since,
    );
    const bySession = new Map<string, typeof rows>();
    for (const row of rows)
      bySession.set(row.id, [...(bySession.get(row.id) ?? []), row]);
    const events: IcsEvent[] = [];
    for (const [id, group] of bySession) {
      const session = repo.find(academyId, "session", id);
      if (!session) continue;
      const names = [
        ...new Set(
          group.map((g) =>
            (repo.find(academyId, "player", g.childId)?.name ?? "")
              .trim()
              .split(/\s+/)[0],
          ),
        ),
      ].filter(Boolean);
      const first = group[0],
        cancelled = first.status === "CANCELLED";
      events.push({
        uid: `${session.id}@sportozen`,
        title: `${cancelled ? "Cancelled: " : ""}${names.join(" & ")}${names.length ? " – " : ""}${first.batchName} training`,
        startAt: first.startAt,
        endAt: first.endAt,
        location: first.location,
        description: [
          cancelled ? "This session was cancelled." : agendaText(session),
          ctx.academy.name,
        ]
          .filter(Boolean)
          .join("\n\n"),
        status: cancelled ? "CANCELLED" : "CONFIRMED",
        sequence: session.version,
        updatedAt: session.updatedAt,
      });
    }
    return events;
  }
  return visibleRecords(ctx, "session")
    .filter((s) => {
      if (s.status === "DRAFT") return false;
      if (s.status === "CANCELLED")
        return (
          (s.cancelledFrom === "SCHEDULED" ||
            s.cancelledFrom === "IN_PROGRESS") &&
          Date.parse(s.endAt) >= now - CANCELLED_STAFF_DAYS * 86_400_000
        );
      return Date.parse(s.endAt) >= since;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((s) => staffEvent(academyId, ctx.academy.name, s));
}

/** The calendar text for a link secret, or null when the link is not valid (or no longer is). */
export function calendarFeed(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const row = database()
    .prepare("SELECT academyId,userId FROM calendar_feeds WHERE tokenHash=?")
    .get(hash(token));
  if (!row) return null;
  const academyId = String(row.academyId),
    userId = String(row.userId),
    membership = repo.membership(academyId, userId),
    academy = repo.academy(academyId);
  if (!membership || !academy || membership.role === "SUPPORT") return null;
  if (!academyOperational(academyId)) return null;
  enforceRateLimit(userId, FEED_LIMIT);
  const user = database()
    .prepare('SELECT id,name,email FROM "user" WHERE id=?')
    .get(userId);
  if (!user) return null;
  const ctx = {
    user: { id: userId, name: String(user.name ?? ""), email: String(user.email ?? "") },
    membership,
    academy,
  } as unknown as WorkspaceAccess;
  return buildIcs(`${academy.name} – training`, calendarEventsFor(ctx));
}
