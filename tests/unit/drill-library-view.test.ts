import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("server-only", () => ({}));
import { UNIVERSAL_CATALOGUE, publishedDrills } from "@/config/drills";
import { PRESET_LABELS, presetDiagram } from "@/config/drills/diagrams";
import { ARCHETYPES, DRILL_CATEGORIES } from "@/domain/drill-library";
import type { WorkspaceDrill } from "@/domain/workspace";
import { diagramProblems } from "@/services/drill-diagram-rules";
import {
  NO_FILTERS,
  filterItems,
  libraryItems,
  matchesQuery,
  moveItem,
  totalMinutes,
} from "@/services/drill-library-view";
import { DrillDiagram } from "@/features/workspaces/drill-diagram";
import { DrillDetail } from "@/features/workspaces/drill-library-parts";

const academyDrill = (over: Partial<WorkspaceDrill> = {}): WorkspaceDrill => ({
  id: "own-1",
  academyId: "a",
  sportId: "football",
  name: "Academy box game",
  focusArea: "Passing",
  purpose: "Practise short passes.",
  cue: "Pass and move.",
  ownership: "ACADEMY_CURRICULUM",
  category: "passing-combination-play",
  status: "ACTIVE",
  createdBy: "coach-1",
  content: { tags: ["box"], skills: ["Awareness"] },
  recordVersion: 3,
  ...over,
});
const viewer = { userId: "coach-1", role: "COACH" };
const all = libraryItems(publishedDrills(), [academyDrill()], viewer);

describe("the library list", () => {
  it("lists the published catalogue and the academy drills together", () => {
    expect(all).toHaveLength(50);
    expect(all.filter((i) => i.source === "UNIVERSAL")).toHaveLength(49);
    expect(all.find((i) => i.id === "own-1")?.source).toBe("ACADEMY");
  });
  it("marks a copy and links the universal drill to it", () => {
    const items = libraryItems(
      publishedDrills(),
      [
        academyDrill({
          id: "from-uni-008",
          templateId: "uni-008",
          category: "ball-control-dribbling",
        }),
      ],
      viewer,
    );
    expect(items.find((i) => i.id === "from-uni-008")?.source).toBe("COPY");
    expect(items.find((i) => i.id === "uni-008")?.copyId).toBe("from-uni-008");
  });
  it("shows an older drill without a category as uncategorised", () => {
    const items = libraryItems([], [academyDrill({ category: undefined })], viewer);
    expect(items[0].categoryName).toBe("Uncategorised");
    expect(
      filterItems(items, { ...NO_FILTERS, category: "uncategorised" }),
    ).toHaveLength(1);
    expect(
      filterItems(items, { ...NO_FILTERS, category: "defending-pressing" }),
    ).toHaveLength(0);
  });
  it("hints management by role and creator; universal drills are never manageable", () => {
    const mine = academyDrill(),
      theirs = academyDrill({ id: "own-2", createdBy: "someone" }),
      legacy = academyDrill({ id: "own-3", createdBy: undefined });
    const coach = libraryItems(publishedDrills(), [mine, theirs, legacy], viewer);
    expect(coach.filter((i) => i.canManage).map((i) => i.id)).toEqual(["own-1"]);
    const owner = libraryItems([], [mine, theirs, legacy], {
      userId: "o",
      role: "OWNER",
    });
    expect(owner.every((i) => i.canManage)).toBe(true);
    expect(
      coach.filter((i) => i.source === "UNIVERSAL").some((i) => i.canManage),
    ).toBe(false);
  });
});

describe("search and filters", () => {
  it("filters by each of the seven categories", () => {
    for (const c of DRILL_CATEGORIES) {
      const found = filterItems(all, { ...NO_FILTERS, category: c.id });
      const universal = found.filter((i) => i.source === "UNIVERSAL");
      expect(universal.length).toBeLessThanOrEqual(c.initialCount);
      expect(found.every((i) => i.categoryId === c.id)).toBe(true);
    }
    expect(
      filterItems(all, { ...NO_FILTERS, category: "warm-up-activation" }),
    ).toHaveLength(7);
  });
  it("searches by drill name, skill and tag", () => {
    expect(
      filterItems(all, { ...NO_FILTERS, query: "rondo" }).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      filterItems(all, { ...NO_FILTERS, query: "hourglass" }).map((i) => i.number),
    ).toContain(18);
    expect(
      filterItems(all, { ...NO_FILTERS, query: "scanning" }).length,
    ).toBeGreaterThan(0);
    expect(
      filterItems(all, { ...NO_FILTERS, query: "box" }).map((i) => i.id),
    ).toContain("own-1");
    expect(matchesQuery(all[0], "  ")).toBe(true);
    expect(
      filterItems(all, { ...NO_FILTERS, query: "zzzz-no-such-drill" }),
    ).toEqual([]);
  });
  it("does not offer the draft heading drill", () => {
    expect(filterItems(all, { ...NO_FILTERS, query: "heading" })).toEqual([]);
  });
  it("filters universal versus academy-owned", () => {
    const items = libraryItems(
      publishedDrills(),
      [academyDrill(), academyDrill({ id: "from-uni-008", templateId: "uni-008" })],
      viewer,
    );
    expect(
      filterItems(items, { ...NO_FILTERS, source: "UNIVERSAL" }).every(
        (i) => i.source === "UNIVERSAL",
      ),
    ).toBe(true);
    expect(
      filterItems(items, { ...NO_FILTERS, source: "ACADEMY" })
        .map((i) => i.id)
        .sort(),
    ).toEqual(["from-uni-008", "own-1"]);
  });
  it("hides archived drills unless asked", () => {
    const items = libraryItems([], [academyDrill({ status: "ARCHIVED" })], viewer);
    expect(filterItems(items, NO_FILTERS)).toHaveLength(0);
    expect(filterItems(items, { ...NO_FILTERS, showArchived: true })).toHaveLength(1);
  });
});

describe("ordering and totals", () => {
  it("moves a drill up or down and stops at the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    const list = ["a", "b"];
    moveItem(list, 0, 1);
    expect(list).toEqual(["a", "b"]);
  });
  it("totals the minutes of an agenda", () => {
    expect(totalMinutes([{ duration: 15 }, { duration: 20 }, { duration: 10 }])).toBe(45);
    expect(totalMinutes([])).toBe(0);
  });
});

describe("rendering", () => {
  it("draws every diagram as accessible SVG without bad numbers", () => {
    for (const d of UNIVERSAL_CATALOGUE) {
      const html = renderToStaticMarkup(
        createElement(DrillDiagram, { spec: d.content.diagram }),
      );
      expect(html, `drill ${d.number}`).toContain("<svg");
      expect(html, `drill ${d.number}`).toContain('aria-label="');
      expect(html, `drill ${d.number}`).not.toMatch(/NaN|undefined|Infinity/);
      expect(html, `drill ${d.number}`).toContain("not to scale");
    }
  });
  it("offers a valid predefined layout for each archetype", () => {
    for (const a of ARCHETYPES) {
      expect(diagramProblems(presetDiagram(a)), a).toEqual([]);
      expect(PRESET_LABELS[a].length).toBeGreaterThan(3);
    }
  });
  it("shows the full detail of a drill, including safety and references", () => {
    const item = all.find((i) => i.number === 34)!;
    const html = renderToStaticMarkup(createElement(DrillDetail, { item }));
    for (const heading of [
      "Approved objective",
      "Instructions",
      "Coaching points",
      "Common mistakes",
      "Progressions",
      "Safety",
      "References",
      "Equipment",
      "Setup",
    ])
      expect(html).toContain(heading);
    expect(html).toContain("Jumping and striking low, driven shots.");
    expect(html).toContain("only after balance is regained");
    expect(html).toContain("Universal #34");
  });
  it("states Drill 13's internal minimum age in its detail", () => {
    const html = renderToStaticMarkup(
      createElement(DrillDetail, { item: all.find((i) => i.number === 13)! }),
    );
    expect(html).toContain("Minimum age 12");
    expect(html).toContain("not a football association rule");
  });
  it("labels staff-only content", () => {
    const html = renderToStaticMarkup(createElement(DrillDetail, { item: all[0] }));
    expect(html).toContain("for authorised staff only");
  });
});

// Stage 1: the session's coaching view is drawn from the saved snapshot only.
import { SessionDrillDetail, AgendaThumb } from "@/features/workspaces/drill-library-parts";
import { hasSavedContent, snapshotItem } from "@/services/drill-library-view";
import { createElement as h } from "react";

describe("the session drill view", () => {
  const universal = UNIVERSAL_CATALOGUE.find((d) => d.id === "uni-013")!;
  const saved = (over: Partial<WorkspaceDrill> = {}): WorkspaceDrill => ({
    id: universal.id,
    academyId: "a",
    sportId: "football",
    name: universal.name,
    focusArea: universal.focusArea,
    purpose: universal.purpose,
    cue: universal.cue,
    ownership: "UNIVERSAL_CATALOGUE",
    templateId: universal.id,
    category: universal.categoryId,
    status: "ACTIVE",
    universalVersion: 1,
    content: structuredClone({ ...universal.content }),
    lockedSafety: [...universal.content.safety],
    minimumAge: universal.minimumAge,
    snapshot: {
      capturedAt: "2026-12-01T06:00:00.000Z",
      contentVersion: 1,
      source: "UNIVERSAL_CATALOGUE",
      objective: universal.originalObjective,
      number: 13,
    },
    ...over,
  });
  it("shows setup, equipment, instructions, coaching points, progressions, safety and the diagram", () => {
    const html = renderToStaticMarkup(h(SessionDrillDetail, { drill: saved() }));
    for (const heading of ["Equipment", "Setup", "Instructions", "Coaching points", "Progressions", "Safety"])
      expect(html).toContain(`<h4>${heading}</h4>`);
    for (const step of universal.content.steps) expect(html).toContain(step.replace(/'/g, "&#x27;"));
    for (const line of universal.content.safety) expect(html).toContain(line.replace(/'/g, "&#x27;"));
    expect(html).toContain("Minimum age 12");
    expect(html).toContain("Saved with this session on 1 Dec 2026");
    expect(html).toContain("Content version 1");
    expect(html).toContain("<svg");
    expect(html).toContain(universal.originalObjective);
  });
  it("draws exactly what was saved, not today's catalogue", () => {
    const edited = saved();
    edited.content!.steps = ["The step this session was saved with."];
    const html = renderToStaticMarkup(h(SessionDrillDetail, { drill: edited }));
    expect(html).toContain("The step this session was saved with.");
    for (const step of universal.content.steps) expect(html).not.toContain(step.replace(/'/g, "&#x27;"));
  });
  it("labels an older incomplete snapshot and never fills it from the catalogue", () => {
    const { content: _c, snapshot: _s, lockedSafety: _l, minimumAge: _m, ...slim } = saved();
    void [_c, _s, _l, _m];
    expect(hasSavedContent(slim as WorkspaceDrill)).toBe(false);
    const html = renderToStaticMarkup(h(SessionDrillDetail, { drill: slim as WorkspaceDrill }));
    expect(html).toContain("Historical content unavailable");
    expect(html).toContain(slim.purpose);
    expect(html).not.toContain("<h4>Instructions</h4>");
    expect(html).not.toContain("<svg");
    for (const step of universal.content.steps) expect(html).not.toContain(step.replace(/'/g, "&#x27;"));
    const thumb = renderToStaticMarkup(
      h(AgendaThumb, { drill: slim as WorkspaceDrill, fallback: h("i", { id: "fallback" }) }),
    );
    expect(thumb).toContain('id="fallback"');
  });
  it("an academy drill saved without coaching content says so plainly", () => {
    const html = renderToStaticMarkup(
      h(SessionDrillDetail, { drill: academyDrill({ content: undefined }) }),
    );
    expect(html).toContain("No detailed coaching content was recorded");
    expect(html).not.toContain("Historical content unavailable");
  });
  it("the snapshot item carries the rule and the locked lines", () => {
    const item = snapshotItem(saved());
    expect(item.minimumAgeYears).toBe(12);
    expect(item.lockedSafety).toEqual(universal.content.safety);
    expect(item.originalObjective).toBe(universal.originalObjective);
    expect(item.canManage).toBe(false);
  });
});
