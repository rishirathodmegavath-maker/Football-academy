/**
 * Football drill library: the types shared by the universal catalogue (code,
 * reviewed releases only), academy-owned drills, and the screens.
 *
 * Two kinds of drill exist and they never share storage:
 *  - UNIVERSAL: the central catalogue in `src/config/drills`. Read-only at run
 *    time, served by an authenticated route, changed only by a code release.
 *  - ACADEMY: a `drill` workspace record (created by the academy, or a
 *    deterministic customised copy of a universal drill).
 */

export const DRILL_CATEGORIES = [
  {
    id: "warm-up-activation",
    name: "Warm-Up & Activation",
    initialCount: 7,
    first: 1,
    last: 7,
  },
  {
    id: "ball-control-dribbling",
    name: "Ball Control & Dribbling",
    initialCount: 8,
    first: 8,
    last: 15,
  },
  {
    id: "passing-combination-play",
    name: "Passing & Combination Play",
    initialCount: 9,
    first: 16,
    last: 24,
  },
  {
    id: "possession-small-sided-games",
    name: "Possession & Small-Sided Games",
    initialCount: 9,
    first: 25,
    last: 33,
  },
  {
    id: "shooting-crossing-finishing",
    name: "Shooting, Crossing & Finishing",
    initialCount: 7,
    first: 34,
    last: 40,
  },
  {
    id: "defending-pressing",
    name: "Defending & Pressing",
    initialCount: 5,
    first: 41,
    last: 45,
  },
  {
    id: "fitness-speed-goalkeeping",
    name: "Fitness, Speed & Goalkeeping",
    initialCount: 5,
    first: 46,
    last: 50,
  },
] as const;
export type DrillCategoryId = (typeof DRILL_CATEGORIES)[number]["id"];
export const DRILL_CATEGORY_IDS = DRILL_CATEGORIES.map(
  (c) => c.id,
) as unknown as readonly [DrillCategoryId, ...DrillCategoryId[]];
export const drillCategoryName = (id?: string) =>
  DRILL_CATEGORIES.find((c) => c.id === id)?.name ?? "Uncategorised";

/** Suitability bands for choosing a drill. They are NOT safety limits. */
export const AGE_BANDS = ["U6-U8", "U9-U11", "U12-U14", "U15+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const DIFFICULTIES = ["BEGINNER", "INTERMEDIATE", "ADVANCED"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const PHASES = ["WARM_UP", "MAIN", "GAME", "CONDITIONING"] as const;
export type TrainingPhase = (typeof PHASES)[number];
export const INTENSITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type Intensity = (typeof INTENSITIES)[number];

/** A source behind a drill's content. Every published drill records at least
 * one entry; where no authoritative source exists the entry is a LIMITATION. */
export interface DrillReference {
  kind: "SOURCE" | "LIMITATION";
  title: string;
  publisher?: string;
  url?: string;
  /** How the source was used. */
  use: string;
  /** SOURCE entries found by search whose pages could not be opened are marked
   * LOCATED_NOT_OPENED; nothing is claimed as verified. */
  access: "LOCATED_NOT_OPENED" | "OPENED" | "NONE";
}

// ---------------------------------------------------------------- diagrams

export const ARCHETYPES = [
  "slalom",
  "grid",
  "rondo",
  "triangle",
  "hourglass",
  "wall-lane",
  "shooting-lane",
  "three-team-rotation",
  "four-goal-game",
  "pitch-thirds",
] as const;
export type ArchetypeId = (typeof ARCHETYPES)[number];
export const DIAGRAM_BOARD = { width: 100, height: 64 } as const;
export type DiagramTeam = "A" | "B" | "C" | "D" | "N" | "GK" | "CO";
export type DiagramElement =
  | { kind: "player"; x: number; y: number; team: DiagramTeam; label?: string }
  | { kind: "cone"; x: number; y: number }
  | { kind: "marker"; x: number; y: number; label: string }
  | { kind: "ball"; x: number; y: number }
  | { kind: "goal"; x: number; y: number; w: number; h?: number }
  | { kind: "hurdle"; x: number; y: number; w: number }
  | { kind: "wall"; x: number; y: number; w: number }
  | { kind: "zone"; x: number; y: number; w: number; h: number; label?: string }
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "label"; x: number; y: number; text: string }
  | {
      kind: "arrow";
      type: "PASS" | "RUN" | "DRIBBLE";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      order?: number;
    };
/** A schematic, top-down layout. The board is 100 x 64 abstract units: it is
 * NOT to scale and states no real distances. */
export interface DiagramSpec {
  archetype: ArchetypeId;
  board: "GRID" | "LANE" | "HALF_PITCH" | "PITCH";
  elements: DiagramElement[];
  caption: string;
}

// ---------------------------------------------------------------- content

export interface DrillContent {
  description: string;
  skills: string[];
  ageBands: AgeBand[];
  difficulty: Difficulty;
  durationMinutes: number;
  players: { min: number; max: number; note?: string };
  equipment: string[];
  setup: { layout: string; dimensions: string };
  steps: string[];
  coachingPoints: string[];
  commonMistakes: string[];
  progressions: { easier: string[]; harder: string[] };
  safety: string[];
  phase: TrainingPhase;
  intensity: Intensity;
  tags: string[];
  references: DrillReference[];
  diagram: DiagramSpec;
}

/** The content an academy may give its own drill. Everything is optional so
 * that older drills (name, focus, purpose, cue only) stay valid. */
export type AcademyDrillContent = Partial<Omit<DrillContent, "diagram">> & {
  diagram?: DiagramSpec;
  /** An academy-created drill picks one of the predefined layouts. */
  diagramPreset?: ArchetypeId;
};

export type DrillStatus = "PUBLISHED" | "DRAFT";
export interface UniversalDrill {
  /** `uni-001` ... stable for ever; never reused. */
  id: string;
  /** 1-50 for the original catalogue; above 50 for later central additions. */
  number: number;
  origin: "INITIAL_50" | "ADDED";
  categoryId: DrillCategoryId;
  /** Character-for-character as approved. */
  name: string;
  /** The approved objective, verbatim. Never edited. */
  originalObjective: string;
  /** True only if the objective above was written by Sportozen, not approved. */
  objectiveNewlyAuthored: boolean;
  /** Primary skill; must be in the football skill vocabulary (for copies). */
  focusArea: string;
  /** Parent-visible in reports: short and plain. */
  purpose: string;
  /** Parent-visible in reports: one short coaching cue. */
  cue: string;
  /** Staff card summary. */
  summary: string;
  status: DrillStatus;
  /** Bumped by every change to the content in a release. */
  contentVersion: number;
  content: DrillContent;
  /** Documented interpretation where the approved name is not a standard drill. */
  interpretation?: string;
  /** Internal product restriction (not a governing-body rule). */
  minimumAge?: { years: number; basis: "INTERNAL_PRODUCT_POLICY" };
  /** How this drill differs from similar ones (kept as data and tested). */
  distinctFrom?: { number: number; difference: string }[];
  /** Heading is never authored until a country policy is verified. */
  headingComponent?: {
    state: "NOT_AUTHORED_PENDING_VERIFICATION";
    note: string;
  };
}

// ---------------------------------------------------------------- identifiers

export const UNIVERSAL_PREFIX = "uni-";
export const COPY_PREFIX = "from-uni-";
export const universalDrillId = (number: number) =>
  `${UNIVERSAL_PREFIX}${String(number).padStart(3, "0")}`;
export const copyDrillId = (universalId: string) =>
  `from-${universalId}`;
export const isUniversalDrillId = (id: string) => id.startsWith(UNIVERSAL_PREFIX);
export const isCopyDrillId = (id: string) => id.startsWith(COPY_PREFIX);

/** Longest parent-visible texts (shown in monthly reports). */
export const PARENT_PURPOSE_MAX = 160;
export const PARENT_CUE_MAX = 120;
