import type { SkippedOccurrence } from "@/domain/training";
import { resolveSessionTime } from "./training-rules";

/**
 * Weekly recurrence for training sessions.
 *
 * Dates are walked as LOCAL calendar days (whole days since the epoch of a
 * plain date), never by adding 7 x 24 hours to an instant, so a daylight-saving
 * change cannot move an occurrence to another day. The UTC instant of each
 * occurrence comes from `resolveSessionTime`, which accepts a local time only
 * when exactly one instant represents it. A date whose local time does not
 * exist (spring gap) or is ambiguous (autumn fold) is skipped and reported; it
 * is never shifted to a nearby time.
 */
export const MAX_SERIES_WEEKS = 26;
export const MAX_SERIES_OCCURRENCES = 60;
const MAX_SERIES_DAYS = MAX_SERIES_WEEKS * 7;
const MAX_SESSION_MINUTES = 8 * 60;

export interface SeriesRule {
  timezone: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  exclusions: { date: string; label: string }[];
}
export interface Occurrence {
  date: string;
  startLocal: string;
  endLocal: string;
  startAt: string;
  endAt: string;
}
/** The rule itself is unusable. Distinct from a skipped date, which is normal. */
export class SeriesRuleError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}
function dayString(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
/** A real calendar date: "2026-02-30" is not one. */
export function isCalendarDate(value: string): boolean {
  return DATE.test(value) && dayString(dayNumber(value)) === value;
}
/** 1 = Monday ... 7 = Sunday, from the date alone (no time zone involved). */
export function isoWeekday(date: string): number {
  const day = new Date(dayNumber(date) * 86_400_000).getUTCDay();
  return day === 0 ? 7 : day;
}
export function occurrenceId(seriesId: string, date: string) {
  return `${seriesId}:${date}`;
}
function minutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Throws SeriesRuleError for a rule that cannot be used; returns the matching
 * local dates, in order, before any exclusion is applied. */
export function seriesDates(rule: SeriesRule): string[] {
  if (!validZone(rule.timezone))
    throw new SeriesRuleError("Use a valid time zone.");
  if (
    !rule.weekdays.length ||
    new Set(rule.weekdays).size !== rule.weekdays.length ||
    rule.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  )
    throw new SeriesRuleError(
      "Choose at least one weekday, each only once (1 = Monday to 7 = Sunday).",
    );
  if (!isCalendarDate(rule.startDate) || !isCalendarDate(rule.endDate))
    throw new SeriesRuleError("Enter real start and end dates.");
  const first = dayNumber(rule.startDate),
    last = dayNumber(rule.endDate);
  if (last < first)
    throw new SeriesRuleError("The end date cannot be before the start date.");
  if (last - first + 1 > MAX_SERIES_DAYS)
    throw new SeriesRuleError(
      `A series can span at most ${MAX_SERIES_WEEKS} weeks.`,
    );
  if (!TIME.test(rule.startTime) || !TIME.test(rule.endTime))
    throw new SeriesRuleError("Enter start and end times as HH:mm.");
  const length = minutes(rule.endTime) - minutes(rule.startTime);
  if (length <= 0 || length > MAX_SESSION_MINUTES)
    throw new SeriesRuleError(
      "A session must end after it starts, on the same day, within eight hours.",
    );
  const dates: string[] = [];
  for (let day = first; day <= last; day++) {
    const date = dayString(day);
    if (rule.weekdays.includes(isoWeekday(date))) dates.push(date);
  }
  if (!dates.length)
    throw new SeriesRuleError(
      "None of the chosen weekdays falls between the start and end dates.",
    );
  if (dates.length > MAX_SERIES_OCCURRENCES)
    throw new SeriesRuleError(
      `A series can have at most ${MAX_SERIES_OCCURRENCES} sessions; this rule gives ${dates.length}. Shorten the range or choose fewer weekdays.`,
    );
  const seen = new Set<string>();
  for (const exclusion of rule.exclusions) {
    if (!isCalendarDate(exclusion.date))
      throw new SeriesRuleError("Enter real holiday dates.");
    if (exclusion.date < rule.startDate || exclusion.date > rule.endDate)
      throw new SeriesRuleError(
        `The holiday ${exclusion.date} is outside the series dates.`,
      );
    if (seen.has(exclusion.date))
      throw new SeriesRuleError(
        `The holiday ${exclusion.date} is listed twice.`,
      );
    seen.add(exclusion.date);
  }
  return dates;
}

/** Turns a rule into sessions-to-create and dates-that-were-skipped. `now` is a
 * millisecond timestamp: an occurrence that has already started is skipped. */
export function expandSeries(
  rule: SeriesRule,
  now: number,
): { occurrences: Occurrence[]; skipped: SkippedOccurrence[] } {
  const excluded = new Map(rule.exclusions.map((e) => [e.date, e.label]));
  const occurrences: Occurrence[] = [],
    skipped: SkippedOccurrence[] = [];
  for (const date of seriesDates(rule)) {
    if (excluded.has(date)) {
      skipped.push({
        date,
        reason: "EXCLUDED",
        detail: excluded.get(date) || "Holiday",
      });
      continue;
    }
    const startLocal = `${date}T${rule.startTime}`,
      endLocal = `${date}T${rule.endTime}`;
    let startAt: string, endAt: string;
    try {
      startAt = resolveSessionTime(startLocal, rule.timezone);
      endAt = resolveSessionTime(endLocal, rule.timezone);
    } catch {
      skipped.push({
        date,
        reason: "TIME_INVALID",
        detail: `${rule.startTime}-${rule.endTime} does not exist or is ambiguous in ${rule.timezone} on this date (a clock change). Schedule this day separately.`,
      });
      continue;
    }
    const length = (Date.parse(endAt) - Date.parse(startAt)) / 60000;
    if (length <= 0 || length > MAX_SESSION_MINUTES) {
      skipped.push({
        date,
        reason: "TIME_INVALID",
        detail: `A clock change makes this day's session ${length <= 0 ? "end before it starts" : "longer than eight hours"}. Schedule this day separately.`,
      });
      continue;
    }
    if (Date.parse(startAt) <= now) {
      skipped.push({
        date,
        reason: "PAST",
        detail: "This session would already have started.",
      });
      continue;
    }
    occurrences.push({ date, startLocal, endLocal, startAt, endAt });
  }
  return { occurrences, skipped };
}
