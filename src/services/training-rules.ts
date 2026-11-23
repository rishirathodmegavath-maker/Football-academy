import "@/lib/zod-csp";
import { z } from "zod";
import type { FootballEvidence } from "@/domain/training";
const id = z.string().min(1).max(100),
  text = z.string().trim().min(1).max(2000);
/** Planning is optional while a dated session is a draft. */
export const sessionDraftInput = z
  .object({
    branchId: id,
    squadId: id.min(1, "Choose an authorised session squad."),
    venueId: id.optional(),
    location: z.string().trim().max(2000).default(""),
    placeConfirmation: z.string().max(16000).optional(),
    coachIds: z.array(id).default([]),
    timezone: text,
    startLocal: z.string().min(1, "Enter the session start date and time."),
    endLocal: z.string().min(1, "Enter the session end date and time."),
    title: z.string().trim().max(200).optional(),
    theme: z
      .string()
      .trim()
      .max(2000, "Keep the theme within 2,000 characters.")
      .default(""),
    agenda: z
      .array(
        z.object({
          drillId: id,
          duration: z.number().int().positive().max(180),
        }),
      )
      .default([]),
    sharedObjective: z
      .object({
        goal: z.string().trim().max(2000),
        cue: z.string().trim().max(2000),
        observe: z.string().trim().max(1000).default(""),
      })
      .optional(),
    preparation: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  })
  .superRefine((value, context) => {
    const resolved: Record<string, string> = {};
    for (const field of ["startLocal", "endLocal"] as const) {
      if (!value[field]) continue;
      try {
        resolved[field] = resolveSessionTime(value[field], value.timezone);
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            error instanceof Error
              ? error.message
              : "Enter a valid session date and time.",
        });
      }
    }
    if (resolved.startLocal && resolved.endLocal) {
      const duration =
        (Date.parse(resolved.endLocal) - Date.parse(resolved.startLocal)) /
        60000;
      if (duration <= 0 || duration > 480)
        context.addIssue({
          code: "custom",
          path: ["endLocal"],
          message: "End the session after its start, within eight hours.",
        });
      else if (
        value.agenda.reduce((sum, item) => sum + item.duration, 0) > duration
      )
        context.addIssue({
          code: "custom",
          path: ["agenda"],
          message: "Drill durations exceed the session length.",
        });
    }
  });
export const evidenceInput = z
  .object({
    sessionId: id,
    playerId: id,
    planId: id.optional(),
    drillId: id,
    conditions: text,
    observation: text,
    staffNote: z.string().max(2000).default(""),
    type: z.enum(["COACH_OBSERVATION", "RAW_RECORD"]),
    visibility: z.enum(["PARENT_ELIGIBLE", "STAFF_ONLY"]),
    measurement: z.enum(["OBSERVATION", "ATTEMPTS", "ELAPSED_TIME"]),
    attempts: z.number().int().nonnegative().max(100000).optional(),
    successes: z.number().int().nonnegative().max(100000).optional(),
    elapsedSeconds: z.number().positive().max(86400).optional(),
    method: text,
  })
  .superRefine((v, c) => {
    if (
      v.measurement === "ATTEMPTS" &&
      (v.attempts === undefined ||
        v.successes === undefined ||
        v.successes > v.attempts)
    )
      c.addIssue({
        code: "custom",
        message: "Record valid attempts and successes.",
      });
    if (v.measurement === "ELAPSED_TIME" && v.elapsedSeconds === undefined)
      c.addIssue({
        code: "custom",
        message: "Record positive elapsed seconds.",
      });
  });
// Resolve a local wall time only if exactly one UTC instant represents it.
// Both the spring gap and autumn fold are rejected, rather than guessed.
const wallFormats = new Map<string, Intl.DateTimeFormat>();
function wallFormat(timezone: string) {
  let format = wallFormats.get(timezone);
  if (!format) {
    // An invalid zone throws here and is not remembered.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallFormats.set(timezone, format);
  }
  return format;
}
export function resolveSessionTime(local: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error("Use a dated local time.");
  const format = wallFormat(timezone);
  const centre = Date.parse(local + "Z");
  if (!Number.isFinite(centre)) throw new Error("Invalid session date.");
  const parts = (instant: number) =>
    Object.fromEntries(
      format.formatToParts(instant).map((p) => [p.type, p.value]),
    );
  // An instant matches only if its wall-clock reading in the zone IS `local`.
  // That test is the same as it always was; what changed is which instants are
  // tried. A match must sit at (local time - the zone's UTC offset), and the
  // offset of any such instant is one in force within 14 hours of the local
  // time, so the offsets read at a few points across that span are the only
  // candidates. A clock change gives two offsets in the span (a gap matches
  // neither, a repeated hour matches both); IANA offsets are whole minutes.
  const candidates = new Set<number>();
  for (let hours = -14; hours <= 14; hours += 4) {
    const at = centre + hours * 3_600_000,
      p = parts(at),
      wall = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
      );
    candidates.add(centre - Math.round((wall - at) / 60000) * 60000);
  }
  const matches = [...candidates].filter((instant) => {
    const p = parts(instant);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === local;
  });
  if (matches.length !== 1)
    throw new Error(
      "This local time is invalid or ambiguous in the selected time zone. Choose another time.",
    );
  return new Date(matches[0]).toISOString();
}
export function measurementText(
  e: Pick<
    FootballEvidence,
    "measurement" | "attempts" | "successes" | "elapsedSeconds"
  >,
) {
  if (e.measurement === "ATTEMPTS")
    return e.attempts
      ? `${e.successes} successful out of ${e.attempts} recorded attempts`
      : "No attempts recorded — no percentage or skill score";
  if (e.measurement === "ELAPSED_TIME")
    return `${e.elapsedSeconds} seconds for the defined course`;
  return "Coach observation";
}
export function comparableEvidence(a: FootballEvidence, b: FootballEvidence) {
  return (
    a.playerId === b.playerId &&
    a.drillId === b.drillId &&
    a.drillVersion === b.drillVersion &&
    a.conditions === b.conditions &&
    a.method === b.method &&
    a.unit === b.unit &&
    a.measurement === b.measurement &&
    a.status === "REVIEWED" &&
    b.status === "REVIEWED"
  );
}
