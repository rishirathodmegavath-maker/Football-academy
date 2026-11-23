import {
  DRILL_CATEGORIES,
  universalDrillId,
  type DrillCategoryId,
  type DrillContent,
  type DrillReference,
  type UniversalDrill,
} from "@/domain/drill-library";

// Reference records. Pages were located by search but could not be opened when
// the catalogue was written (no network access to the publishers), so none is
// claimed as verified. See docs/DRILL_CONTENT_REGISTER.md.
export const REF = {
  uefaGrassroots: {
    kind: "SOURCE",
    title: "Grassroots tips for coaching kids",
    publisher: "UEFA",
    url: "https://www.uefa.com/news-media/news/0252-0f8e6ccae436-cec1c47608d5-1000--grassroots-tips-for-coaching-kids/",
    use: "General youth-coaching principles only: enjoyable, inclusive, age-appropriate sessions.",
    access: "LOCATED_NOT_OPENED",
  },
  fifaDynamicRondos: {
    kind: "SOURCE",
    title: "Dynamic rondos and numerical advantages (grassroots, 12 to 15)",
    publisher: "FIFA Training Centre",
    url: "https://fifatrainingcentre.com/en/practice/grassroots/12-to-15/dynamicrondos-and-numerical-advantages.php",
    use: "Structure of rondo practices with numerical advantages. Wording here is original.",
    access: "LOCATED_NOT_OPENED",
  },
  fifa3v1: {
    kind: "SOURCE",
    title: "3v1 rondo, fast readjustments",
    publisher: "FIFA Training Centre",
    url: "https://www.fifatrainingcentre.com/en/practice/talent-coach-programme/secure-possession/3v1-rondo-fast-readjustments.php",
    use: "Positional support and quick adjustment in a small rondo. Wording here is original.",
    access: "LOCATED_NOT_OPENED",
  },
  fifa4v4plus2: {
    kind: "SOURCE",
    title: "4v4 plus 2 possession game, playing forward as a priority",
    publisher: "FIFA Training Centre",
    url: "https://www.fifatrainingcentre.com/en/practice/talent-coach-programme/build-and-progress/4v4-plus-2-possession-game-playing-forward-as-a-priority.php",
    use: "Possession games with neutral players. Wording here is original.",
    access: "LOCATED_NOT_OPENED",
  },
  fifaFinish: {
    kind: "SOURCE",
    title: "Finish your chances (grassroots, 12 to 15)",
    publisher: "FIFA Training Centre",
    url: "https://www.fifatrainingcentre.com/en/practice/grassroots/12-to-15/finish-your-chances.php",
    use: "Finishing practice structure. Wording here is original.",
    access: "LOCATED_NOT_OPENED",
  },
} satisfies Record<string, DrillReference>;

/** An explicit record that no drill-specific authoritative source was found. */
export const limitation = (what: string): DrillReference => ({
  kind: "LIMITATION",
  title: "No drill-specific authoritative source located",
  use: `${what} Written as original Sportozen coaching practice from general youth-development principles; the drill-specific publisher pages could not be reached to verify. Requires coach-educator review before wider claims are made.`,
  access: "NONE",
});

/** Safety lines used by many drills. Statements only: no distances, counts or
 * medical claims. */
export const SAFE = {
  surface:
    "Check that the surface is dry, flat and free of obstacles, and that footwear suits it.",
  balls: "Keep spare balls outside the playing area so nobody steps on one.",
  water:
    "Allow water breaks, and adapt or stop the activity for any player who looks unwell or tired.",
  stop: "Any player may stop at once without giving a reason; the coach stops the drill if control or spacing is lost.",
  contact:
    "No sliding, no tackling from behind and no deliberate contact beyond fair challenging for the ball.",
  space:
    "Give each pair or group clear space so paths do not cross; stop and reset if they do.",
  goal: "Goals must be anchored and checked before use.",
} as const;

export const DIM = {
  grid: "Mark a grid the coach sizes to the group: large enough for free movement, small enough that players keep meeting the ball.",
  lane: "Mark each lane the coach sizes to the age and ability of the players, with a clear buffer between lanes.",
  half: "Use the part of the pitch the coach chooses, with the goal in view and nothing else in the playing area.",
} as const;

type Authored = {
  number: number;
  categoryId: DrillCategoryId;
  name: string;
  originalObjective: string;
  focusArea: string;
  purpose: string;
  cue: string;
  summary: string;
  content: DrillContent;
  status?: UniversalDrill["status"];
  interpretation?: string;
  minimumAge?: UniversalDrill["minimumAge"];
  distinctFrom?: UniversalDrill["distinctFrom"];
  headingComponent?: UniversalDrill["headingComponent"];
};

/** Builds one catalogue entry. The id, origin and version are fixed here so an
 * author cannot mistake them. */
export function drill(a: Authored): UniversalDrill {
  const category = DRILL_CATEGORIES.find((c) => c.id === a.categoryId)!;
  return {
    id: universalDrillId(a.number),
    number: a.number,
    origin: "INITIAL_50",
    categoryId: category.id,
    name: a.name,
    originalObjective: a.originalObjective,
    objectiveNewlyAuthored: false,
    focusArea: a.focusArea,
    purpose: a.purpose,
    cue: a.cue,
    summary: a.summary,
    status: a.status ?? "PUBLISHED",
    contentVersion: 1,
    content: a.content,
    ...(a.interpretation ? { interpretation: a.interpretation } : {}),
    ...(a.minimumAge ? { minimumAge: a.minimumAge } : {}),
    ...(a.distinctFrom ? { distinctFrom: a.distinctFrom } : {}),
    ...(a.headingComponent ? { headingComponent: a.headingComponent } : {}),
  };
}
