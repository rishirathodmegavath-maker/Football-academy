import {
  ARCHETYPES,
  DIAGRAM_BOARD,
  type DiagramElement,
  type DiagramSpec,
} from "@/domain/drill-library";

const inside = (x: number, y: number) =>
  Number.isFinite(x) &&
  Number.isFinite(y) &&
  x >= 0 &&
  x <= DIAGRAM_BOARD.width &&
  y >= 0 &&
  y <= DIAGRAM_BOARD.height;

function elementProblems(e: DiagramElement, at: string): string[] {
  const out: string[] = [];
  const pt = (x: number, y: number, what = "position") => {
    if (!inside(x, y)) out.push(`${at}: ${what} is outside the board`);
  };
  switch (e.kind) {
    case "arrow":
      pt(e.x1, e.y1, "arrow start");
      pt(e.x2, e.y2, "arrow end");
      if (Math.hypot(e.x2 - e.x1, e.y2 - e.y1) < 1)
        out.push(`${at}: arrow has no length`);
      break;
    case "zone":
      pt(e.x, e.y);
      pt(e.x + e.w, e.y + e.h, "zone corner");
      if (e.w <= 0 || e.h <= 0) out.push(`${at}: zone has no size`);
      break;
    case "goal":
      pt(e.x, e.y);
      pt(e.x + e.w, e.y + (e.h ?? 3), "goal corner");
      break;
    case "hurdle":
    case "wall":
      pt(e.x, e.y);
      pt(e.x + e.w, e.y, "extent");
      break;
    case "circle":
      pt(e.x - e.r, e.y - e.r, "circle");
      pt(e.x + e.r, e.y + e.r, "circle");
      break;
    default:
      pt(e.x, e.y);
  }
  return out;
}

/** Everything wrong with a diagram, as plain sentences. Empty means valid. */
export function diagramProblems(spec: DiagramSpec | undefined): string[] {
  if (!spec) return ["no diagram"];
  const out: string[] = [];
  if (!(ARCHETYPES as readonly string[]).includes(spec.archetype))
    out.push("unknown archetype");
  if (!["GRID", "LANE", "HALF_PITCH", "PITCH"].includes(spec.board))
    out.push("unknown board");
  if (!spec.caption || spec.caption.trim().length < 30)
    out.push("caption is missing or too short to describe the layout");
  if (!Array.isArray(spec.elements) || spec.elements.length < 4)
    out.push("too few elements");
  else {
    spec.elements.forEach((e, i) =>
      out.push(...elementProblems(e, `element ${i + 1} (${e.kind})`)),
    );
    if (!spec.elements.some((e) => ["player", "cone", "marker"].includes(e.kind)))
      out.push("no players, cones or markers");
  }
  return out;
}
