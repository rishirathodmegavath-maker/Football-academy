/**
 * The text a coach or parent receives about a session. Pure, so the browser builds it for each person and tests can
 * check it. It names the time in the session's own time zone, the place and the drills, and for a parent only their own
 * children's first names. It never contains a private note or an objective.
 */
export interface MessageSession {
  status: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string;
  drills: { name: string; minutes: number }[];
}

export function whenText(session: MessageSession): string {
  const start = new Date(session.startAt),
    end = new Date(session.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return "Time to be confirmed";
  const tz = session.timezone,
    day = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(start),
    time = (d: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
  return `${day}, ${time(start)}–${time(end)} (${tz})`;
}

export function sessionMessage(input: {
  academyName: string;
  session: MessageSession;
  person: { name: string; role: "COACH" | "PARENT"; children: string[] };
  note?: string;
}): { subject: string; text: string } {
  const { session, person } = input,
    cancelled = session.status === "CANCELLED",
    first = person.name.trim().split(/\s+/)[0] || "there",
    when = whenText(session),
    lines: string[] = [`Hello ${first},`, ""];
  lines.push(
    cancelled
      ? "This training session has been cancelled."
      : person.role === "COACH"
        ? "You are down to run this training session."
        : "Here are the details of the training session.",
    "",
    session.title,
    `When: ${when}`,
  );
  if (session.location) lines.push(`Where: ${session.location}`);
  if (person.role === "PARENT" && person.children.length)
    lines.push(`For: ${person.children.join(" and ")}`);
  if (!cancelled && session.drills.length) {
    lines.push("", "Drills:");
    session.drills.forEach((drill, i) =>
      lines.push(
        `${i + 1}. ${drill.name}${drill.minutes ? ` (${drill.minutes} min)` : ""}`,
      ),
    );
  }
  const note = (input.note ?? "").trim();
  if (note) lines.push("", note);
  lines.push("", `— ${input.academyName}`);
  const subject = `${cancelled ? "Cancelled: " : "Training: "}${session.title} · ${when}`;
  return { subject, text: lines.join("\n") };
}
