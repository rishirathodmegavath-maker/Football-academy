"use client";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";
import type {
  CommunicationSettings,
  GuardianContact,
  DeliveryJobRow,
} from "@/domain/communication";
export interface CommunicationView {
  settings: CommunicationSettings;
  contacts: GuardianContact[];
  /** The newest page only; the full history is read through useDeliveryJobs. */
  jobs: DeliveryJobRow[];
  jobsMore: boolean;
  reminders: { playerId: string; period: string; reason: string }[];
  unrouted: {
    id: string;
    receivedAt: string;
    outcome: string;
    guardianId?: string;
    body?: string;
  }[];
}
/** Runs a communication command. Only `resolveReply` writes a workspace
 * record (it appends the confirmed inbound reply to a conversation), so only
 * that command also invalidates the academy payload; every other command
 * changes delivery or contact data, and only the communication view is
 * refetched. */
export async function communicationCommand<T>(
  workspace: ReturnType<typeof useWorkspace>,
  body: { action: string; data: unknown },
) {
  return workspace.communication<T>(body, {
    invalidates:
      body.action === "resolveReply"
        ? ["communication", "workspace", "home"]
        : ["communication"],
  });
}
/** The communication view, shared through the academy store: fetched when the
 * academy changes or its data was invalidated, not after unrelated saves. */
export function useCommunication(w: ReturnType<typeof useWorkspace>) {
  const academyId = w.shell?.academy.id,
    role = w.shell?.membership.role,
    // The server answers 403 to other roles and to academies without the
    // module; asking anyway would only produce a refusal.
    allowed =
      role === "OWNER" ||
      role === "ADMIN" ||
      role === "COACH" ||
      role === "PARENT";
  const entry = useStoreEntry<CommunicationView>(
    w.store,
    "communication",
    `/api/workspaces/${academyId}/communication`,
    ["communication"],
    Boolean(
      academyId &&
      allowed &&
      w.shell?.academy.modules.includes("communication"),
    ),
    { sensitive: true },
  );
  return {
    data: entry.data,
    error: entry.status === "error" ? (entry.error ?? "") : "",
  };
}
