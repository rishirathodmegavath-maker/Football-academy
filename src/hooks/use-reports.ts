"use client";
import type {
  MonthlyReportSources,
  ReportSummary,
  SessionSummary,
} from "@/domain/records-query";
import type { WorkspaceReport } from "@/domain/workspace";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

/** The reports list screens read it for roles that see report screens. */
const reportRoles = ["OWNER", "ADMIN", "COACH", "SUPPORT"];

/** A report as the list screen needs it: no snapshot, sources or plan.
 * `review` adds, for monthly drafts, whether their saved sources are still
 * current (only the monthly review queue shows it, and it costs a check per
 * draft). */
export function useReportList(
  workspace: ReturnType<typeof useWorkspace>,
  enabled = true,
  { review = false } = {},
) {
  const academyId = workspace.shell?.academy.id,
    allowed = reportRoles.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<ReportSummary[]>(
    workspace.store,
    review ? "reports:summary:review" : "reports:summary",
    `/api/workspaces/${academyId}/records/report?view=summary${review ? "&review=1" : ""}`,
    ["workspace"],
    enabled && allowed && Boolean(academyId),
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

/** A player's scheduled sessions, listed without agenda or objectives. */
export function usePlayerSessions(
  workspace: ReturnType<typeof useWorkspace>,
  playerId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id,
    allowed = ["OWNER", "ADMIN", "COACH"].includes(
      workspace.shell?.membership.role ?? "",
    );
  const entry = useStoreEntry<SessionSummary[]>(
    workspace.store,
    `sessions:scheduled:${playerId}`,
    `/api/workspaces/${academyId}/records/session?view=summary&status=SCHEDULED&player=${playerId}`,
    ["workspace"],
    enabled && allowed && Boolean(academyId && playerId),
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

/** One report in full (snapshot, monthly sources) with the monthly-source
 * check made when it is opened. `sources` adds the current training records
 * behind a monthly report's saved sources, for the review workspace. */
export function useReportDetail(
  workspace: ReturnType<typeof useWorkspace>,
  reportId: string | undefined,
  enabled = true,
  { sources = false } = {},
) {
  const academyId = workspace.shell?.academy.id,
    allowed = reportRoles.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<{
    report: WorkspaceReport;
    review?: { sourcesCurrent: boolean; reason?: string };
    sources?: MonthlyReportSources;
  }>(
    workspace.store,
    `report:${reportId}${sources ? ":sources" : ""}`,
    `/api/workspaces/${academyId}/records/report/${reportId}?review=1${sources ? "&sources=1" : ""}`,
    ["workspace"],
    enabled && allowed && Boolean(academyId && reportId),
    { sensitive: true },
  );
  return {
    report: entry.data?.report,
    review: entry.data?.review,
    sources: entry.data?.sources,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
