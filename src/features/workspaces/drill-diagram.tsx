import { useId } from "react";
import {
  DIAGRAM_BOARD,
  type DiagramElement,
  type DiagramSpec,
  type DiagramTeam,
} from "@/domain/drill-library";

// Renders a structured, schematic drill diagram as inline SVG. There is no
// graphics dependency and no external file: the same data drives every drill.
// The board is 100 x 64 abstract units and is not to scale.

const TEAM_FILL: Record<DiagramTeam, string> = {
  A: "#2563eb",
  B: "#dc2626",
  C: "#d97706",
  D: "#7c3aed",
  N: "#f8fafc",
  GK: "#facc15",
  CO: "#0f172a",
};
const TEAM_TEXT: Record<DiagramTeam, string> = {
  A: "#fff",
  B: "#fff",
  C: "#fff",
  D: "#fff",
  N: "#0f172a",
  GK: "#0f172a",
  CO: "#fff",
};
const W = DIAGRAM_BOARD.width,
  H = DIAGRAM_BOARD.height;

function Field({ board }: { board: DiagramSpec["board"] }) {
  const line = { fill: "none", stroke: "#bbd6ad", strokeWidth: 0.5 };
  return (
    <>
      <rect width={W} height={H} rx={3} fill="#388b48" />
      {board === "PITCH" && (
        <>
          <rect x={2} y={2} width={W - 4} height={H - 4} {...line} />
          <path d={`M${W / 2} 2V${H - 2}`} {...line} />
          <circle cx={W / 2} cy={H / 2} r={9} {...line} />
        </>
      )}
      {board === "HALF_PITCH" && (
        <>
          <rect x={2} y={2} width={W - 4} height={H - 4} {...line} />
          <path d={`M2 ${H - 2}H${W - 2}`} {...line} />
          <rect x={30} y={2} width={40} height={14} {...line} />
        </>
      )}
      {(board === "GRID" || board === "LANE") && (
        <rect x={1.5} y={1.5} width={W - 3} height={H - 3} {...line} strokeDasharray="1.5 1.5" />
      )}
    </>
  );
}

function Arrow({
  e,
  head,
}: {
  e: Extract<DiagramElement, { kind: "arrow" }>;
  head: string;
}) {
  const dash =
    e.type === "PASS" ? "2.2 1.6" : e.type === "DRIBBLE" ? "0.5 1.6" : undefined;
  const mx = (e.x1 + e.x2) / 2,
    my = (e.y1 + e.y2) / 2;
  return (
    <g>
      <line
        x1={e.x1}
        y1={e.y1}
        x2={e.x2}
        y2={e.y2}
        stroke="#ffffff"
        strokeWidth={e.type === "DRIBBLE" ? 1 : 0.8}
        strokeLinecap="round"
        strokeDasharray={dash}
        markerEnd={`url(#${head})`}
      />
      {e.order ? (
        <>
          <circle cx={mx} cy={my} r={2} fill="#0f172a" opacity={0.85} />
          <text x={mx} y={my + 0.9} fontSize={2.6} textAnchor="middle" fill="#fff" fontWeight={700}>
            {e.order}
          </text>
        </>
      ) : null}
    </g>
  );
}

function Element({ e, head }: { e: DiagramElement; head: string }) {
  switch (e.kind) {
    case "zone":
      return (
        <g>
          <rect x={e.x} y={e.y} width={e.w} height={e.h} fill="#ffffff" fillOpacity={0.08} stroke="#e2f0d9" strokeWidth={0.4} strokeDasharray="1.2 1.2" />
          {e.label ? (
            <text x={e.x + 1.2} y={e.y + 3.4} fontSize={2.6} fill="#f1f5f9">
              {e.label}
            </text>
          ) : null}
        </g>
      );
    case "circle":
      return <circle cx={e.x} cy={e.y} r={e.r} fill="none" stroke="#e2f0d9" strokeWidth={0.5} strokeDasharray="1.2 1.2" />;
    case "goal":
      return <rect x={e.x} y={e.y} width={e.w} height={e.h ?? 3} fill="#ffffff" fillOpacity={0.9} stroke="#0f172a" strokeWidth={0.3} />;
    case "wall":
      return <rect x={e.x} y={e.y} width={e.w} height={2.4} fill="#94a3b8" stroke="#0f172a" strokeWidth={0.3} />;
    case "hurdle":
      return (
        <g>
          <rect x={e.x - e.w / 2} y={e.y - 0.8} width={e.w} height={1.6} rx={0.6} fill="#fb923c" stroke="#7c2d12" strokeWidth={0.25} />
        </g>
      );
    case "cone":
      return <path d={`M${e.x} ${e.y - 1.6}L${e.x + 1.4} ${e.y + 1.2}H${e.x - 1.4}Z`} fill="#f97316" stroke="#7c2d12" strokeWidth={0.25} />;
    case "marker":
      return (
        <text x={e.x} y={e.y} fontSize={2.8} textAnchor="middle" fill="#f8fafc" fontWeight={700}>
          {e.label}
        </text>
      );
    case "label":
      return (
        <text x={e.x} y={e.y} fontSize={2.8} textAnchor="middle" fill="#f8fafc">
          {e.text}
        </text>
      );
    case "arrow":
      return <Arrow e={e} head={head} />;
    case "ball":
      return <circle cx={e.x} cy={e.y} r={1.1} fill="#ffffff" stroke="#0f172a" strokeWidth={0.35} />;
    case "player":
      return (
        <g>
          <circle cx={e.x} cy={e.y} r={2.5} fill={TEAM_FILL[e.team]} stroke="#0f172a" strokeWidth={0.4} />
          <text x={e.x} y={e.y + 1} fontSize={2.8} textAnchor="middle" fill={TEAM_TEXT[e.team]} fontWeight={700}>
            {e.label ?? (e.team === "N" ? "N" : e.team === "GK" ? "GK" : e.team)}
          </text>
        </g>
      );
  }
}

const ORDER: Record<DiagramElement["kind"], number> = {
  zone: 0,
  circle: 1,
  wall: 2,
  goal: 3,
  hurdle: 4,
  cone: 5,
  arrow: 6,
  ball: 7,
  player: 8,
  marker: 9,
  label: 9,
};

/** The structured diagram of a drill. `caption` is the accessible description. */
export function DrillDiagram({
  spec,
  className,
}: {
  spec: DiagramSpec;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const head = `dl-head-${id}`;
  const elements = [...spec.elements].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return (
    <figure className={`dl-diagram ${className ?? ""}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={spec.caption}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id={head} markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
            <path d="M0 0L4 2L0 4Z" fill="#ffffff" />
          </marker>
        </defs>
        <Field board={spec.board} />
        {elements.map((e, i) => (
          <Element key={i} e={e} head={head} />
        ))}
      </svg>
      <figcaption>
        {spec.caption}{" "}
        <span className="dl-legend">
          Pass: dashed · Run: solid · Dribble: dotted. Schematic, not to scale.
        </span>
      </figcaption>
    </figure>
  );
}
