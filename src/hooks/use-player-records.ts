"use client";
import type { PlayerMessages, ReportSummary } from "@/domain/records-query";
import type { WorkspacePlan, WorkspaceReport } from "@/domain/workspace";
import type { FootballEvidence } from "@/domain/training";
import type { WeeklyPlan } from "@/domain/communication";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

type Workspace = ReturnType<typeof useWorkspace>;

/**
 * One player's records of one kind, read through the filtered records
 * endpoint (the server applies the viewer's role, academy and parent-child
 * scope first; the filter only narrows). Shared by Messages and Development
 * in place of the whole-academy payload. `sensitive` entries (message text,
 * report content, internal notes) are fetched every time a screen opens them.
 */
function usePlayerRecords<T>(
  workspace: Workspace,
  name: string,
  path: string,
  playerId: string | undefined,
  { enabled = true, sensitive = false, tags = ["workspace"] } = {},
) {
  const academyId = workspace.shell?.academy.id;
  const entry = useStoreEntry<T>(
    workspace.store,
    `${name}:${playerId}`,
    `/api/workspaces/${academyId}/records/${path}${path.includes("?") ? "&" : "?"}player=${encodeURIComponent(playerId ?? "")}`,
    tags,
    enabled && Boolean(academyId && playerId),
    { sensitive },
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

export const usePlayerPlans = (
  w: Workspace,
  playerId?: string,
  enabled = true,
) =>
  usePlayerRecords<WorkspacePlan[]>(w, "plans", "plan", playerId, { enabled });
export const usePlayerWeeklyPlans = (
  w: Workspace,
  playerId?: string,
  enabled = true,
) =>
  usePlayerRecords<WeeklyPlan[]>(w, "weekly", "weekly", playerId, { enabled });
/**
 * Everything Messages shows for one player (plans, updates, conversations and
 * the content of their approved reports) in one request. It carries message
 * text, internal notes for staff and report content, so each open of the
 * screen fetches it again; a communication command refreshes it too.
 */
export function usePlayerMessages(
  workspace: Workspace,
  playerId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id;
  const entry = useStoreEntry<PlayerMessages>(
    workspace.store,
    `messages:${playerId}`,
    `/api/workspaces/${academyId}/player-messages?player=${encodeURIComponent(playerId ?? "")}`,
    // Only resolving an inbound reply writes a conversation, and that command
    // already invalidates "workspace"; other communication commands change
    // delivery data, which the bundle does not carry.
    ["workspace"],
    enabled && Boolean(academyId && playerId),
    { sensitive: true },
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
/** A player's reports in full, for the staff who edit them (drafts carry
 * observations and source references, so each open refetches them). */
export const usePlayerReports = (
  w: Workspace,
  playerId?: string,
  enabled = true,
) =>
  usePlayerRecords<WorkspaceReport[]>(w, "reports-full", "report", playerId, {
    enabled,
    sensitive: true,
  });
/** A player's evidence records (staff notes included), for the staff who
 * check what a draft report was built from. */
export const usePlayerEvidence = (
  w: Workspace,
  playerId?: string,
  enabled = true,
) =>
  usePlayerRecords<FootballEvidence[]>(w, "evidence", "evidence", playerId, {
    enabled,
    sensitive: true,
  });
/** A player's reports in summary form (the delivery panel lists the approved
 * monthly ones). */
export const usePlayerReportSummaries = (
  w: Workspace,
  playerId?: string,
  enabled = true,
) =>
  usePlayerRecords<ReportSummary[]>(
    w,
    "report-summaries",
    "report?view=summary",
    playerId,
    { enabled },
  );
