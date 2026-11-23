import { z } from "zod";
import { accountEmailSchema } from "./email/address";
import { PLAYER_STATUSES } from "@/domain/player-lifecycle";
import {
  AGE_BANDS,
  ARCHETYPES,
  DIFFICULTIES,
  DRILL_CATEGORY_IDS,
  INTENSITIES,
  PHASES,
} from "@/domain/drill-library";
const text = z.string().trim().min(1).max(5000),
  id = z.string().min(1).max(100),
  date = z.iso.date(),
  short = z.string().trim().max(200);
export {
  academySchema,
  academyUpdateSchema,
} from "@/domain/academy-configuration-schema";
export const playerSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  placementReviewed: z.boolean().optional(),
  name: short.min(2),
  sportIds: z.tuple([z.literal("football")]).default(["football"]),
  squad: short.optional(),
  squadId: id.or(z.literal("")).optional(),
  ageCategory: z.string().trim().max(30).optional(),
  birthDate: date
    .or(z.literal(""))
    .refine(
      (value) => !value || value <= new Date().toISOString().slice(0, 10),
      "Birth date cannot be in the future.",
    )
    .optional(),
  position: short.optional(),
  status: z.enum(PLAYER_STATUSES).optional(),
  coachId: id,
});
export const enquirySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().optional(),
    childName: short.min(2).max(120),
    guardianName: short.min(2).max(120),
    contact: z.string().trim().min(3).max(200),
    source: z.string().trim().max(100).default(""),
    followUpDate: date.or(z.literal("")).optional(),
    notes: z.string().trim().max(2000).default(""),
    status: z.enum(["OPEN", "WAITLIST", "CLOSED"]).default("OPEN"),
    closedReason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status !== "CLOSED" || !!v.closedReason?.trim(), {
    message: "Record why the enquiry was closed.",
    path: ["closedReason"],
  });
export const conversionSchema = z.object({
  coachId: id,
  squadId: id.or(z.literal("")).optional(),
  ageCategory: z.string().trim().max(30).optional(),
  // Players are under 18 and always have a date of birth: asked for here, because an enquiry does not hold one.
  birthDate: date,
});
export const planSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  playerId: id,
  sportId: z.literal("football").default("football"),
  coachId: id,
  focus: short.min(1),
  reason: text,
  drillIds: z.array(id),
  observe: text,
  homePractice: z.string().max(1500),
  reviewDate: date,
  nextStep: text,
  status: z.enum([
    "DRAFT",
    "ACTIVE",
    "NEEDS_REVIEW",
    "CONTINUE",
    "ADAPT",
    "COMPLETED",
    "PAUSED",
  ]),
  privateNote: z.string().max(3000),
});
export const reportSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  sourceEvidenceIds: z.array(id).optional(),
  playerId: id,
  sportId: z.literal("football").default("football"),
  planId: id,
  period: short.min(1),
  observation: text,
  evidenceType: z.enum([
    "RAW_RECORD",
    "COACH_OBSERVATION",
    "CALCULATED_METRIC",
    "AI_ESTIMATE",
    "MISSING_OR_UNCLEAR",
  ]),
  nextStep: text,
  closingNote: z.string().max(10000),
});
const line = (max: number) => z.string().trim().min(1).max(max);
const list = (items: number, max: number) => z.array(line(max)).max(items);
/** Staff-only coaching content an academy may give its own drill. Strict, so
 * nothing else can be smuggled into the record. */
export const academyDrillContentSchema = z
  .object({
    description: z.string().trim().max(2000),
    skills: list(10, 60),
    ageBands: z.array(z.enum(AGE_BANDS)).max(4),
    difficulty: z.enum(DIFFICULTIES),
    durationMinutes: z.number().int().min(1).max(180),
    players: z
      .object({
        min: z.number().int().min(1).max(60),
        max: z.number().int().min(1).max(60),
        note: z.string().trim().max(200).optional(),
      })
      .strict()
      .refine((p) => p.min <= p.max, "Minimum players cannot exceed maximum."),
    equipment: list(20, 120),
    setup: z
      .object({
        layout: z.string().trim().max(1000),
        dimensions: z.string().trim().max(500),
      })
      .strict(),
    steps: list(20, 500),
    coachingPoints: list(12, 300),
    commonMistakes: list(12, 300),
    progressions: z
      .object({ easier: list(8, 300), harder: list(8, 300) })
      .strict(),
    safety: list(12, 400),
    phase: z.enum(PHASES),
    intensity: z.enum(INTENSITIES),
    tags: list(12, 40),
    references: z
      .array(
        z
          .object({
            kind: z.enum(["SOURCE", "LIMITATION"]),
            title: line(200),
            publisher: z.string().trim().max(120).optional(),
            url: z
              .string()
              .trim()
              .max(400)
              .regex(/^https:\/\/\S+$/)
              .optional(),
            use: z.string().trim().max(500).default("Recorded by the academy"),
            access: z
              .enum(["LOCATED_NOT_OPENED", "OPENED", "NONE"])
              .default("NONE"),
          })
          .strict(),
      )
      .max(8),
    diagramPreset: z.enum(ARCHETYPES),
  })
  .partial()
  .strict();
export const drillSchema = z.object({
  /** Required when changing a stored academy drill (optimistic concurrency). */
  expectedVersion: z.number().int().nonnegative().optional(),
  sportId: z.literal("football").default("football"),
  name: short.min(1),
  focusArea: short.min(1),
  purpose: text,
  cue: text,
  templateId: id.optional(),
  category: z.enum(DRILL_CATEGORY_IDS).optional(),
  content: academyDrillContentSchema.optional(),
});
export const updateSchema = z.object({
  playerId: id,
  sportId: z.literal("football").default("football"),
  planId: id.or(z.literal("")),
  messageBody: text,
  sourceReportId: id.optional(),
  sourceWeeklyPlanId: id.optional(),
  type: z.enum([
    "DEVELOPMENT",
    "NUTRITION_HYDRATION",
    "UPCOMING_TRAINING",
    "REVIEWED_SESSION",
  ]),
});
export const inviteSchema = z.object({
  email: accountEmailSchema,
  // The academy owner manages the academy; there is no Admin role to invite.
  // (Existing Admin memberships in stored data keep working: nothing is removed.)
  // A coach or a parent/guardian is invited here. A player is not invited by email: the owner makes a player link under
  // Players, "Add player with invitation link" (see player-link-service.ts).
  role: z.enum(["COACH", "PARENT"], {
    error:
      "Choose Coach or Parent. A player joins with a player link from the Players screen; Admin invitations are not available: the academy owner manages the academy.",
  }),
  playerIds: z.array(id).default([]),
  guardianVerified: z.boolean().default(false),
});
