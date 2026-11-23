import type { WorkspacePayload, WorkspacePlayer } from "@/domain/workspace";
import { UNASSIGNED_PLAYER_BATCH } from "./player-form-options";
import { displayInstant } from "./date-display";

export function playerAge(birthDate: string | undefined, day: string) {
  if (!birthDate) return undefined;
  const [year, month, date] = birthDate.split("-").map(Number);
  const [currentYear, currentMonth, currentDate] = day.split("-").map(Number);
  return (
    currentYear -
    year -
    (currentMonth < month || (currentMonth === month && currentDate < date)
      ? 1
      : 0)
  );
}

export function academyDate(
  data: Pick<WorkspacePayload, "academy">,
  now = new Date(),
) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: data.academy.timezone,
  }).format(now);
}
export type DayPart = "morning" | "afternoon" | "evening";
/** 05:00 to 11:59 morning, 12:00 to 16:59 afternoon, 17:00 to 04:59 evening. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}
/** The greeting for the academy's own wall clock (its time zone, not the
 * device's), for example "Good evening" at 00:30 in Asia/Kolkata. */
export function academyGreeting(
  data: Pick<WorkspacePayload, "academy">,
  now = new Date(),
) {
  let hour: number;
  try {
    hour =
      Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: data.academy.timezone,
          hour: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(now)
          .find((part) => part.type === "hour")?.value,
      ) % 24;
  } catch {
    // An unusable time zone must not blank the home screen: use this device's clock.
    hour = now.getHours();
  }
  return `Good ${dayPart(hour)}`;
}
export function portalSessionSummary(
  data: Pick<WorkspacePayload, "academy"> & {
    records: Pick<WorkspacePayload["records"], "session">;
  },
  now = new Date(),
) {
  const active = data.records.session.filter(
    (s) => !["DRAFT", "CANCELLED"].includes(s.status),
  );
  const today = academyDate(data, now);
  const todaySessions = active
    .filter((s) => academyDate(data, new Date(s.startAt)) === today)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const upcoming = active
    .filter((s) => s.status !== "COMPLETED" && s.endAt >= now.toISOString())
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  return {
    today,
    todaySessions,
    upcoming,
    next:
      todaySessions.find(
        (s) => s.status !== "COMPLETED" && s.endAt >= now.toISOString(),
      ) ?? upcoming[0],
  };
}
export function playerBatch(data: WorkspacePayload, player: WorkspacePlayer) {
  const batch = player.squadId
    ? data.records.squad.find((s) => s.id === player.squadId)
    : data.records.squad.find((s) => s.playerIds.includes(player.id));
  if (batch) return batch.name;
  // Parents, support users and coaches of shared batches cannot read every
  // batch record. The server records the batch name with each reviewed
  // placement, while an explicit unassignment ("") keeps a historical label.
  if (
    !["OWNER", "ADMIN"].includes(data.membership.role) &&
    player.squadId !== "" &&
    player.squad.trim()
  )
    return player.squad;
  return UNASSIGNED_PLAYER_BATCH;
}
export function approvedPlayerReport(data: WorkspacePayload, playerId: string) {
  return data.records.report
    .filter(
      (r) => r.playerId === playerId && r.status === "Approved" && r.snapshot,
    )
    .sort(
      (a, b) =>
        b.period.localeCompare(a.period) ||
        (b.recordVersion ?? 0) - (a.recordVersion ?? 0),
    )[0];
}
export function currentPlayerPlan(
  data: { records: Pick<WorkspacePayload["records"], "plan"> },
  playerId: string,
) {
  return data.records.plan.filter(
    (p) =>
      p.playerId === playerId && !["COMPLETED", "PAUSED"].includes(p.status),
  )[0];
}
export function playerDevelopmentHistory(
  data: WorkspacePayload,
  playerId: string,
) {
  return data.records.report
    .filter(
      (r) => r.playerId === playerId && r.status === "Approved" && r.snapshot,
    )
    .sort((a, b) => b.period.localeCompare(a.period));
}
/** A player's approved reports, newest period first, from listed reports. */
export function playerReportHistory<
  T extends {
    playerId: string;
    status: string;
    hasSnapshot: boolean;
    period: string;
  },
>(reports: T[], playerId: string) {
  return reports
    .filter(
      (r) =>
        r.playerId === playerId && r.status === "Approved" && r.hasSnapshot,
    )
    .sort((a, b) => b.period.localeCompare(a.period));
}
export function portalDate(
  value: string,
  data: Pick<WorkspacePayload, "academy">,
  time = false,
) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not scheduled";
  // Dates read "21 Nov 2026" whatever the academy's number locale (see services/date-display.ts).
  if (!time) return displayInstant(value, data.academy.timezone);
  return new Intl.DateTimeFormat(data.academy.dateLocale, {
    timeZone: data.academy.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: data.academy.timeFormat !== "24_HOUR",
  }).format(new Date(value));
}
