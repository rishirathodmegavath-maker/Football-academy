"use client";
import type { HomeSummary } from "@/domain/home-summary";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

/** The Owner, Admin and Coach Home dashboard, from the academy store. It is
 * invalidated by every save that can change a dashboard figure (the default
 * tags of a workspace write), so it never needs a manual refresh. */
export function useHomeSummary(workspace: ReturnType<typeof useWorkspace>) {
  const academyId = workspace.shell?.academy.id;
  const entry = useStoreEntry<HomeSummary>(
    workspace.store,
    "home",
    `/api/workspaces/${academyId}/home`,
    ["home"],
    Boolean(academyId),
  );
  return {
    summary:
      entry.data && entry.data.academyId === academyId ? entry.data : null,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
