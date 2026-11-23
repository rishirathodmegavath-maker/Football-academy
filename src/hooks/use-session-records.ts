"use client";
import type { SessionEvidence } from "@/domain/records-query";
import type { FootballAttendance } from "@/domain/training";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

type Workspace = ReturnType<typeof useWorkspace>;
const staff = ["OWNER", "ADMIN", "COACH"];

/**
 * One session's attendance, read for the session on screen instead of with
 * every session of the academy. The server applies the viewer's own scope
 * first, so a coach reads only their players' marks.
 */
export function useSessionAttendance(
  workspace: Workspace,
  sessionId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id,
    allowed = staff.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<FootballAttendance[]>(
    workspace.store,
    `attendance:${sessionId}`,
    `/api/workspaces/${academyId}/records/attendance?session=${encodeURIComponent(sessionId ?? "")}`,
    ["workspace"],
    enabled && allowed && Boolean(academyId && sessionId),
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}

/**
 * One session's evidence with, for each record, whether the player has other
 * reviewed evidence it can be compared with. Evidence carries private staff
 * notes, so each open of a session fetches it again.
 */
export function useSessionEvidence(
  workspace: Workspace,
  sessionId: string | undefined,
  enabled = true,
) {
  const academyId = workspace.shell?.academy.id,
    allowed = staff.includes(workspace.shell?.membership.role ?? "");
  const entry = useStoreEntry<SessionEvidence[]>(
    workspace.store,
    `session-evidence:${sessionId}`,
    `/api/workspaces/${academyId}/records/evidence?session=${encodeURIComponent(sessionId ?? "")}&compare=1`,
    ["workspace"],
    enabled && allowed && Boolean(academyId && sessionId),
    { sensitive: true },
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
