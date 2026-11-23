/**
 * How dates are written on screen: "21 Nov 2026", never "2026-11-21", and "Sep" (not "Sept").
 * Stored values, API payloads and form inputs keep their ISO form; only the text people read
 * goes through here. Month names are fixed English abbreviations on purpose: the interface is
 * English, and Intl would give "Sept" in some locales and other languages in others.
 */
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** "2026-11-21" (or the date part of an ISO date-time) as "21 Nov 2026". Anything else comes back unchanged. */
export function displayDay(
  value: string | null | undefined,
  options: { weekday?: boolean } = {},
) {
  if (!value) return "";
  const match = DAY.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) return value;
  const text = `${Number(day)} ${MONTHS[monthIndex]} ${year}`;
  if (!options.weekday) return text;
  const weekday = new Date(`${year}-${month}-${day}T12:00:00Z`).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${text}`;
}

/** "21 Nov 2026 – 30 Nov 2026". */
export function displayDayRange(
  start: string | null | undefined,
  end: string | null | undefined,
  separator = " – ",
) {
  return `${displayDay(start)}${separator}${displayDay(end)}`;
}

function parts(date: Date, timeZone: string | undefined, hour12: boolean) {
  const found = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: hour12 ? "h12" : "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    found.find((part) => part.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
    period: get("dayPeriod").toUpperCase(),
  };
}

/** An instant as "21 Nov 2026", or with the time: "21 Nov 2026, 5:30 PM" (24-hour: "17:30"), in the given time zone. */
export function displayInstant(
  value: string | Date | null | undefined,
  timeZone?: string,
  options: { time?: boolean; hour12?: boolean } = {},
) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return typeof value === "string" ? value : "";
  const hour12 = options.hour12 !== false;
  const p = parts(date, timeZone, hour12);
  const day = `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
  if (!options.time) return day;
  return `${day}, ${displayClock(p, hour12)}`;
}

function displayClock(
  p: { hour: string; minute: string; period: string },
  hour12: boolean,
) {
  return hour12
    ? `${Number(p.hour)}:${p.minute} ${p.period}`
    : `${p.hour.padStart(2, "0")}:${p.minute}`;
}

/** Just the clock for an instant: "5:30 PM". */
export function displayTime(
  value: string | Date | null | undefined,
  timeZone?: string,
  hour12 = true,
) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return typeof value === "string" ? value : "";
  return displayClock(parts(date, timeZone, hour12), hour12);
}

/** "Sep" for the month of an instant in the given time zone. */
export function displayMonthShort(
  value: string | Date,
  timeZone?: string,
) {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "";
  return MONTHS[parts(date, timeZone, true).month - 1];
}

/** "2026-11-21T17:30" or "2026-11-21 17:30" (a wall-clock value with no zone) as "21 Nov 2026, 5:30 PM". */
export function displayLocal(
  value: string | null | undefined,
  options: { hour12?: boolean } = {},
) {
  if (!value) return "";
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (!match) return displayDay(value);
  const hour24 = Number(match[2]);
  const hour12 = options.hour12 !== false;
  const clock = hour12
    ? `${hour24 % 12 || 12}:${match[3]} ${hour24 < 12 ? "AM" : "PM"}`
    : `${match[2]}:${match[3]}`;
  return `${displayDay(match[1])}, ${clock}`;
}
