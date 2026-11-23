"use client";
import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useDrillCatalogue } from "@/hooks/use-drill-catalogue";
import {
  NO_FILTERS,
  filterItems,
  libraryItems,
  type LibraryFilters,
  type LibraryItem,
} from "@/services/drill-library-view";
import type { PortalController } from "./portal-types";
import { DrillDiagram } from "./drill-diagram";
import { FilterBar, SourceBadges, diagramOf } from "./drill-library-parts";
import "./drill-library.css";

/**
 * A button that opens a searchable, multi-select picker over the universal
 * catalogue and the academy's own drills. Archived drills are not offered.
 * `onAdd` receives the chosen drills in the order they were selected; the
 * caller decides where they go and how long each one lasts.
 */
export function DrillPickerButton({
  workspace: w,
  onAdd,
  label = "Add drills from library",
}: {
  workspace: PortalController;
  onAdd: (items: LibraryItem[]) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [wanted, setWanted] = useState(false);
  return (
    <>
      <button
        type="button"
        className="dl-btn"
        onClick={() => {
          setWanted(true);
          setOpen(true);
        }}
      >
        {label}
      </button>
      {wanted && (
        <DrillPicker
          workspace={w}
          open={open}
          onOpenChange={setOpen}
          onAdd={(items) => {
            onAdd(items);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function DrillPicker({
  workspace: w,
  open,
  onOpenChange,
  onAdd,
}: {
  workspace: PortalController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (items: LibraryItem[]) => void;
}) {
  const d = w.data!,
    catalogue = useDrillCatalogue(w),
    [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS),
    [chosen, setChosen] = useState<string[]>([]),
    [previewId, setPreviewId] = useState<string>();
  const viewer = { userId: d.membership.userId, role: d.membership.role };
  const items = useMemo(
    () => libraryItems(catalogue.data?.drills ?? [], d.records.drill, viewer),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogue.data, d.records.drill, viewer.userId, viewer.role],
  );
  // Archived drills cannot be added to a new session or plan.
  const shown = filterItems(
    items.filter((i) => !i.archived),
    { ...filters, showArchived: false },
  );
  const preview = items.find((i) => i.id === previewId),
    previewDiagram = preview ? diagramOf(preview) : undefined;
  const toggle = (id: string) =>
    setChosen((now) =>
      now.includes(id) ? now.filter((x) => x !== id) : [...now, id],
    );
  const picked = chosen.flatMap((id) => items.find((i) => i.id === id) ?? []);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dl-overlay" />
        <Dialog.Content className="dl-dialog" aria-describedby={undefined}>
          <Dialog.Title>Choose drills</Dialog.Title>
          <Dialog.Close className="dl-close" aria-label="Close drill picker">
            <X size={18} />
          </Dialog.Close>
          {catalogue.error && (
            <p role="alert">
              {catalogue.error}{" "}
              <button type="button" className="dl-btn" onClick={catalogue.reload}>
                Try again
              </button>
            </p>
          )}
          <FilterBar
            idPrefix="picker"
            catalogue={catalogue.data}
            items={items}
            filters={filters}
            onChange={setFilters}
            hideArchived
          />
          <p className="dl-count-line" role="status">
            {catalogue.loading
              ? "Loading the universal library…"
              : `${chosen.length} selected · ${shown.length} drill${shown.length === 1 ? "" : "s"} shown`}
          </p>
          <div className="dl-picker-list">
            {shown.map((item) => (
              <div className="dl-pick" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`Select ${item.name}`}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <SourceBadges item={item} />
                    <small>
                      {item.summary}
                      {item.content.durationMinutes
                        ? ` Suggested ${item.content.durationMinutes} min.`
                        : ""}
                    </small>
                  </span>
                </label>
                <button
                  type="button"
                  className="dl-btn"
                  aria-label={`Preview ${item.name}`}
                  onClick={() =>
                    setPreviewId(item.id === previewId ? undefined : item.id)
                  }
                >
                  {item.id === previewId ? "Hide" : "Preview"}
                </button>
              </div>
            ))}
            {!shown.length && !catalogue.loading && (
              <p className="dl-empty">No drills match these filters.</p>
            )}
          </div>
          {preview && (
            <div className="dl-preview" aria-live="polite">
              <h4>{preview.name}</h4>
              {preview.minimumAgeYears ? (
                <p className="dl-warning" role="note">
                  Minimum age {preview.minimumAgeYears}. Internal Sportozen
                  restriction.
                </p>
              ) : null}
              {previewDiagram && <DrillDiagram spec={previewDiagram} />}
              <p>{preview.purpose}</p>
            </div>
          )}
          <div className="dl-actions dl-sticky">
            <button
              type="button"
              className="dl-btn dl-primary"
              disabled={!picked.length}
              onClick={() => onAdd(picked)}
            >
              {picked.length
                ? `Add ${picked.length} selected drill${picked.length === 1 ? "" : "s"}`
                : "Add selected drills"}
            </button>
            <button
              type="button"
              className="dl-btn"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
