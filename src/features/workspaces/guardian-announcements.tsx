"use client";
import { Megaphone } from "lucide-react";
import type { GuardianAnnouncement } from "@/domain/batch-announcement";
import type { GuardianMessage } from "@/domain/messaging";
import { useStoreEntry } from "@/hooks/use-store-entry";
import { portalDate } from "@/services/portal-records";
import type { PortalController } from "./portal-types";
import "./guardian-announcements.css";
const kinds = {
  SESSION_CANCELLED: "Session cancelled",
  VENUE_CHANGED: "Venue changed",
  TIME_CHANGED: "Training time changed",
  ACADEMY_HOLIDAY: "Academy holiday",
  SPECIAL_PRACTICE: "Special practice session",
  OPERATIONAL: "Operational update",
} as const;
/** The approved, unexpired announcements for the guardian's own children's
 * batches. Nothing is shown when there are none. The list is fetched each
 * time the screen opens (a cancelled or expired announcement must not linger). */
export function GuardianAnnouncements({
  workspace: w,
}: {
  workspace: PortalController;
}) {
  const shell = w.shell,
    active = Boolean(
      shell &&
      shell.membership.role === "PARENT" &&
      shell.academy.modules.includes("communication"),
    );
  const entry = useStoreEntry<{
    announcements: GuardianAnnouncement[];
    messages?: GuardianMessage[];
  }>(
    w.store,
    "guardian-announcements",
    `/api/workspaces/${shell?.academy.id}/announcements`,
    ["announcements"],
    active,
    { sensitive: true },
  );
  if (!active || !shell) return null;
  if (entry.status === "error")
    return (
      <p className="portal-card guardian-announcements-note" role="status">
        Academy announcements could not be loaded. Reload the page to try again.
      </p>
    );
  const items = entry.data?.announcements ?? [],
    sent = entry.data?.messages ?? [];
  if (!items.length && !sent.length) return null;
  return (
    <section
      className="portal-card guardian-announcements"
      aria-labelledby="guardian-announcements-title"
    >
      <div className="guardian-announcements-heading">
        <span className="portal-round amber">
          <Megaphone size={18} />
        </span>
        <h2 id="guardian-announcements-title">Academy announcements</h2>
      </div>
      <ul>
        {sent.map((item) => (
          <li key={item.id}>
            <strong>{item.title}</strong>
            <p className="guardian-message-body">{item.body}</p>
            <small>
              {shell.academy.name} · posted{" "}
              {portalDate(item.at, { academy: shell.academy })}
            </small>
          </li>
        ))}
        {items.map((item) => (
          <li key={item.id} data-urgent={item.urgency === "URGENT"}>
            <strong>
              {item.urgency === "URGENT" ? "Urgent · " : ""}
              {kinds[item.kind]}
            </strong>
            <p>{item.body}</p>
            <small>
              {item.batchNames.join(", ")} · posted{" "}
              {portalDate(item.approvedAt, { academy: shell.academy })} · shown
              until {portalDate(item.expiresAt, { academy: shell.academy })}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
