import "@/lib/zod-csp";
import { z } from "zod";

const id = z.string().min(1).max(100);

/** A weekly recurring schedule. Dates and times are the academy's local wall
 * clock; the instants are worked out per date (see recurrence.ts). */
export const seriesDraftInput = z.object({
  branchId: id,
  squadId: id,
  venueId: id.optional(),
  location: z.string().trim().max(2000).default(""),
  coachIds: z.array(id).max(20).default([]),
  timezone: z.string().trim().min(1).max(100),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startDate: z.string().max(10),
  endDate: z.string().max(10),
  startTime: z.string().max(5),
  endTime: z.string().max(5),
  title: z.string().trim().max(200).optional(),
  theme: z
    .string()
    .trim()
    .max(2000, "Keep the theme within 2,000 characters.")
    .default(""),
  agenda: z
    .array(
      z.object({ drillId: id, duration: z.number().int().positive().max(180) }),
    )
    .max(30)
    .default([]),
  exclusions: z
    .array(
      z.object({
        date: z.string().max(10),
        label: z.string().trim().max(200).default(""),
      }),
    )
    .max(60)
    .default([]),
});

export const seriesCancelInput = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Record why the series is cancelled.")
    .max(1000),
});

/** What the coach recorded for one planned drill. The planned minutes and the
 * drill name come from the saved agenda, never from this input. */
export const wrapUpInput = z.object({
  drills: z
    .array(
      z.object({
        drillId: id,
        outcome: z.enum(["COMPLETED", "PARTIAL", "SKIPPED"]),
        actualMinutes: z.number().int().min(0).max(480).optional(),
        note: z.string().trim().max(1000).default(""),
      }),
    )
    .max(30)
    .default([]),
  observations: z.string().trim().max(4000).default(""),
  achievements: z.string().trim().max(4000).default(""),
  improvements: z.string().trim().max(4000).default(""),
});
