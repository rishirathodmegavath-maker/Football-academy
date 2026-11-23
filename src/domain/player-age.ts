/**
 * Players are under 18. One place decides what that means, for the server (which refuses) and the screens (which warn).
 * A player is under 18 until the day of their 18th birthday: on that day they are 18. Dates are plain "YYYY-MM-DD" days in
 * the academy's own calendar, so there is no clock-time or time-zone arithmetic to get wrong.
 */
export const PLAYER_MAX_AGE = 18;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written YYYY-MM-DD (not 2014-02-31). */
export function isCalendarDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Whole years between a birth day and a given day. */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** The day the player turns 18 (29 February birthdays turn 18 on 1 March in a common year). */
export function turns18On(birthDate: string): string {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const y = by + PLAYER_MAX_AGE;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const [m, d] = bm === 2 && bd === 29 && !leap ? [3, 1] : [bm, bd];
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const isUnder18 = (birthDate: string, today: string) => ageOn(birthDate, today) < PLAYER_MAX_AGE;

/** Days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(to) - t(from)) / 86_400_000);
}

/** How long before the 18th birthday the owner is shown the player. */
export const TURNING_18_WARNING_DAYS = 30;

/** An owner or admin's decision about a player who is 18 or older: kept for now, until a day when it is looked at again. */
export type AgeDecision = { decision: "KEEP"; reason: string; decidedBy: string; decidedAt: string; recheckOn: string };

export type AgeState =
  | { kind: "OK" }
  | { kind: "BIRTH_DATE_MISSING" }
  | { kind: "TURNING_18"; on: string; inDays: number }
  | { kind: "DECIDE"; turnedOn: string }
  | { kind: "KEPT"; until: string };

/**
 * Where a player stands. `archived` players are out of the picture. A player who is 18 or older needs the owner's decision
 * until they are archived (accept) or kept for now with a reason and a day to look again (reject); once that day passes the
 * decision is asked for again.
 */
export function ageState(
  profile: { birthDate?: string | null; status?: string | null; ageDecision?: AgeDecision | null },
  today: string,
): AgeState {
  if (profile.status === "ARCHIVED") return { kind: "OK" };
  const birth = (profile.birthDate ?? "").trim();
  if (!isCalendarDay(birth)) return { kind: "BIRTH_DATE_MISSING" };
  if (isUnder18(birth, today)) {
    const on = turns18On(birth);
    const inDays = daysBetween(today, on);
    return inDays <= TURNING_18_WARNING_DAYS ? { kind: "TURNING_18", on, inDays } : { kind: "OK" };
  }
  const kept = profile.ageDecision;
  if (kept && kept.decision === "KEEP" && kept.recheckOn >= today) return { kind: "KEPT", until: kept.recheckOn };
  return { kind: "DECIDE", turnedOn: turns18On(birth) };
}

/** Today's date in a time zone, as YYYY-MM-DD (the academy's own calendar). */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const day = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** One short line saying where a player stands. */
export function ageStateLabel(state: AgeState): string {
  switch (state.kind) {
    case "OK":
      return "";
    case "BIRTH_DATE_MISSING":
      return "No date of birth yet: players must be under 18, so it is required";
    case "TURNING_18":
      return state.inDays <= 0
        ? `Turns 18 today (${day(state.on)})`
        : `Turns 18 in ${state.inDays} day${state.inDays === 1 ? "" : "s"} (${day(state.on)})`;
    case "DECIDE":
      return `Turned 18 on ${day(state.turnedOn)}: archive, or keep for now`;
    case "KEPT":
      return `Over 18, kept for now until ${day(state.until)}`;
  }
}
