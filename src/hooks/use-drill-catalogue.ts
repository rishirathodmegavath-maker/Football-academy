"use client";
import type { UniversalDrill } from "@/domain/drill-library";
import type { HeadingStatus } from "@/config/drills/heading-policy";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

type Workspace = ReturnType<typeof useWorkspace>;
const staff = ["OWNER", "ADMIN", "COACH"];

export interface DrillCatalogue {
  categories: {
    id: string;
    name: string;
    initialCount: number;
    publishedCount: number;
  }[];
  drills: UniversalDrill[];
  headingPolicy: HeadingStatus;
}

/**
 * The universal drill catalogue, read from the authenticated route for staff
 * only and kept in the academy store. It is static between releases, so it is
 * fetched once per visit rather than with every screen.
 */
export function useDrillCatalogue(workspace: Workspace, enabled = true) {
  const academyId = workspace.shell?.academy.id,
    allowed = staff.includes(workspace.shell?.membership.role ?? "");
  const url = `/api/workspaces/${academyId}/drills/catalogue`;
  // Staff-only coaching content: fetched again whenever a screen opens it and
  // never served from memory to a new screen (the store's "sensitive" rule).
  const entry = useStoreEntry<DrillCatalogue>(
    workspace.store,
    "drill-catalogue",
    url,
    ["drill-catalogue"],
    enabled && allowed && Boolean(academyId),
    { sensitive: true },
  );
  return {
    data: entry.data,
    loading: entry.status === "loading" || entry.status === "idle",
    error:
      entry.status === "error"
        ? (entry.error ?? "Could not load the library.")
        : "",
    /** Asks the server again after a failure. */
    reload: () =>
      void workspace.store
        .load<DrillCatalogue>("drill-catalogue", url, ["drill-catalogue"], {
          force: true,
          sensitive: true,
        })
        .catch(() => {}),
  };
}
