"use client";
import { useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { PRESET_LABELS } from "@/config/drills/diagrams";
import { operationalSports } from "@/config/sports/workspace-sports";
import {
  AGE_BANDS,
  ARCHETYPES,
  DIFFICULTIES,
  DRILL_CATEGORIES,
  INTENSITIES,
  PARENT_CUE_MAX,
  PARENT_PURPOSE_MAX,
  PHASES,
  type AcademyDrillContent,
  type AgeBand,
  type ArchetypeId,
} from "@/domain/drill-library";
import type { WorkspaceDrill } from "@/domain/workspace";
import { useDrillCatalogue } from "@/hooks/use-drill-catalogue";
import {
  NO_FILTERS,
  filterItems,
  libraryItems,
  type LibraryFilters,
  type LibraryItem,
} from "@/services/drill-library-view";
import type { PortalController } from "./portal-types";
import { DrillCard, DrillDetail, FilterBar } from "./drill-library-parts";
import "./drill-library.css";
import { displayInstant } from "@/services/date-display";

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const joined = (values?: string[]) => (values ?? []).join("\n");
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ");

/**
 * The drill library inside Training: the universal catalogue and the academy's
 * own drills together, with search and filters, full coaching detail, academy
 * drill management and customising a universal drill. The server decides who
 * may change what; this screen only offers the actions.
 */
export function DrillLibrary({ workspace: w }: { workspace: PortalController }) {
  const d = w.data!,
    catalogue = useDrillCatalogue(w),
    [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS),
    [openId, setOpenId] = useState<string>(),
    [form, setForm] = useState<{ item?: LibraryItem } | null>(null),
    [history, setHistory] = useState<{
      item: LibraryItem;
      loading: boolean;
      error?: string;
      revisions?: DrillRevisionView[];
    } | null>(null);
  const viewer = { userId: d.membership.userId, role: d.membership.role };
  const items = useMemo(
    () => libraryItems(catalogue.data?.drills ?? [], d.records.drill, viewer),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogue.data, d.records.drill, viewer.userId, viewer.role],
  );
  const shown = filterItems(items, filters),
    open = items.find((item) => item.id === openId);

  async function customise(item: LibraryItem) {
    const result = await w.action<{ drill: WorkspaceDrill; created: boolean }>(
      "customiseDrill",
      item.id,
    );
    if (result) setOpenId(result.drill.id);
  }
  async function archive(item: LibraryItem, archived: boolean) {
    await w.action(archived ? "archiveDrill" : "restoreDrill", item.id, {
      expectedVersion: item.recordVersion,
    });
  }
  async function showHistory(item: LibraryItem) {
    setHistory({ item, loading: true });
    try {
      const response = await fetch(
        `/api/workspaces/${d.academy.id}/drills/${encodeURIComponent(item.id)}/revisions`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as {
        revisions?: DrillRevisionView[];
        error?: string;
      };
      if (!response.ok || !body.revisions)
        throw new Error(body.error ?? "Could not load the history.");
      setHistory({ item, loading: false, revisions: body.revisions });
    } catch (error) {
      setHistory({
        item,
        loading: false,
        error:
          error instanceof Error ? error.message : "Could not load the history.",
      });
    }
  }

  const detailActions = (item: LibraryItem): ReactNode => {
    if (item.source === "UNIVERSAL")
      return item.copyId ? (
        <button
          type="button"
          className="dl-btn"
          onClick={() => setOpenId(item.copyId)}
        >
          Open your academy copy
        </button>
      ) : (
        <button
          type="button"
          className="dl-btn dl-primary"
          disabled={w.busy}
          onClick={() => void customise(item)}
        >
          Customise for your academy
        </button>
      );
    if (!item.canManage)
      return (
        <p className="dl-note">
          Only the academy owner, an admin, or the coach who created this drill
          can change it. To have another coach&rsquo;s drill changed, ask the
          academy owner or an admin.
        </p>
      );
    const historyButton = (
      <button
        type="button"
        className="dl-btn"
        onClick={() => void showHistory(item)}
      >
        History
      </button>
    );
    return item.archived ? (
      <>
        <button
          type="button"
          className="dl-btn"
          disabled={w.busy}
          onClick={() => void archive(item, false)}
        >
          Restore drill
        </button>
        {historyButton}
      </>
    ) : (
      <>
        <button
          type="button"
          className="dl-btn dl-primary"
          onClick={() => setForm({ item })}
        >
          Edit drill
        </button>
        {historyButton}
        <button
          type="button"
          className="dl-btn"
          disabled={w.busy}
          onClick={() => void archive(item, true)}
        >
          Archive drill
        </button>
      </>
    );
  };

  return (
    <div className="pt-library dl-library">
      <header className="dl-header">
        <div>
          <h2>Drill library</h2>
          <p>
            Universal drills are maintained centrally and cannot be edited.
            Customise one to make your own academy copy, or create a drill of
            your own. Older drills without a category show as Uncategorised
            until they are edited.
          </p>
        </div>
        <button
          type="button"
          className="dl-btn dl-primary"
          onClick={() => setForm({})}
        >
          <Plus size={16} aria-hidden="true" /> New academy drill
        </button>
      </header>
      {catalogue.error && (
        <p role="alert">
          {catalogue.error}{" "}
          <button type="button" className="dl-btn" onClick={catalogue.reload}>
            Try again
          </button>
        </p>
      )}
      {w.error && !form && !open && <p role="alert">{w.error}</p>}
      <FilterBar
        idPrefix="library"
        catalogue={catalogue.data}
        items={items}
        filters={filters}
        onChange={setFilters}
      />
      <p className="dl-count-line" role="status">
        {catalogue.loading
          ? "Loading the universal library…"
          : `Showing ${shown.length} of ${items.filter((i) => !i.archived || filters.showArchived).length} drills.`}
      </p>
      <div className="dl-grid">
        {shown.map((item) => (
          <DrillCard
            key={item.id}
            item={item}
            actions={
              <button
                type="button"
                className="dl-btn"
                aria-label={`View details for ${item.name}`}
                onClick={() => setOpenId(item.id)}
              >
                View details
              </button>
            }
          />
        ))}
        {!shown.length && !catalogue.loading && (
          <p className="dl-empty">No drills match these filters.</p>
        )}
      </div>

      <Dialog.Root
        open={!!open}
        onOpenChange={(next) => {
          if (!next) setOpenId(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dl-overlay" />
          <Dialog.Content className="dl-dialog" aria-describedby={undefined}>
            <Dialog.Title>{open?.name}</Dialog.Title>
            <Dialog.Close className="dl-close" aria-label="Close drill details">
              <X size={18} />
            </Dialog.Close>
            {w.error && <p role="alert">{w.error}</p>}
            {open && <DrillDetail item={open} />}
            {open && <div className="dl-actions dl-sticky">{detailActions(open)}</div>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!history}
        onOpenChange={(next) => {
          if (!next) setHistory(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dl-overlay" />
          <Dialog.Content className="dl-dialog" aria-describedby={undefined}>
            <Dialog.Title>History of {history?.item.name}</Dialog.Title>
            <Dialog.Close className="dl-close" aria-label="Close drill history">
              <X size={18} />
            </Dialog.Close>
            {history && (
              <DrillHistory
                state={history}
                viewerId={viewer.userId}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!form}
        onOpenChange={(next) => {
          if (!next && !w.busy) setForm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dl-overlay" />
          <Dialog.Content className="dl-dialog" aria-describedby={undefined}>
            <Dialog.Title>
              {form?.item ? "Edit academy drill" : "New academy drill"}
            </Dialog.Title>
            <Dialog.Close className="dl-close" aria-label="Close drill form">
              <X size={18} />
            </Dialog.Close>
            {form && (
              <DrillForm
                key={form.item?.id ?? "new"}
                workspace={w}
                item={form.item}
                onDone={(saved) => {
                  setForm(null);
                  setOpenId(saved.id);
                }}
                onCancel={() => setForm(null)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** One revision as the history route returns it. */
interface DrillRevisionView {
  id: string;
  revision: number;
  at: string;
  actorId: string;
  actorRole: string;
  context: string;
  changedFields: string[];
  before: WorkspaceDrill | null;
  after: WorkspaceDrill;
}

const fieldValue = (drill: WorkspaceDrill | null, field: string): string => {
  if (!drill) return "";
  const value = field.startsWith("content.")
    ? (drill.content as Record<string, unknown> | undefined)?.[field.slice(8)]
    : (drill as unknown as Record<string, unknown>)[field];
  if (value === undefined || value === null) return "(empty)";
  if (Array.isArray(value)) return value.length ? value.join("; ") : "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value) || "(empty)";
};

/** The append-only revisions of one academy drill, newest first. */
function DrillHistory({
  state,
  viewerId,
}: {
  state: {
    loading: boolean;
    error?: string;
    revisions?: DrillRevisionView[];
  };
  viewerId: string;
}) {
  if (state.loading) return <p role="status">Loading the history…</p>;
  if (state.error) return <p role="alert">{state.error}</p>;
  return (
    <div className="dl-history">
      <p className="dl-note">
        Every change is kept as a separate revision. Earlier revisions are never
        rewritten.
      </p>
      <ol>
        {state.revisions!.map((r) => (
          <li key={r.id}>
            <strong>
              Revision {r.revision}: {r.context}
            </strong>
            <br />
            <small>
              {displayInstant(r.at, undefined, { time: true })} ·{" "}
              {r.actorRole === "SYSTEM"
                ? "recorded by the system"
                : r.actorId === viewerId
                  ? `you (${r.actorRole.toLowerCase()})`
                  : r.actorRole.toLowerCase()}
              {r.changedFields.length
                ? ` · changed: ${r.changedFields.join(", ")}`
                : ""}
            </small>
            {r.before &&
            r.changedFields.some((f) => f !== "created" && f !== "baseline") ? (
              <details>
                <summary>Before and after</summary>
                <dl className="dl-facts">
                  {r.changedFields.map((f) => (
                    <div key={f}>
                      <dt>{f}</dt>
                      <dd>Before: {fieldValue(r.before, f)}</dd>
                      <dd>After: {fieldValue(r.after, f)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DrillForm({
  workspace: w,
  item,
  onDone,
  onCancel,
}: {
  workspace: PortalController;
  item?: LibraryItem;
  onDone: (saved: WorkspaceDrill) => void;
  onCancel: () => void;
}) {
  const c: AcademyDrillContent = item?.content ?? {};
  const [name, setName] = useState(item?.name ?? ""),
    [category, setCategory] = useState<string>(item?.categoryId ?? ""),
    [focusArea, setFocusArea] = useState(
      item?.focusArea ?? operationalSports.football.skills[0],
    ),
    [purpose, setPurpose] = useState(item?.purpose ?? ""),
    [cue, setCue] = useState(item?.cue ?? ""),
    [description, setDescription] = useState(c.description ?? ""),
    [skills, setSkills] = useState((c.skills ?? []).join(", ")),
    [ageBands, setAgeBands] = useState<AgeBand[]>(c.ageBands ?? []),
    [difficulty, setDifficulty] = useState<string>(c.difficulty ?? ""),
    [duration, setDuration] = useState(c.durationMinutes?.toString() ?? ""),
    [playersMin, setPlayersMin] = useState(c.players?.min.toString() ?? ""),
    [playersMax, setPlayersMax] = useState(c.players?.max.toString() ?? ""),
    [equipment, setEquipment] = useState(joined(c.equipment)),
    [layout, setLayout] = useState(c.setup?.layout ?? ""),
    [dimensions, setDimensions] = useState(c.setup?.dimensions ?? ""),
    [steps, setSteps] = useState(joined(c.steps)),
    [points, setPoints] = useState(joined(c.coachingPoints)),
    [mistakes, setMistakes] = useState(joined(c.commonMistakes)),
    [easier, setEasier] = useState(joined(c.progressions?.easier)),
    [harder, setHarder] = useState(joined(c.progressions?.harder)),
    // Safety lines inherited from the library are shown separately and cannot
    // be removed, so this box holds only the academy's own additions.
    locked = item?.lockedSafety ?? [],
    [safety, setSafety] = useState(
      joined((c.safety ?? []).filter((line) => !locked.includes(line))),
    ),
    [ackClear, setAckClear] = useState(false),
    [phase, setPhase] = useState<string>(c.phase ?? ""),
    [intensity, setIntensity] = useState<string>(c.intensity ?? ""),
    [tags, setTags] = useState((c.tags ?? []).join(", ")),
    [source, setSource] = useState(""),
    [preset, setPreset] = useState<string>(c.diagramPreset ?? "");

  async function submit() {
    const players =
      playersMin && playersMax
        ? { min: Number(playersMin), max: Number(playersMax) }
        : undefined;
    const references = [
      ...(c.references ?? []),
      ...(source.trim()
        ? [
            {
              kind: "SOURCE" as const,
              title: source.trim(),
              use: "Recorded by the academy",
              access: "NONE" as const,
            },
          ]
        : []),
    ];
    // When editing, an emptied box is sent as an explicit empty value (the
    // server keeps anything not sent). Creating omits boxes left empty.
    const explicit = !!item;
    const content: AcademyDrillContent = {
      ...(description.trim() || explicit
        ? { description: description.trim() }
        : {}),
      ...(skills.trim() || explicit
        ? { skills: skills.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(ageBands.length || explicit ? { ageBands } : {}),
      ...(difficulty ? { difficulty: difficulty as "BEGINNER" } : {}),
      ...(duration ? { durationMinutes: Number(duration) } : {}),
      ...(players ? { players } : {}),
      ...(lines(equipment).length || explicit
        ? { equipment: lines(equipment) }
        : {}),
      ...(layout.trim() || dimensions.trim() || explicit
        ? { setup: { layout: layout.trim(), dimensions: dimensions.trim() } }
        : {}),
      ...(lines(steps).length || explicit ? { steps: lines(steps) } : {}),
      ...(lines(points).length || explicit
        ? { coachingPoints: lines(points) }
        : {}),
      ...(lines(mistakes).length || explicit
        ? { commonMistakes: lines(mistakes) }
        : {}),
      ...(lines(easier).length || lines(harder).length || explicit
        ? { progressions: { easier: lines(easier), harder: lines(harder) } }
        : {}),
      safety: lines(safety),
      ...(phase ? { phase: phase as "MAIN" } : {}),
      ...(intensity ? { intensity: intensity as "LOW" } : {}),
      ...(tags.trim() || explicit
        ? { tags: tags.split(",").map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(references.length ? { references } : {}),
      ...(preset ? { diagramPreset: preset as ArchetypeId } : {}),
    };
    const saved = await w.save<WorkspaceDrill>(
      "drill",
      {
        name: name.trim(),
        category,
        focusArea,
        purpose: purpose.trim(),
        cue: cue.trim(),
        content,
        ...(item ? { expectedVersion: item.recordVersion } : {}),
      },
      item?.id,
    );
    if (saved) onDone(saved);
  }

  const text = (
    labelText: string,
    value: string,
    set: (v: string) => void,
    extra?: { required?: boolean; max?: number; hint?: string; type?: string },
  ) => (
    <label>
      <span>{labelText}</span>
      <input
        type={extra?.type ?? "text"}
        value={value}
        required={extra?.required}
        maxLength={extra?.max}
        onChange={(e) => set(e.target.value)}
      />
      {extra?.hint && <small>{extra.hint}</small>}
    </label>
  );
  const area = (
    labelText: string,
    value: string,
    set: (v: string) => void,
    hint = "One item per line.",
  ) => (
    <label>
      <span>{labelText}</span>
      <textarea rows={3} value={value} onChange={(e) => set(e.target.value)} />
      <small>{hint}</small>
    </label>
  );
  const choose = (
    labelText: string,
    value: string,
    set: (v: string) => void,
    options: readonly string[],
    show: (o: string) => string = label,
  ) => (
    <label>
      <span>{labelText}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Not set</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {show(o)}
          </option>
        ))}
      </select>
    </label>
  );

  // Saving changes is not removing content: a box that was filled and is now
  // empty removes that content, and the editor must say so before saving.
  const was = (v?: string[] | string) =>
    Array.isArray(v) ? v.length > 0 : !!v?.trim();
  const ownSafetyBefore = (c.safety ?? []).filter((l) => !locked.includes(l));
  const cleared = item
    ? ([
        was(c.description) && !description.trim() && "Description",
        was(c.skills) && !skills.trim() && "Skills developed",
        was(c.equipment) && !lines(equipment).length && "Equipment",
        was(c.setup?.layout) && !layout.trim() && "Setup layout",
        was(c.setup?.dimensions) && !dimensions.trim() && "Pitch or area size",
        was(c.steps) && !lines(steps).length && "Instructions",
        was(c.coachingPoints) && !lines(points).length && "Coaching points",
        was(c.commonMistakes) && !lines(mistakes).length && "Common mistakes",
        was(c.progressions?.easier) && !lines(easier).length && "Easier progressions",
        was(c.progressions?.harder) && !lines(harder).length && "Harder progressions",
        was(c.tags) && !tags.trim() && "Tags",
        was(ownSafetyBefore) && !lines(safety).length && "Safety guidance",
      ].filter(Boolean) as string[])
    : [];
  const overPurpose = purpose.trim().length > PARENT_PURPOSE_MAX,
    overCue = cue.trim().length > PARENT_CUE_MAX,
    noSafety = !locked.length && !lines(safety).length,
    blocked =
      overPurpose ||
      overCue ||
      noSafety ||
      (cleared.length > 0 && !ackClear);

  return (
    <form
      className="dl-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) void submit();
      }}
    >
      {item?.source === "COPY" && (
        <p className="dl-note">
          This is your academy&rsquo;s copy. Changing it never changes the
          universal drill. Its safety lines and any minimum age come from the
          library and stay with it.
        </p>
      )}
      {item?.minimumAgeYears ? (
        <p className="dl-warning" role="note">
          Minimum age {item.minimumAgeYears}. This is an internal Sportozen
          restriction, not a football association rule. It cannot be removed
          and it is checked when the drill is added to a session.
        </p>
      ) : null}
      <p className="dl-note">
        The name, purpose and coaching cue can appear in family reports, so keep
        them short and suitable for parents. All other fields are for staff only.
      </p>
      {text("Drill name", name, setName, { required: true, max: 200 })}
      <label>
        <span>Category</span>
        <select
          required
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Choose a category</option>
          {DRILL_CATEGORIES.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Main skill</span>
        <select value={focusArea} onChange={(e) => setFocusArea(e.target.value)}>
          {operationalSports.football.skills.map((skill) => (
            <option key={skill}>{skill}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Purpose (shown to families)</span>
        <textarea
          rows={2}
          required
          value={purpose}
          aria-invalid={overPurpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
        <span className="dl-counter" data-over={overPurpose} aria-live="polite">
          {purpose.trim().length}/{PARENT_PURPOSE_MAX}
          {overPurpose ? ": too long. Shorten it; nothing is cut for you." : ""}
        </span>
      </label>
      {text("Coaching cue (shown to families)", cue, setCue, {
        required: true,
      })}
      <span className="dl-counter" data-over={overCue} aria-live="polite">
        {cue.trim().length}/{PARENT_CUE_MAX}
        {overCue ? ": too long. Shorten it; nothing is cut for you." : ""}
      </span>
      <details open>
        <summary>Coaching detail (staff only)</summary>
        <label>
          <span>Description</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {text("Skills developed", skills, setSkills, {
          hint: "Separate with commas.",
        })}
        <fieldset>
          <legend>Suitable age groups</legend>
          {AGE_BANDS.map((band) => (
            <label key={band} className="dl-check">
              <input
                type="checkbox"
                checked={ageBands.includes(band)}
                onChange={(e) =>
                  setAgeBands(
                    e.target.checked
                      ? [...ageBands, band]
                      : ageBands.filter((x) => x !== band),
                  )
                }
              />
              {band}
            </label>
          ))}
        </fieldset>
        {choose("Difficulty", difficulty, setDifficulty, DIFFICULTIES)}
        {text("Recommended duration (minutes)", duration, setDuration, {
          type: "number",
        })}
        <div className="dl-row">
          {text("Minimum players", playersMin, setPlayersMin, { type: "number" })}
          {text("Maximum players", playersMax, setPlayersMax, { type: "number" })}
        </div>
        {area("Equipment", equipment, setEquipment)}
        {text("Setup layout", layout, setLayout)}
        {text("Pitch or area size", dimensions, setDimensions, {
          hint: "Describe it in words for your group.",
        })}
        {area("Instructions", steps, setSteps, "One step per line, in order.")}
        {area("Coaching points", points, setPoints)}
        {area("Common mistakes", mistakes, setMistakes)}
        {area("Easier progressions", easier, setEasier)}
        {area("Harder progressions", harder, setHarder)}
        {locked.length ? (
          <div className="dl-locked" role="group" aria-label="Safety lines from the library">
            <strong>Safety lines from the library (cannot be removed)</strong>
            <ul>
              {locked.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {area(
          locked.length ? "Your own extra safety guidance" : "Safety guidance",
          safety,
          setSafety,
          locked.length
            ? "One item per line. Optional: the library lines above always stay."
            : "One item per line. Required: add at least one safety line.",
        )}
        {choose("Training phase", phase, setPhase, PHASES)}
        {choose("Intensity", intensity, setIntensity, INTENSITIES)}
        {text("Tags", tags, setTags, { hint: "Separate with commas." })}
        {text("Source or reference", source, setSource, {
          hint: "Optional. Adds a note about where the idea came from.",
        })}
        {choose(
          "Diagram layout",
          preset,
          setPreset,
          ARCHETYPES,
          (a) => PRESET_LABELS[a as ArchetypeId],
        )}
      </details>
      {cleared.length > 0 && (
        <label className="dl-check dl-warning">
          <input
            type="checkbox"
            checked={ackClear}
            onChange={(e) => setAckClear(e.target.checked)}
          />
          Saving will remove what was in: {cleared.join(", ")}. I understand
          that leaving a box empty removes that content from this drill.
        </label>
      )}
      {noSafety && (
        <p className="dl-note" role="status">
          Add at least one safety line before saving.
        </p>
      )}
      {w.error && <p role="alert">{w.error}</p>}
      <div className="dl-actions">
        <button
          type="submit"
          className="dl-btn dl-primary"
          disabled={w.busy || blocked}
        >
          {w.busy ? "Saving…" : item ? "Save drill" : "Create drill"}
        </button>
        <button type="button" className="dl-btn" onClick={onCancel} disabled={w.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
