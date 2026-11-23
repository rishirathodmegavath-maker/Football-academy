import type {
  ArchetypeId,
  DiagramElement as E,
  DiagramSpec,
  DiagramTeam,
} from "@/domain/drill-library";

// Reusable, structured diagram archetypes. Every layout is schematic: a 100 x 64
// board of abstract units, never to scale, with no real distances. A drill picks
// an archetype and adds its own elements, so no two drills share one picture.

type Board = DiagramSpec["board"];
export const P = (
  x: number,
  y: number,
  team: DiagramTeam,
  label?: string,
): E => ({ kind: "player", x, y, team, ...(label ? { label } : {}) });
export const C = (x: number, y: number): E => ({ kind: "cone", x, y });
export const Ball = (x: number, y: number): E => ({ kind: "ball", x, y });
export const Mark = (x: number, y: number, label: string): E => ({
  kind: "marker",
  x,
  y,
  label,
});
export const Zone = (
  x: number,
  y: number,
  w: number,
  h: number,
  label?: string,
): E => ({ kind: "zone", x, y, w, h, ...(label ? { label } : {}) });
export const Goal = (x: number, y: number, w: number, h?: number): E => ({
  kind: "goal",
  x,
  y,
  w,
  ...(h ? { h } : {}),
});
export const Hurdle = (x: number, y: number, w: number): E => ({
  kind: "hurdle",
  x,
  y,
  w,
});
export const Wall = (x: number, y: number, w: number): E => ({
  kind: "wall",
  x,
  y,
  w,
});
export const Circle = (x: number, y: number, r: number): E => ({
  kind: "circle",
  x,
  y,
  r,
});
export const Text = (x: number, y: number, text: string): E => ({
  kind: "label",
  x,
  y,
  text,
});
const arrow =
  (type: "PASS" | "RUN" | "DRIBBLE") =>
  (x1: number, y1: number, x2: number, y2: number, order?: number): E => ({
    kind: "arrow",
    type,
    x1,
    y1,
    x2,
    y2,
    ...(order ? { order } : {}),
  });
export const Pass = arrow("PASS");
export const Run = arrow("RUN");
export const Drib = arrow("DRIBBLE");

export function layout(
  archetype: ArchetypeId,
  board: Board,
  elements: E[],
  caption: string,
): DiagramSpec {
  return { archetype, board, elements, caption };
}

// ------------------------------------------------------------- archetypes

/** A row of cones with a dribbler weaving through to a finish marker. */
export function slalom(o: {
  cones?: number;
  caption: string;
  extra?: E[];
  withBall?: boolean;
}): DiagramSpec {
  const n = o.cones ?? 6,
    xs = Array.from({ length: n }, (_, i) => 20 + (i * 60) / (n - 1));
  const els: E[] = [P(8, 32, "A")];
  if (o.withBall !== false) els.push(Ball(12, 32));
  xs.forEach((x) => els.push(C(x, 32)));
  let px = 8,
    py = 32;
  xs.forEach((x, i) => {
    const ny = 32 + (i % 2 === 0 ? -9 : 9);
    els.push(Drib(px, py, x, ny, i + 1));
    px = x;
    py = ny;
  });
  els.push(Drib(px, py, 92, 32, n + 1), Mark(8, 46, "Start"), Mark(92, 46, "Finish"));
  return layout("slalom", "LANE", [...els, ...(o.extra ?? [])], o.caption);
}

/** A bounded grid with corner cones; the drill adds its own players. */
export function grid(o: {
  players: E[];
  caption: string;
  extra?: E[];
  board?: Board;
  area?: { x: number; y: number; w: number; h: number };
}): DiagramSpec {
  const a = o.area ?? { x: 18, y: 6, w: 64, h: 52 };
  return layout(
    "grid",
    o.board ?? "GRID",
    [
      Zone(a.x, a.y, a.w, a.h),
      C(a.x, a.y),
      C(a.x + a.w, a.y),
      C(a.x, a.y + a.h),
      C(a.x + a.w, a.y + a.h),
      ...o.players,
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** Outside players around a shape with defenders (and optional neutrals) inside. */
export function rondo(o: {
  outer: number;
  inner: number;
  neutral?: number;
  shape?: "square" | "circle";
  caption: string;
  extra?: E[];
}): DiagramSpec {
  const cx = 50,
    cy = 32,
    els: E[] = [];
  if (o.shape === "circle") els.push(Circle(cx, cy, 22));
  else
    els.push(
      Zone(28, 10, 44, 44),
      C(28, 10),
      C(72, 10),
      C(28, 54),
      C(72, 54),
    );
  const pos = Array.from({ length: o.outer }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / o.outer;
    const r = o.shape === "circle" ? 22 : 24;
    return {
      x: Math.round((cx + r * Math.cos(a) * 1.1) * 10) / 10,
      y: Math.round((cy + r * Math.sin(a)) * 10) / 10,
    };
  });
  pos.forEach((p, i) =>
    els.push(P(Math.min(95, Math.max(5, p.x)), p.y, "A", String(i + 1))),
  );
  for (let i = 0; i < o.inner; i++)
    els.push(P(cx - 4 + i * 8, cy - 3 + (i % 2) * 6, "B"));
  for (let i = 0; i < (o.neutral ?? 0); i++)
    els.push(P(cx - 8 + i * 12, cy + 8, "N"));
  els.push(Ball(pos[0].x + 2, pos[0].y + 2));
  for (let i = 0; i < Math.min(o.outer, 4); i++) {
    const a = pos[i],
      b = pos[(i + 1) % o.outer];
    els.push(Pass(a.x, a.y, b.x, b.y, i + 1));
  }
  return layout("rondo", "GRID", [...els, ...(o.extra ?? [])], o.caption);
}

/** Three players at the corners of a triangle. */
export function triangle(o: { caption: string; extra?: E[] }): DiagramSpec {
  return layout(
    "triangle",
    "GRID",
    [
      Zone(14, 6, 72, 52),
      C(50, 8),
      C(20, 54),
      C(80, 54),
      P(50, 12, "A", "1"),
      P(24, 50, "A", "2"),
      P(76, 50, "A", "3"),
      Ball(53, 14),
      Pass(50, 14, 28, 47, 1),
      Pass(28, 52, 72, 52, 2),
      Pass(76, 47, 54, 15, 3),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** Two triangles that meet at a narrow waist. */
export function hourglass(o: { caption: string; extra?: E[] }): DiagramSpec {
  return layout(
    "hourglass",
    "GRID",
    [
      C(22, 8),
      C(78, 8),
      C(50, 32),
      C(22, 56),
      C(78, 56),
      P(22, 12, "A", "1"),
      P(78, 12, "A", "2"),
      P(50, 36, "A", "3"),
      P(22, 52, "A", "4"),
      P(78, 52, "A", "5"),
      Ball(25, 14),
      Pass(25, 14, 48, 33, 1),
      Pass(52, 37, 76, 50, 2),
      Pass(75, 52, 25, 52, 3),
      Pass(24, 50, 48, 38, 4),
      Pass(52, 34, 76, 14, 5),
      Text(50, 62, "Timed round"),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** A rebound surface at the top of a marked lane. */
export function wallLane(o: { caption: string; extra?: E[] }): DiagramSpec {
  return layout(
    "wall-lane",
    "LANE",
    [
      Wall(30, 6, 40),
      Zone(36, 10, 28, 46, "Own lane"),
      P(50, 52, "A"),
      Ball(50, 48),
      Pass(46, 47, 46, 10, 1),
      Pass(54, 10, 54, 46, 2),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** A lane with low soft hurdles, a landing area and a goal. */
export function shootingLane(o: {
  caption: string;
  hurdles?: number;
  extra?: E[];
}): DiagramSpec {
  const hurdles = Array.from({ length: o.hurdles ?? 2 }, (_, i) =>
    Hurdle(50, 46 - i * 6, 14),
  );
  return layout(
    "shooting-lane",
    "HALF_PITCH",
    [
      Goal(38, 2, 24),
      Zone(40, 24, 20, 8, "Landing area"),
      ...hurdles,
      P(50, 56, "A"),
      Ball(52, 56),
      Run(50, 54, 50, 36, 1),
      Pass(50, 26, 50, 7, 2),
      Zone(74, 36, 22, 24, "Waiting area"),
      P(80, 44, "A"),
      P(88, 44, "A"),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** Three teams: a pressing pair, a possession group and a resting team. */
export function threeTeamRotation(o: {
  caption: string;
  extra?: E[];
}): DiagramSpec {
  return layout(
    "three-team-rotation",
    "GRID",
    [
      Zone(10, 6, 56, 52, "Playing grid"),
      C(10, 6),
      C(66, 6),
      C(10, 58),
      C(66, 58),
      P(22, 16, "B", "1"),
      P(54, 16, "B", "2"),
      P(22, 48, "B", "3"),
      P(54, 48, "B", "4"),
      P(36, 30, "A", "P"),
      P(44, 34, "A", "P"),
      Ball(24, 18),
      Pass(24, 17, 52, 17, 1),
      Run(38, 31, 52, 20, 2),
      Zone(74, 8, 22, 48, "Resting team"),
      P(84, 18, "C"),
      P(84, 30, "C"),
      P(84, 42, "C"),
      Run(76, 30, 66, 30, 3),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** A square with a goal on each side and a team beside each goal. */
export function fourGoalGame(o: {
  caption: string;
  teams?: { A: number; B: number; C: number; D: number };
  extra?: E[];
}): DiagramSpec {
  const t = o.teams ?? { A: 2, B: 2, C: 2, D: 2 };
  const row = (n: number, x: number, y: number, team: DiagramTeam, dx: number, dy: number) =>
    Array.from({ length: n }, (_, i) => P(x + i * dx, y + i * dy, team));
  return layout(
    "four-goal-game",
    "GRID",
    [
      Zone(20, 10, 60, 44),
      Goal(40, 4, 20),
      Goal(40, 57, 20),
      Goal(14, 22, 3, 20),
      Goal(83, 22, 3, 20),
      ...row(t.A, 42, 14, "A", 14, 0),
      ...row(t.B, 42, 50, "B", 14, 0),
      ...row(t.C, 24, 26, "C", 0, 12),
      ...row(t.D, 76, 26, "D", 0, 12),
      Ball(44, 16),
      Pass(44, 16, 74, 30, 1),
      Pass(74, 30, 44, 49, 2),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

/** A full pitch in thirds with a team shape and a switch of play. */
export function pitchThirds(o: { caption: string; extra?: E[] }): DiagramSpec {
  return layout(
    "pitch-thirds",
    "PITCH",
    [
      Zone(2, 2, 32, 60, "Defensive third"),
      Zone(34, 2, 32, 60, "Middle third"),
      Zone(66, 2, 32, 60, "Attacking third"),
      Goal(0, 26, 2, 12),
      Goal(98, 26, 2, 12),
      P(12, 12, "A"),
      P(12, 26, "A"),
      P(12, 38, "A"),
      P(12, 52, "A"),
      P(42, 16, "A"),
      P(42, 32, "A"),
      P(42, 48, "A"),
      P(76, 12, "A"),
      P(78, 32, "A"),
      P(76, 52, "A"),
      Ball(44, 16),
      Pass(44, 16, 74, 50, 1),
      Run(42, 32, 52, 40, 2),
      Run(76, 12, 70, 24, 3),
      ...(o.extra ?? []),
    ],
    o.caption,
  );
}

// ------------------------------------------------------------- presets

export const PRESET_LABELS: Record<ArchetypeId, string> = {
  slalom: "Cone slalom",
  grid: "Grid with players",
  rondo: "Rondo: outside players and defenders",
  triangle: "Triangle of three players",
  hourglass: "Hourglass of five players",
  "wall-lane": "Rebound wall and lane",
  "shooting-lane": "Shooting lane with goal",
  "three-team-rotation": "Three-team rotation",
  "four-goal-game": "Four-goal game",
  "pitch-thirds": "Pitch in thirds",
};

/** The predefined layout an academy-created drill can choose. A custom diagram
 * builder is not part of this release. */
export function presetDiagram(archetype: ArchetypeId): DiagramSpec {
  const caption = (what: string) =>
    `Predefined layout: ${what}. Describe the exact positions in the setup notes.`;
  switch (archetype) {
    case "slalom":
      return slalom({
        caption: caption("a player dribbling through a line of cones"),
      });
    case "rondo":
      return rondo({
        outer: 4,
        inner: 2,
        caption: caption("four outside players and two defenders"),
      });
    case "triangle":
      return triangle({
        caption: caption("three players passing around a triangle"),
      });
    case "hourglass":
      return hourglass({
        caption: caption("five players passing through an hourglass"),
      });
    case "wall-lane":
      return wallLane({
        caption: caption("a player in a lane facing a rebound wall"),
      });
    case "shooting-lane":
      return shootingLane({
        caption: caption("a lane leading to a goal"),
        hurdles: 1,
      });
    case "three-team-rotation":
      return threeTeamRotation({
        caption: caption("three teams rotating through one grid"),
      });
    case "four-goal-game":
      return fourGoalGame({ caption: caption("four teams with a goal each") });
    case "pitch-thirds":
      return pitchThirds({
        caption: caption("a team shape across the thirds of the pitch"),
      });
    default:
      return grid({
        players: [
          P(30, 20, "A"),
          P(70, 20, "A"),
          P(50, 44, "B"),
          Ball(32, 22),
          Pass(32, 22, 68, 22, 1),
        ],
        caption: caption("players working inside a marked grid"),
      });
  }
}
