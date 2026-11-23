import {
  drillCategoryName,
  isUniversalDrillId,
  type AcademyDrillContent,
  type DrillCategoryId,
  type UniversalDrill,
} from "@/domain/drill-library";
import type { WorkspaceDrill } from "@/domain/workspace";

// Pure view logic for the drill library: one list of universal and academy
// drills, and the search and filters over it. No server or screen code here.

export type LibrarySource = "UNIVERSAL" | "ACADEMY" | "COPY";
export interface LibraryItem {
  /** The id a session or plan stores. */
  id: string;
  source: LibrarySource;
  number?: number;
  name: string;
  categoryId?: DrillCategoryId;
  categoryName: string;
  focusArea: string;
  purpose: string;
  cue: string;
  summary: string;
  skills: string[];
  tags: string[];
  content: AcademyDrillContent;
  archived: boolean;
  /** A hint for the screen; the server decides. */
  canManage: boolean;
  /** For a universal drill: the id of this academy's copy, if one exists. */
  copyId?: string;
  /** For a copy: the universal drill it came from. */
  universalId?: string;
  universalVersion?: number;
  minimumAgeYears?: number;
  /** Safety lines a copy inherited; they cannot be removed from it. */
  lockedSafety?: string[];
  /** The approved objective, verbatim (universal drills only). */
  originalObjective?: string;
  interpretation?: string;
  distinctFrom?: UniversalDrill["distinctFrom"];
  recordVersion?: number;
}

export interface Viewer {
  userId: string;
  role: string;
}

const summaryOf = (d: WorkspaceDrill) =>
  d.content?.description?.slice(0, 160) || d.purpose;

export function libraryItems(
  catalogue: readonly UniversalDrill[],
  academy: readonly WorkspaceDrill[],
  viewer: Viewer,
): LibraryItem[] {
  const copies = new Map<string, WorkspaceDrill>();
  for (const d of academy)
    if (d.templateId && isUniversalDrillId(d.templateId))
      copies.set(d.templateId, d);
  const manage = (d: WorkspaceDrill) =>
    ["OWNER", "ADMIN"].includes(viewer.role) ||
    (viewer.role === "COACH" && !!d.createdBy && d.createdBy === viewer.userId);
  const universal: LibraryItem[] = catalogue.map((u) => ({
    id: u.id,
    source: "UNIVERSAL",
    number: u.number,
    name: u.name,
    categoryId: u.categoryId,
    categoryName: drillCategoryName(u.categoryId),
    focusArea: u.focusArea,
    purpose: u.purpose,
    cue: u.cue,
    summary: u.summary,
    skills: [u.focusArea, ...u.content.skills],
    tags: u.content.tags,
    content: u.content,
    archived: false,
    canManage: false,
    copyId: copies.get(u.id)?.id,
    universalVersion: u.contentVersion,
    minimumAgeYears: u.minimumAge?.years,
    originalObjective: u.originalObjective,
    interpretation: u.interpretation,
    distinctFrom: u.distinctFrom,
  }));
  const own: LibraryItem[] = academy.map((d) => ({
    id: d.id,
    source:
      d.templateId && isUniversalDrillId(d.templateId) ? "COPY" : "ACADEMY",
    name: d.name,
    categoryId: d.category,
    categoryName: drillCategoryName(d.category),
    focusArea: d.focusArea,
    purpose: d.purpose,
    cue: d.cue,
    summary: summaryOf(d),
    skills: [d.focusArea, ...(d.content?.skills ?? [])],
    tags: d.content?.tags ?? [],
    content: d.content ?? {},
    archived: d.status === "ARCHIVED",
    canManage: manage(d),
    universalId:
      d.templateId && isUniversalDrillId(d.templateId)
        ? d.templateId
        : undefined,
    universalVersion: d.universalVersion,
    minimumAgeYears: d.minimumAge?.years,
    lockedSafety: d.lockedSafety,
    recordVersion: d.recordVersion,
  }));
  return [...universal, ...own];
}

/**
 * A drill exactly as a saved session holds it, in the shape the detail view
 * draws. Nothing is read from the current catalogue or the current academy
 * drill: what the session stored is what is shown.
 */
export function snapshotItem(drill: WorkspaceDrill): LibraryItem {
  const universal = drill.ownership === "UNIVERSAL_CATALOGUE";
  return {
    id: drill.id,
    source: universal
      ? "UNIVERSAL"
      : drill.templateId && isUniversalDrillId(drill.templateId)
        ? "COPY"
        : "ACADEMY",
    number: drill.snapshot?.number,
    name: drill.name,
    categoryId: drill.category,
    categoryName: drillCategoryName(drill.category),
    focusArea: drill.focusArea,
    purpose: drill.purpose,
    cue: drill.cue,
    summary: summaryOf(drill),
    skills: [drill.focusArea, ...(drill.content?.skills ?? [])],
    tags: drill.content?.tags ?? [],
    content: drill.content ?? {},
    archived: false,
    canManage: false,
    universalVersion: drill.snapshot?.contentVersion ?? drill.universalVersion,
    minimumAgeYears: drill.minimumAge?.years,
    lockedSafety: drill.lockedSafety,
    originalObjective: drill.snapshot?.objective,
  };
}

/** True when the content a session holds for this drill is complete: a
 * catalogue drill saved before complete snapshots existed is not. */
export const hasSavedContent = (drill: WorkspaceDrill) =>
  drill.ownership !== "UNIVERSAL_CATALOGUE" || !!drill.snapshot;

export interface LibraryFilters {
  query: string;
  /** A category id, "all", or "uncategorised". */
  category: string;
  source: "all" | "UNIVERSAL" | "ACADEMY";
  showArchived: boolean;
}
export const NO_FILTERS: LibraryFilters = {
  query: "",
  category: "all",
  source: "all",
  showArchived: false,
};

const norm = (s: string) => s.toLowerCase().normalize("NFKC");

/** Search covers the drill name, its skills and its tags. */
export function matchesQuery(item: LibraryItem, query: string) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = norm(
    [item.name, ...item.skills, ...item.tags, item.categoryName].join(" "),
  );
  return words.every((w) => haystack.includes(w));
}

export function filterItems(
  items: readonly LibraryItem[],
  f: LibraryFilters,
): LibraryItem[] {
  return items.filter((i) => {
    if (i.archived && !f.showArchived) return false;
    if (f.source === "UNIVERSAL" && i.source !== "UNIVERSAL") return false;
    if (f.source === "ACADEMY" && i.source === "UNIVERSAL") return false;
    if (f.category === "uncategorised" && i.categoryId) return false;
    if (
      f.category !== "all" &&
      f.category !== "uncategorised" &&
      i.categoryId !== f.category
    )
      return false;
    return matchesQuery(i, f.query);
  });
}

/** Total agenda minutes. */
export const totalMinutes = (items: { duration: number }[]) =>
  items.reduce(
    (sum, i) => sum + (Number.isFinite(i.duration) ? i.duration : 0),
    0,
  );

/** Moves item `index` by `delta` positions; the list is unchanged at the ends. */
export function moveItem<T>(
  list: readonly T[],
  index: number,
  delta: -1 | 1,
): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
