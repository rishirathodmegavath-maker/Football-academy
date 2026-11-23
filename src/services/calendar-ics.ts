/**
 * iCalendar (RFC 5545) text for training sessions. Pure functions, so the same code builds the private subscription feed
 * on the server and the one-session "Add to calendar" file in the browser, and is tested without either.
 *
 * Privacy: an event carries only what the caller puts in it. Callers pass the time, place, batch, and drill names. They
 * never pass a player's name for a coach (a calendar lives in a third-party service) and never a private note.
 */
export interface IcsEvent {
  /** Stable id: the same session always produces the same UID, so a calendar updates it instead of duplicating it. */
  uid: string;
  title: string;
  /** ISO instants. */
  startAt: string;
  endAt: string;
  location?: string;
  description?: string;
  status?: "CONFIRMED" | "CANCELLED";
  /** Bumped on each change so calendars take the newest copy. */
  sequence?: number;
  /** When this copy was last changed (ISO). */
  updatedAt?: string;
}

// TextEncoder exists in the browser and in Node; Buffer does not exist in the browser.
const encoder = new TextEncoder();
const CRLF = "\r\n";

/** Text values: backslash, semicolon, comma and line breaks are escaped. */
export function icsText(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Lines are folded at 75 octets, continuing with one space, and never split a multi-byte character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    // the first line may hold 75 octets; each continuation holds 74 plus its leading space
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

/** 20261118T093000Z */
export function icsInstant(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function eventLines(event: IcsEvent, stamp: string): string[] {
  const start = icsInstant(event.startAt),
    end = icsInstant(event.endAt);
  if (!start || !end) return [];
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${icsInstant(event.updatedAt ?? "") ?? stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsText(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
  lines.push(`STATUS:${event.status ?? "CONFIRMED"}`);
  lines.push(`SEQUENCE:${Math.max(0, Math.floor(event.sequence ?? 0))}`);
  lines.push("TRANSP:OPAQUE", "END:VEVENT");
  return lines;
}

export function buildIcs(
  calendarName: string,
  events: IcsEvent[],
  now = new Date(),
): string {
  const stamp = icsInstant(now.toISOString())!;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sportozen//Training sessions//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
    // Hints for calendar apps: check again about hourly.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...events.flatMap((event) => eventLines(event, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** One-click "Add to Google Calendar" link for a single session. Needs no account with Google on our side. */
export function googleCalendarLink(event: IcsEvent): string {
  const start = icsInstant(event.startAt),
    end = icsInstant(event.endAt);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${start ?? ""}/${end ?? ""}`,
  });
  if (event.location) params.set("location", event.location);
  if (event.description) params.set("details", event.description);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
