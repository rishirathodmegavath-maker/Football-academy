"use client";
import type { AttendanceHistory, SessionWrapUp } from "@/domain/training";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

type Workspace = ReturnType<typeof useWorkspace>;
const staff = ["OWNER", "ADMIN", "COACH"];

/** One session's wrap-up. Staff only, and read for the open session only: it
 * is not part of the academy payload. Refreshes after any saved change. */
export function useSessionWrapUp(
  workspace: Workspace,
  sessionId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id,
    allowed = staff.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<SessionWrapUp[]>(
    workspace.store,
    `wrapup:${sessionId}`,
    `/api/workspaces/${academyId}/records/wrapup?session=${encodeURIComponent(sessionId ?? "")}`,
    ["workspace"],
    enabled && allowed && Boolean(academyId && sessionId),
    // Coach observations and improvement notes: fetched again on each open.
    { sensitive: true },
  );
  return {
    data: entry.data?.[0],
    loading: entry.status === "loading" && !entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

/** One player's attendance history: staff for any player they may see, a
 * parent for a linked child. The server decides what each of them receives. */
export function useAttendanceHistory(
  workspace: Workspace,
  playerId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id;
  const entry = useStoreEntry<AttendanceHistory>(
    workspace.store,
    `attendance-history:${playerId}`,
    `/api/workspaces/${academyId}/attendance-history?player=${encodeURIComponent(playerId ?? "")}`,
    ["workspace"],
    enabled && Boolean(academyId && playerId),
  );
  return {
    data: entry.data,
    loading: entry.status === "loading" && !entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

/** Players with three or more consecutive absences. Staff only. */
export function useFollowUps(workspace: Workspace, enabled = true) {
  const academyId = workspace.shell?.academy.id,
    allowed = staff.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<AttendanceHistory[]>(
    workspace.store,
    "attendance-follow-ups",
    `/api/workspaces/${academyId}/attendance-history?followUp=1`,
    ["workspace"],
    enabled && allowed && Boolean(academyId),
  );
  return {
    data: entry.data,
    loading: entry.status === "loading" && !entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
