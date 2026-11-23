import { describe, expect, it, vi } from "vitest";
import {
  ARCHETYPES,
  DRILL_CATEGORIES,
  PARENT_CUE_MAX,
  PARENT_PURPOSE_MAX,
  universalDrillId,
  type UniversalDrill,
} from "@/domain/drill-library";
import {
  UNIVERSAL_CATALOGUE,
  categorySummary,
  findUniversalDrill,
  publishedDrills,
} from "@/config/drills";
import {
  HEADING_POLICIES,
  headingPolicyFor,
} from "@/config/drills/heading-policy";
import { operationalSports } from "@/config/sports/workspace-sports";
import { diagramProblems } from "@/services/drill-diagram-rules";

vi.mock("server-only", () => ({}));

// The approved list, transcribed independently of the catalogue files: number,
// name (character for character), category and original objective (verbatim).
const W = "Warm-Up & Activation",
  B = "Ball Control & Dribbling",
  PA = "Passing & Combination Play",
  PO = "Possession & Small-Sided Games",
  S = "Shooting, Crossing & Finishing",
  D = "Defending & Pressing",
  F = "Fitness, Speed & Goalkeeping";
const APPROVED: [number, string, string, string][] = [
  [1, "Dynamic Mobility Circuit", W, "Hip openers, gate swings, and lunges."],
  [2, "4-Grid Warm-Up", W, "Passing, reactions, and light speed work."],
  [3, "Ball-Feel Coordination", W, "Toe-taps, roll-overs, and sole-shuffles."],
  [4, "Tag Game with Balls", W, "Dribbling in a grid while trying to tag others."],
  [5, "Two-Touch Juggling Circle", W, "Air/bounce control with partners."],
  [6, "Shadow Play", W, "Mirroring an opponent's movements without the ball."],
  [7, "Dynamic Sprint & Acceleration", W, "Gradual build-up runs from 50% to 100%."],
  [8, "Wall-Kicks / Wall Passing", B, "First touch and passing accuracy off a rebound."],
  [9, "Stair Steppers on the Ball", B, "Rhythm and foot-speed control."],
  [10, "Coned Dribbling Slalom", B, "Tight turns using inside and outside of both feet."],
  [11, "1v1 Attacking in Wide Areas", B, "Beating a defender down the flank."],
  [12, "Dribbling Square / Grid", B, "Changing direction under spatial pressure."],
  [13, "Blindfold Soccer Movements", B, "Proprioception and spatial awareness without vision."],
  [14, "Feint and Take-Off Drill", B, "Body drops, shoulder feints, and acceleration."],
  [15, "Shielding the Ball", B, "Back-to-defender retention under light pressure."],
  [16, "Three-Player Passing Triangles", PA, "Quick wall-passes and angle support."],
  [17, "Four-Corner Passing", PA, "Vision, communication, and directional receiving."],
  [18, "The Time Glass Passing Drill", PA, "Timed combination sequences."],
  [19, "Pass In, Pass Out", PA, "Vertical entry and layoff combinations."],
  [20, "Rotational Passing Combinations", PA, "Overlap and third-man runs."],
  [21, "Diagonal & Straight Passing", PA, "Pace control and body shaping."],
  [22, "Wall Pass (One-Two) Progression", PA, "Dynamic wall-passes on the move."],
  [23, "Receiving in Midfield Under Pressure", PA, "Scanning and turning forward."],
  [24, "Long-Ball Aerial Control", PA, "Cushioning high balls with chest or foot."],
  [25, "4v2 Rondos", PO, "Transition and quick passing in tight spaces."],
  [26, "3v1 + 1 Rondo", PO, "Positional support and recycling possession."],
  [27, "Circle Possession", PO, "Decision-making and responsibility."],
  [28, "Grid Keepaway", PO, "Spreading out to maintain team shape."],
  [29, "Two-Section Keepaway", PO, "Penetration and target play."],
  [30, "Floater Grid Possession", PO, "Neutral players providing numerical advantage."],
  [31, "2v2 + 2 Small-Sided Possession", PO, "Dynamic transition play."],
  [32, "Four-Team Four-Goal Game", PO, "Switching play and defensive balance."],
  [33, "Numbers Game", PO, "Transition chaos with numerical imbalances."],
  [34, "Hurdle Shooting", S, "Jumping and striking low, driven shots."],
  [35, "Half-Field Combinations to Finish", S, "Build-up ending in a strike."],
  [36, "Crossing and Finishing", S, "Winger delivery with near/far-post runs."],
  [37, "Corner-Restricted 2v2", S, "Tight-space goal-scoring under pressure."],
  [38, "World Cup Shooting Game", S, "Knockout finishing competition."],
  [39, "Midfield Goals Transition", S, "Spreading attack and quick strike."],
  [40, "End-Line Target Games", S, "Flank play and cutbacks."],
  [41, "1v1 into 2v2 and 3v3 Progression", D, "Incremental defensive recovery."],
  [42, "2v1 Defending When Outnumbered", D, "Delaying and jockeying."],
  [43, "3-Team Transition Game (2v4 Intense Pressing)", D, "High-intensity group press."],
  [44, "Four-Goal Number-Down", D, "Defensive block organization."],
  [45, "Breaking the Block", D, "Dislodging a deep defensive line."],
  [46, "Sprinting Circuit with Ball", F, "Anaerobic conditioning and technical execution."],
  [47, "Center Circle Transition Sprints", F, "High-intensity recovery runs."],
  [48, "Goalkeeping Basic Handling & Angles", F, "Shot-blocking and footwork positioning."],
  [49, "Heading Control & Clearance", F, "Aerial timing and directional heading."],
  [50, "Field Thirds Shape & Switching", F, "Full-team tactical shift and endurance."],
];
const byNumber = (n: number) => UNIVERSAL_CATALOGUE.find((d) => d.number === n)!;
const categoryName = (d: UniversalDrill) =>
  DRILL_CATEGORIES.find((c) => c.id === d.categoryId)!.name;
const published = publishedDrills();

/** Every authored sentence a coach would read as an instruction. */
const instructionText = (d: UniversalDrill) =>
  [
    d.content.description,
    ...d.content.steps,
    ...d.content.coachingPoints,
    ...d.content.commonMistakes,
    ...d.content.progressions.easier,
    ...d.content.progressions.harder,
  ].join("\n");
/** All authored content text, for claims about distances and health. */
const authoredText = (d: UniversalDrill) =>
  [
    instructionText(d),
    d.content.setup.layout,
    d.content.setup.dimensions,
    ...d.content.safety,
    ...d.content.equipment,
    d.purpose,
    d.cue,
    d.summary,
  ].join("\n");

describe("the original 50 drills are all accounted for", () => {
  it("has exactly 50 initial entries numbered 1 to 50 with no gaps", () => {
    const initial = UNIVERSAL_CATALOGUE.filter((d) => d.origin === "INITIAL_50");
    expect(initial).toHaveLength(50);
    expect(initial.map((d) => d.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(UNIVERSAL_CATALOGUE).toHaveLength(50);
  });
  it("keeps every name, category and objective exactly as approved", () => {
    expect(APPROVED).toHaveLength(50);
    for (const [number, name, category, objective] of APPROVED) {
      const d = byNumber(number);
      expect(d.name, `drill ${number} name`).toBe(name);
      expect(categoryName(d), `drill ${number} category`).toBe(category);
      expect(d.originalObjective, `drill ${number} objective`).toBe(objective);
      expect(d.objectiveNewlyAuthored).toBe(false);
      expect(d.id).toBe(universalDrillId(number));
    }
  });
  it("has unique identifiers and unique names", () => {
    expect(new Set(UNIVERSAL_CATALOGUE.map((d) => d.id)).size).toBe(50);
    expect(new Set(UNIVERSAL_CATALOGUE.map((d) => d.name)).size).toBe(50);
  });
  it("has the seven categories with the 7/8/9/9/7/5/5 distribution", () => {
    expect(DRILL_CATEGORIES.map((c) => c.name)).toEqual([W, B, PA, PO, S, D, F]);
    expect(DRILL_CATEGORIES.map((c) => c.initialCount)).toEqual([7, 8, 9, 9, 7, 5, 5]);
    for (const c of DRILL_CATEGORIES) {
      const members = UNIVERSAL_CATALOGUE.filter(
        (d) => d.origin === "INITIAL_50" && d.categoryId === c.id,
      );
      expect(members, c.name).toHaveLength(c.initialCount);
      expect(members.every((d) => d.number >= c.first && d.number <= c.last)).toBe(true);
    }
    expect(DRILL_CATEGORIES.reduce((n, c) => n + c.initialCount, 0)).toBe(50);
  });
  it("keeps the initial counts independent of what is published", () => {
    const summary = categorySummary();
    expect(summary.map((c) => c.initialCount)).toEqual([7, 8, 9, 9, 7, 5, 5]);
    // Drill 49 is a draft, so its category shows 4 published of 5 initial.
    expect(summary.find((c) => c.name === F)).toMatchObject({
      initialCount: 5,
      publishedCount: 4,
    });
  });
  it("uses a focus area from the football vocabulary for every drill", () => {
    for (const d of UNIVERSAL_CATALOGUE)
      expect(operationalSports.football.skills, `drill ${d.number}`).toContain(
        d.focusArea,
      );
  });
});

describe("publication state", () => {
  it("holds Drill 49 as a draft and publishes the other 49", () => {
    expect(byNumber(49).status).toBe("DRAFT");
    expect(published).toHaveLength(49);
    expect(published.some((d) => d.number === 49)).toBe(false);
    expect(findUniversalDrill(universalDrillId(49))).toBeUndefined();
    expect(findUniversalDrill(universalDrillId(8))?.name).toBe(
      "Wall-Kicks / Wall Passing",
    );
  });
  it("freezes the catalogue so it cannot be changed at run time", () => {
    expect(Object.isFrozen(UNIVERSAL_CATALOGUE)).toBe(true);
  });
});

describe("every published drill is complete", () => {
  it("has all the required content", () => {
    for (const d of published) {
      const c = d.content,
        at = `drill ${d.number}`;
      expect(c.description.length, at).toBeGreaterThan(80);
      expect(d.summary.length, at).toBeGreaterThan(30);
      expect(c.skills.length, at).toBeGreaterThanOrEqual(2);
      expect(c.ageBands.length, at).toBeGreaterThanOrEqual(1);
      expect(c.durationMinutes, at).toBeGreaterThan(0);
      expect(c.durationMinutes, at).toBeLessThanOrEqual(60);
      expect(c.players.min, at).toBeGreaterThanOrEqual(1);
      expect(c.players.min, at).toBeLessThanOrEqual(c.players.max);
      expect(c.equipment.length, at).toBeGreaterThanOrEqual(1);
      expect(c.setup.layout.length, at).toBeGreaterThan(20);
      expect(c.setup.dimensions.length, at).toBeGreaterThan(20);
      expect(c.steps.length, at).toBeGreaterThanOrEqual(4);
      expect(c.coachingPoints.length, at).toBeGreaterThanOrEqual(3);
      expect(c.commonMistakes.length, at).toBeGreaterThanOrEqual(3);
      expect(c.progressions.easier.length, at).toBeGreaterThanOrEqual(1);
      expect(c.progressions.harder.length, at).toBeGreaterThanOrEqual(1);
      expect(c.safety.length, at).toBeGreaterThanOrEqual(2);
      expect(c.tags.length, at).toBeGreaterThanOrEqual(3);
      expect(["WARM_UP", "MAIN", "GAME", "CONDITIONING"], at).toContain(c.phase);
      expect(["LOW", "MEDIUM", "HIGH"], at).toContain(c.intensity);
      expect(["BEGINNER", "INTERMEDIATE", "ADVANCED"], at).toContain(c.difficulty);
      for (const text of [
        ...c.steps,
        ...c.coachingPoints,
        ...c.commonMistakes,
        ...c.safety,
      ])
        expect(text.trim().length, at).toBeGreaterThan(8);
    }
  });
  it("records its references individually, honestly", () => {
    for (const d of published) {
      const at = `drill ${d.number}`;
      expect(d.content.references.length, at).toBeGreaterThanOrEqual(1);
      for (const r of d.content.references) {
        expect(r.title.length, at).toBeGreaterThan(5);
        expect(r.use.length, at).toBeGreaterThan(20);
        // No page could be opened: nothing may claim to be verified.
        expect(r.access, at).not.toBe("OPENED");
        if (r.kind === "SOURCE") {
          expect(r.url, at).toMatch(/^https:\/\//);
          expect(r.publisher, at).toBeTruthy();
        } else expect(r.access, at).toBe("NONE");
      }
      // Each drill records either a drill-specific source or the limitation.
      expect(
        d.content.references.some((r) => r.kind === "LIMITATION"),
        at,
      ).toBe(true);
    }
  });
});

describe("parent-visible fields are safe", () => {
  it("keeps purpose and cue short, plain and free of staff-only detail", () => {
    const staffOnly =
      /\b(blindfold|eyes closed|spotter|injur\w*|concuss\w*|medical|diagnos\w*|treat\w*|rehab\w*|heading|header\w*|hurdle\w*|sliding|tackl\w*)\b/i;
    for (const d of UNIVERSAL_CATALOGUE) {
      expect(d.purpose.length, `drill ${d.number} purpose`).toBeLessThanOrEqual(
        PARENT_PURPOSE_MAX,
      );
      expect(d.cue.length, `drill ${d.number} cue`).toBeLessThanOrEqual(PARENT_CUE_MAX);
      expect(d.purpose.length).toBeGreaterThan(15);
      expect(d.cue.length).toBeGreaterThan(8);
      expect(d.purpose + " " + d.cue, `drill ${d.number}`).not.toMatch(staffOnly);
      expect(d.purpose + d.cue, `drill ${d.number}`).not.toMatch(/\d/);
    }
  });
});

describe("nothing is invented", () => {
  it("states no distances or repetition targets", () => {
    const distance = /\b\d+(\.\d+)?\s?(m|metres?|meters?|yards?|yds?|cm|km|ft|feet|foot)\b/i;
    const reps = /\b\d+\s?(reps?|repetitions?|sets?|times|headers?)\b/i;
    for (const d of UNIVERSAL_CATALOGUE) {
      const text = authoredText(d);
      expect(text, `drill ${d.number}`).not.toMatch(distance);
      expect(text, `drill ${d.number}`).not.toMatch(reps);
      expect(text, `drill ${d.number}`).not.toMatch(/\d+\s?%/);
    }
  });
  it("makes no medical or physiological claims", () => {
    const claim =
      /(prevent\w* (an )?injur|reduce\w* (the )?(risk|chance) of injur|rehabilit|\bcure\b|vo2|anaerobic|aerobic|lactic|build\w* muscle|burn\w* (fat|calorie))/i;
    for (const d of UNIVERSAL_CATALOGUE)
      expect(authoredText(d), `drill ${d.number}`).not.toMatch(claim);
  });
  it("does not present any association rule as a Sportozen fact", () => {
    for (const d of UNIVERSAL_CATALOGUE)
      expect(authoredText(d), `drill ${d.number}`).not.toMatch(
        /\b(FIFA|UEFA|the FA|AIFF|IFAB) (rule|rules|requires?|mandates?|bans?|limit)/i,
      );
  });
});

describe("heading is closed by default", () => {
  it("contains no heading instruction in any drill, including the draft", () => {
    const heading = /\bhead(ing|ers?)\b|\bheaded\b/i;
    for (const d of UNIVERSAL_CATALOGUE)
      expect(instructionText(d), `drill ${d.number}`).not.toMatch(heading);
  });
  it("keeps Drill 49 as a non-heading draft with a pending heading component", () => {
    const d = byNumber(49);
    expect(d.status).toBe("DRAFT");
    expect(d.headingComponent?.state).toBe("NOT_AUTHORED_PENDING_VERIFICATION");
    expect(d.name).toBe("Heading Control & Clearance");
    expect(d.originalObjective).toBe("Aerial timing and directional heading.");
    expect(d.content.references.some((r) => r.kind === "LIMITATION")).toBe(true);
  });
  it("never serves the draft", () => {
    expect(published.map((d) => d.id)).not.toContain(universalDrillId(49));
    expect(JSON.stringify(published)).not.toContain("NOT_AUTHORED_PENDING");
  });
  it("is disabled for India and for any unknown country", () => {
    expect(headingPolicyFor("IN")).toMatchObject({ headingEnabled: false });
    expect(headingPolicyFor("in").headingEnabled).toBe(false);
    expect(headingPolicyFor("ZZ").headingEnabled).toBe(false);
    expect(headingPolicyFor(undefined).headingEnabled).toBe(false);
    expect(HEADING_POLICIES.IN.verified).toBe(false);
  });
  it("needs a source and a verification date, not just a flag", () => {
    // A verified flag alone does not enable heading.
    const original = HEADING_POLICIES.IN;
    (HEADING_POLICIES as Record<string, unknown>).XX = {
      country: "XX",
      verified: true,
      note: "flag only",
    };
    expect(headingPolicyFor("XX").headingEnabled).toBe(false);
    (HEADING_POLICIES as Record<string, unknown>).YY = {
      country: "YY",
      verified: true,
      source: "Primary document",
      verifiedOn: "2026-01-01",
      note: "complete",
    };
    expect(headingPolicyFor("YY").headingEnabled).toBe(true);
    delete (HEADING_POLICIES as Record<string, unknown>).XX;
    delete (HEADING_POLICIES as Record<string, unknown>).YY;
    expect(HEADING_POLICIES.IN).toBe(original);
  });
});

describe("drill-specific safety", () => {
  it("Drill 13 is eyes-closed only, supervised, voluntary, from age 12", () => {
    const d = byNumber(13);
    expect(d.minimumAge).toEqual({ years: 12, basis: "INTERNAL_PRODUCT_POLICY" });
    expect(d.content.ageBands).not.toContain("U6-U8");
    expect(d.content.ageBands).not.toContain("U9-U11");
    const safety = d.content.safety.join("\n");
    expect(safety).toMatch(/minimum age 12/i);
    expect(safety).toMatch(/not a football association rule/i);
    expect(safety).toMatch(/no physical blindfold/i);
    expect(safety).toMatch(/eyes closed only/i);
    expect(safety).toMatch(/spotter/i);
    expect(safety).toMatch(/voluntary/i);
    expect(safety).toMatch(/stop immediately without explanation/i);
    expect(safety).toMatch(/no running, no collisions, no passing and no contact/i);
    expect(d.content.equipment.join(" ")).toMatch(/no blindfolds are supplied/i);
    // The instructions themselves contain no running, passing or contact.
    expect(d.content.steps.join(" ")).not.toMatch(/\b(run|jog|sprint|pass|kick|collid|contact)\w*/i);
    expect(d.content.diagram.elements.some((e) => e.kind === "arrow")).toBe(false);
  });
  it("Drill 34 uses soft low hurdles, a landing area and shoots after balance", () => {
    const d = byNumber(34);
    const text = d.content.safety.join("\n") + d.content.steps.join("\n");
    expect(text).toMatch(/low, soft or collapsible/i);
    expect(text).toMatch(/flat markers/i);
    expect(text).toMatch(/landing area/i);
    expect(text).toMatch(/only after balance is regained/i);
    expect(text).toMatch(/never while airborne/i);
    expect(d.content.equipment.join(" ")).toMatch(/low, soft or collapsible/i);
    expect(d.content.diagram.archetype).toBe("shooting-lane");
    expect(d.content.diagram.elements.some((e) => e.kind === "hurdle")).toBe(true);
    expect(
      d.content.diagram.elements.some((e) => e.kind === "zone" && /landing/i.test(e.label ?? "")),
    ).toBe(true);
  });
  it("Drill 43 defines rotation, triggers, recovery and contact rules", () => {
    const d = byNumber(43);
    expect(d.name).toBe("3-Team Transition Game (2v4 Intense Pressing)");
    const text = instructionText(d) + d.content.safety.join("\n");
    expect(text).toMatch(/rotat/i);
    expect(text).toMatch(/trigger/i);
    expect(text).toMatch(/back pass/i);
    expect(text).toMatch(/recover/i);
    expect(text).toMatch(/no sliding tackles/i);
    expect(text).toMatch(/no tackling from behind/i);
    expect(d.content.diagram.archetype).toBe("three-team-rotation");
  });
  it("Drill 24 controls with chest, thigh or foot only", () => {
    const d = byNumber(24);
    expect(instructionText(d)).toMatch(/chest/i);
    expect(d.content.safety.join(" ")).toMatch(/heading is not part of this drill/i);
    expect(instructionText(d)).not.toMatch(/\bhead(ing|ers?)\b/i);
  });
});

describe("similar drills stay distinct", () => {
  it("separates the three wall-pass drills (8, 16, 22)", () => {
    const d8 = byNumber(8),
      d16 = byNumber(16),
      d22 = byNumber(22);
    expect(d8.content.equipment.join(" ")).toMatch(/wall or rebound board \(required/i);
    expect(d8.content.diagram.archetype).toBe("wall-lane");
    expect(d8.content.players.max).toBeGreaterThan(0);
    expect(d8.interpretation).toMatch(/same drill/i);
    expect(d16.content.diagram.archetype).toBe("triangle");
    expect(d16.content.description).toMatch(/shape|angle/i);
    expect(d22.content.description).toMatch(/teammate/i);
    expect(d22.content.diagram.archetype).not.toBe("wall-lane");
    expect(d22.content.progressions.harder.join(" ")).toMatch(/defender/i);
    for (const d of [d8, d16, d22]) {
      expect(d.distinctFrom?.length ?? 0).toBeGreaterThan(0);
      for (const x of d.distinctFrom ?? [])
        expect(x.difference.length).toBeGreaterThan(40);
    }
    expect(d8.distinctFrom?.map((x) => x.number)).toContain(22);
    expect(d22.distinctFrom?.map((x) => x.number)).toContain(8);
    expect(d16.distinctFrom?.map((x) => x.number)).toContain(22);
    expect(
      new Set([d8, d16, d22].map((d) => d.content.diagram.caption)).size,
    ).toBe(3);
  });
  it("documents Drill 18 as an hourglass in timed rounds, as our interpretation", () => {
    const d = byNumber(18);
    expect(d.name).toBe("The Time Glass Passing Drill");
    expect(d.content.diagram.archetype).toBe("hourglass");
    expect(d.interpretation).toMatch(/not an established historical drill/i);
    expect(instructionText(d)).toMatch(/timed round/i);
    expect(d.content.references[0].kind).toBe("LIMITATION");
  });
  it("makes the neutral players explicit in Drills 26 and 31", () => {
    const neutrals = (n: number) =>
      byNumber(n).content.diagram.elements.filter(
        (e) => e.kind === "player" && e.team === "N",
      ).length;
    expect(neutrals(26)).toBe(1);
    expect(byNumber(26).interpretation).toMatch(/one neutral supporting player/i);
    expect(neutrals(31)).toBe(2);
    expect(byNumber(31).interpretation).toMatch(/two neutral supporting players/i);
    const count = (n: number, team: string) =>
      byNumber(n).content.diagram.elements.filter(
        (e) => e.kind === "player" && e.team === team,
      ).length;
    expect([count(25, "A"), count(25, "B")]).toEqual([4, 2]);
    expect([count(26, "A"), count(26, "B")]).toEqual([3, 1]);
  });
});

describe("diagrams", () => {
  it("gives every drill a valid, bounded diagram", () => {
    for (const d of UNIVERSAL_CATALOGUE)
      expect(diagramProblems(d.content.diagram), `drill ${d.number}`).toEqual([]);
  });
  it("does not reuse one picture for every drill", () => {
    const keys = UNIVERSAL_CATALOGUE.map((d) => JSON.stringify(d.content.diagram.elements));
    expect(new Set(keys).size).toBe(50);
    expect(new Set(UNIVERSAL_CATALOGUE.map((d) => d.content.diagram.caption)).size).toBe(50);
  });
  it("uses all ten reusable archetypes", () => {
    const used = new Set(UNIVERSAL_CATALOGUE.map((d) => d.content.diagram.archetype));
    for (const a of ARCHETYPES) expect(used.has(a), a).toBe(true);
  });
  it("rejects a broken diagram", () => {
    const good = byNumber(10).content.diagram;
    expect(diagramProblems(undefined)).toContain("no diagram");
    expect(
      diagramProblems({ ...good, elements: [...good.elements, { kind: "cone", x: 500, y: 1 }] }).join(),
    ).toMatch(/outside the board/);
    expect(diagramProblems({ ...good, caption: "short" }).join()).toMatch(/caption/);
    expect(
      diagramProblems({
        ...good,
        elements: [...good.elements, { kind: "arrow", type: "PASS", x1: 5, y1: 5, x2: 5, y2: 5 }],
      }).join(),
    ).toMatch(/no length/);
  });
});
