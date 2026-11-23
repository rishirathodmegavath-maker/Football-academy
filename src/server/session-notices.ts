import "server-only";
import type {
  FootballSeries,
  FootballSession,
  NoticeReport,
} from "@/domain/training";
import { database } from "./database";
import { log } from "./log";
import { emailConfig, queueSessionCancellation } from "./email";
import { workspaceRepository as repo } from "./workspace-repository";

/**
 * Cancellation notices to guardians, through the e-mail outbox (purpose
 * SESSION_NOTICE). Rules:
 *
 * - Only a session a parent could see (it was SCHEDULED or IN_PROGRESS) is
 *   announced; cancelling a draft tells nobody.
 * - One notice per guardian per cancelled session, and one summary per
 *   guardian for a whole series, however many children they have in it.
 * - Duplicate prevention is a check-then-insert on the outbox row's
 *   `relatedId` + address. Callers run inside the training transaction, which
 *   holds the database write lock, so two cancellations cannot both pass the
 *   check. No separate unique index is needed.
 * - A refused, deferred or skipped recipient is counted in the report; nothing
 *   is dropped silently. Mail never blocks or undoes the cancellation itself.
 */
type Recipient = { userId: string; name: string; email: string };

const SESSION_KEY = (sessionId: string) => `session-cancel:${sessionId}`;
const SERIES_KEY = (seriesId: string) => `series-cancel:${seriesId}`;

/** Active parent accounts linked to any of these players, with the players. */
function guardiansOf(academyId: string, playerIds: string[]) {
  const wanted = [...new Set(playerIds)];
  if (!wanted.length)
    return new Map<string, Recipient & { playerIds: Set<string> }>();
  const now = new Date().toISOString();
  const rows = database()
    .prepare(
      `SELECT g.userId AS userId, g.playerId AS playerId, u.name AS name, u.email AS email
       FROM guardian_relationships g
       JOIN academy_memberships m ON m.academyId=g.academyId AND m.userId=g.userId AND m.role='PARENT' AND m.active=1 AND (m.expiresAt IS NULL OR m.expiresAt>?)
       JOIN "user" u ON u.id=g.userId
       WHERE g.academyId=? AND g.playerId IN (${wanted.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM player_link_login pl WHERE pl.academyId=g.academyId AND pl.userId=g.userId)
       ORDER BY g.userId, g.playerId`,
    )
    .all(now, academyId, ...wanted);
  const result = new Map<string, Recipient & { playerIds: Set<string> }>();
  for (const row of rows) {
    const id = String(row.userId),
      entry = result.get(id) ?? {
        userId: id,
        name: String(row.name ?? ""),
        email: String(row.email ?? ""),
        playerIds: new Set<string>(),
      };
    entry.playerIds.add(String(row.playerId));
    result.set(id, entry);
  }
  return result;
}

function alreadyNotified(relatedId: string, email: string) {
  return !!database()
    .prepare(
      "SELECT 1 FROM email_outbox WHERE relatedId=? AND toAddress=? AND purpose='SESSION_NOTICE' LIMIT 1",
    )
    .get(relatedId, email.trim().toLowerCase());
}

function emptyReport(): NoticeReport {
  return {
    emailEnabled: emailConfig().enabled,
    guardians: 0,
    queued: 0,
    deferred: 0,
    alreadyNotified: 0,
    noAddress: 0,
    refused: 0,
  };
}

function send(
  report: NoticeReport,
  guardian: Recipient,
  relatedId: string,
  content: {
    academyId: string;
    academyName: string;
    headline: string;
    startsAt: string;
    place: string;
    timeZone: string;
  },
) {
  report.guardians++;
  const to = guardian.email.trim();
  if (!to) {
    report.noAddress++;
    return;
  }
  if (!report.emailEnabled) return;
  if (alreadyNotified(relatedId, to)) {
    report.alreadyNotified++;
    return;
  }
  const outcome = queueSessionCancellation(to, {
    name: guardian.name || "there",
    academyName: content.academyName,
    headline: content.headline,
    startsAt: content.startsAt,
    place: content.place || undefined,
    timeZone: content.timeZone,
    academyId: content.academyId,
    relatedId,
    path: `/workspace/${content.academyId}`,
  });
  if (outcome === "QUEUED") report.queued++;
  else if (outcome === "DEFERRED") report.deferred++;
  else if (outcome === "REFUSED") report.refused++;
}

/** Announces one cancelled session. Returns null when no notice is owed. */
export function notifySessionCancelled(
  session: FootballSession,
): NoticeReport | null {
  if (session.cancelledFrom === undefined || session.cancelledFrom === "DRAFT")
    return null;
  const report = emptyReport();
  try {
    const academy = repo.academy(session.academyId);
    const guardians = guardiansOf(
      session.academyId,
      session.roster.map((p) => p.playerId),
    );
    for (const guardian of guardians.values())
      send(report, guardian, SESSION_KEY(session.id), {
        academyId: session.academyId,
        academyName: academy?.name ?? "your academy",
        headline: "Training session cancelled",
        startsAt: session.startAt,
        place: session.location,
        timeZone: session.timezone,
      });
  } catch (error) {
    // The cancellation stands; the notice is best effort and says so.
    log("warn", "training.cancel_notice_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return report;
}

/** One summary per guardian for the sessions a series cancellation cancelled.
 * `cancelled` holds only sessions that were SCHEDULED (visible to parents). */
export function notifySeriesCancelled(
  series: FootballSeries,
  cancelled: FootballSession[],
): NoticeReport {
  const report = emptyReport();
  if (!cancelled.length) return report;
  try {
    const academy = repo.academy(series.academyId);
    const ordered = [...cancelled].sort((a, b) =>
      a.startAt.localeCompare(b.startAt),
    );
    const guardians = guardiansOf(
      series.academyId,
      ordered.flatMap((s) => s.roster.map((p) => p.playerId)),
    );
    for (const guardian of guardians.values()) {
      // Only the sessions this guardian's own child was due to attend.
      const theirs = ordered.filter((s) =>
        s.roster.some((p) => guardian.playerIds.has(p.playerId)),
      );
      if (!theirs.length) continue;
      const first = theirs[0],
        last = theirs[theirs.length - 1];
      send(report, guardian, SERIES_KEY(series.id), {
        academyId: series.academyId,
        academyName: academy?.name ?? "your academy",
        headline:
          theirs.length === 1
            ? "Training session cancelled"
            : `Weekly training cancelled: ${theirs.length} sessions, ${first.startLocal.slice(0, 10)} to ${last.startLocal.slice(0, 10)}`,
        startsAt: first.startAt,
        place: series.location,
        timeZone: series.timezone,
      });
    }
  } catch (error) {
    log("warn", "training.cancel_notice_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return report;
}
