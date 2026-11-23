"use client";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { presetDiagram } from "@/config/drills/diagrams";
import {
  DRILL_CATEGORIES,
  type DiagramSpec,
} from "@/domain/drill-library";
import type { DrillCatalogue } from "@/hooks/use-drill-catalogue";
import type { WorkspaceDrill } from "@/domain/workspace";
import {
  hasSavedContent,
  snapshotItem,
  type LibraryFilters,
  type LibraryItem,
} from "@/services/drill-library-view";
import { DrillDiagram } from "./drill-diagram";
import "./drill-library.css";
import { displayDay } from "@/services/date-display";

export const diagramOf = (item: LibraryItem): DiagramSpec | undefined =>
  item.content.diagram ??
  (item.content.diagramPreset
    ? presetDiagram(item.content.diagramPreset)
    : undefined);

export const sourceLabel = (item: LibraryItem) =>
  item.source === "UNIVERSAL"
    ? `Universal #${item.number}`
    : item.source === "COPY"
      ? "Academy copy"
      : "Academy drill";

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function SourceBadges({ item }: { item: LibraryItem }) {
  return (
    <p className="dl-badges">
      <span className={`dl-badge dl-${item.source.toLowerCase()}`}>
        {sourceLabel(item)}
      </span>
      <span className="dl-badge">{item.categoryName}</span>
      {item.archived && <span className="dl-badge dl-archived">Archived</span>}
    </p>
  );
}

/** Search, the seven category filters, source and archive filters. */
export function FilterBar({
  catalogue,
  items,
  filters,
  onChange,
  idPrefix,
  hideArchived,
}: {
  catalogue?: DrillCatalogue;
  items: LibraryItem[];
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  idPrefix: string;
  hideArchived?: boolean;
}) {
  const hasUncategorised = items.some((i) => !i.categoryId && !i.archived);
  const under =
    (catalogue?.categories ?? []).reduce(
      (n, c) => n + (c.initialCount - c.publishedCount),
      0,
    );
  const count = (id: string) =>
    items.filter((i) => !i.archived && i.categoryId === id).length;
  return (
    <div className="dl-filters">
      <label className="dl-search" htmlFor={`${idPrefix}-search`}>
        <span>Search drills</span>
        <span className="dl-search-box">
          <Search size={15} aria-hidden="true" />
          <input
            id={`${idPrefix}-search`}
            type="search"
            value={filters.query}
            placeholder="Name, skill or tag…"
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
          />
        </span>
      </label>
      <div role="group" aria-label="Drill categories" className="dl-chips">
        <button
          type="button"
          aria-pressed={filters.category === "all"}
          onClick={() => onChange({ ...filters, category: "all" })}
        >
          All categories
        </button>
        {DRILL_CATEGORIES.map((c) => (
          <button
            type="button"
            key={c.id}
            aria-pressed={filters.category === c.id}
            title={`${c.initialCount} original universal drills`}
            onClick={() => onChange({ ...filters, category: c.id })}
          >
            {c.name} <span className="dl-count">{count(c.id)}</span>
          </button>
        ))}
        {hasUncategorised && (
          <button
            type="button"
            aria-pressed={filters.category === "uncategorised"}
            onClick={() => onChange({ ...filters, category: "uncategorised" })}
          >
            Uncategorised
          </button>
        )}
      </div>
      <div className="dl-row">
        <label>
          <span>Source</span>
          <select
            value={filters.source}
            onChange={(e) =>
              onChange({
                ...filters,
                source: e.target.value as LibraryFilters["source"],
              })
            }
          >
            <option value="all">All drills</option>
            <option value="UNIVERSAL">Universal only</option>
            <option value="ACADEMY">Academy-owned only</option>
          </select>
        </label>
        {!hideArchived && (
          <label className="dl-check">
            <input
              type="checkbox"
              checked={filters.showArchived}
              onChange={(e) =>
                onChange({ ...filters, showArchived: e.target.checked })
              }
            />
            Show archived
          </label>
        )}
      </div>
      {under > 0 && (
        <p className="dl-note" role="note">
          {under} original universal drill{under === 1 ? " is" : "s are"} under
          review and not yet available.
        </p>
      )}
    </div>
  );
}

export function DrillCard({
  item,
  actions,
}: {
  item: LibraryItem;
  actions: ReactNode;
}) {
  const diagram = diagramOf(item);
  return (
    <article className="dl-card" aria-label={item.name}>
      {diagram ? (
        <DrillDiagram spec={diagram} className="dl-thumb" />
      ) : (
        <div className="dl-thumb dl-nothumb" aria-hidden="true" />
      )}
      <div className="dl-card-body">
        <SourceBadges item={item} />
        <h3>{item.name}</h3>
        <p className="dl-summary">{item.summary}</p>
        <p className="dl-meta">
          {item.content.difficulty ? title(item.content.difficulty) : null}
          {item.content.durationMinutes
            ? ` · ${item.content.durationMinutes} min`
            : ""}
          {item.content.players
            ? ` · ${item.content.players.min}–${item.content.players.max} players`
            : ""}
        </p>
        <div className="dl-actions">{actions}</div>
      </div>
    </article>
  );
}

const List = ({ items, ordered }: { items?: string[]; ordered?: boolean }) =>
  !items?.length ? null : ordered ? (
    <ol>{items.map((t, i) => <li key={i}>{t}</li>)}</ol>
  ) : (
    <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
  );
const Section = ({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) => (
  <section className="dl-section">
    <h4>{heading}</h4>
    {children}
  </section>
);

/** The full coaching detail of a drill. All of it is for staff only. */
export function DrillDetail({ item }: { item: LibraryItem }) {
  const c = item.content,
    diagram = diagramOf(item);
  return (
    <div className="dl-detail">
      <SourceBadges item={item} />
      {item.minimumAgeYears ? (
        <p className="dl-warning" role="note">
          Minimum age {item.minimumAgeYears}. This is an internal Sportozen
          restriction, not a football association rule.
        </p>
      ) : null}
      {diagram && <DrillDiagram spec={diagram} />}
      <p className="dl-note" role="note">
        Name, purpose and coaching cue can appear in family reports. Everything
        else on this page is for authorised staff only.
      </p>
      <Section heading="Purpose and cue">
        <p>{item.purpose}</p>
        <p>
          <strong>Coaching cue:</strong> {item.cue}
        </p>
      </Section>
      {item.originalObjective && (
        <Section heading="Approved objective">
          <p className="dl-objective">{item.originalObjective}</p>
        </Section>
      )}
      {c.description && (
        <Section heading="Description">
          <p>{c.description}</p>
        </Section>
      )}
      <dl className="dl-facts">
        {c.skills?.length ? (
          <>
            <dt>Skills developed</dt>
            <dd>{c.skills.join(", ")}</dd>
          </>
        ) : null}
        {c.ageBands?.length ? (
          <>
            <dt>Suitable age groups</dt>
            <dd>{c.ageBands.join(", ")}</dd>
          </>
        ) : null}
        {c.difficulty ? (
          <>
            <dt>Difficulty</dt>
            <dd>{title(c.difficulty)}</dd>
          </>
        ) : null}
        {c.durationMinutes ? (
          <>
            <dt>Recommended duration</dt>
            <dd>{c.durationMinutes} minutes</dd>
          </>
        ) : null}
        {c.players ? (
          <>
            <dt>Players</dt>
            <dd>
              {c.players.min}–{c.players.max}
              {c.players.note ? ` (${c.players.note})` : ""}
            </dd>
          </>
        ) : null}
        {c.phase ? (
          <>
            <dt>Training phase</dt>
            <dd>{title(c.phase.replace("_", " "))}</dd>
          </>
        ) : null}
        {c.intensity ? (
          <>
            <dt>Intensity</dt>
            <dd>{title(c.intensity)}</dd>
          </>
        ) : null}
      </dl>
      {c.equipment?.length ? (
        <Section heading="Equipment">
          <List items={c.equipment} />
        </Section>
      ) : null}
      {c.setup && (c.setup.layout || c.setup.dimensions) ? (
        <Section heading="Setup">
          {c.setup.layout && <p>{c.setup.layout}</p>}
          {c.setup.dimensions && <p>{c.setup.dimensions}</p>}
        </Section>
      ) : null}
      {c.steps?.length ? (
        <Section heading="Instructions">
          <List items={c.steps} ordered />
        </Section>
      ) : null}
      {c.coachingPoints?.length ? (
        <Section heading="Coaching points">
          <List items={c.coachingPoints} />
        </Section>
      ) : null}
      {c.commonMistakes?.length ? (
        <Section heading="Common mistakes">
          <List items={c.commonMistakes} />
        </Section>
      ) : null}
      {c.progressions &&
      (c.progressions.easier?.length || c.progressions.harder?.length) ? (
        <Section heading="Progressions">
          {c.progressions.easier?.length ? (
            <>
              <h5>Easier</h5>
              <List items={c.progressions.easier} />
            </>
          ) : null}
          {c.progressions.harder?.length ? (
            <>
              <h5>Harder</h5>
              <List items={c.progressions.harder} />
            </>
          ) : null}
        </Section>
      ) : null}
      {c.safety?.length ? (
        <Section heading="Safety">
          <List items={c.safety} />
        </Section>
      ) : null}
      {item.interpretation && (
        <Section heading="Interpretation">
          <p>{item.interpretation}</p>
        </Section>
      )}
      {item.distinctFrom?.length ? (
        <Section heading="Not to be confused with">
          <ul>
            {item.distinctFrom.map((x) => (
              <li key={x.number}>
                <strong>Drill {x.number}:</strong> {x.difference}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {c.tags?.length ? (
        <p className="dl-tags">
          {c.tags.map((t) => (
            <span key={t} className="dl-badge">
              {t}
            </span>
          ))}
        </p>
      ) : null}
      {c.references?.length ? (
        <Section heading="References">
          <ul className="dl-refs">
            {c.references.map((r, i) => (
              <li key={i}>
                <strong>{r.title}</strong>
                {r.publisher ? `, ${r.publisher}` : ""}
                {r.url ? (
                  <>
                    {" "}
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      Source link
                    </a>
                  </>
                ) : null}
                <br />
                {r.use}
                {r.access === "LOCATED_NOT_OPENED"
                  ? " (Located by search; not yet verified against the page.)"
                  : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {item.universalVersion ? (
        <p className="dl-version">
          Content version {item.universalVersion}
          {item.source === "COPY"
            ? ". This is your academy's own copy; the universal drill is unchanged."
            : ""}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The diagram of a drill saved in a session, taken ONLY from what the session
 * stored (never from today's catalogue), or `fallback` for a drill that was
 * saved without one. Used where the session plan lists its drills.
 */
export function AgendaThumb({
  drill,
  fallback,
}: {
  drill: WorkspaceDrill;
  fallback: ReactNode;
}) {
  const spec: DiagramSpec | undefined =
    drill.content?.diagram ??
    (drill.content?.diagramPreset
      ? presetDiagram(drill.content.diagramPreset)
      : undefined);
  return spec ? (
    <DrillDiagram spec={spec} className="dl-thumb dl-agenda-thumb" />
  ) : (
    <>{fallback}</>
  );
}

/**
 * Everything a coach needs to run a drill, drawn from the snapshot the session
 * saved. A catalogue drill saved before complete snapshots existed says so and
 * is never filled in from today's catalogue.
 */
export function SessionDrillDetail({ drill }: { drill: WorkspaceDrill }) {
  if (!hasSavedContent(drill))
    return (
      <div className="dl-detail" data-testid="historical-content-unavailable">
        <p className="dl-warning" role="note">
          Historical content unavailable. This session was saved before drill
          instructions were kept with it, so only the name, purpose and cue
          below are known to be what was planned. Today&apos;s library may have
          changed since.
        </p>
        <p>
          <strong>Purpose:</strong> {drill.purpose}
        </p>
        <p>
          <strong>Coaching cue:</strong> {drill.cue}
        </p>
      </div>
    );
  const item = snapshotItem(drill);
  return (
    <div data-testid="session-drill-detail">
      {drill.snapshot ? (
        <p className="dl-version">
          Saved with this session
          {drill.snapshot.capturedAt
            ? ` on ${displayDay(drill.snapshot.capturedAt)}`
            : ""}
          . Content version {drill.snapshot.contentVersion}. Later changes to the
          library do not change this plan.
        </p>
      ) : null}
      {!drill.content ? (
        <p className="dl-note" role="note">
          No detailed coaching content was recorded for this drill.
        </p>
      ) : null}
      <DrillDetail item={item} />
    </div>
  );
}
