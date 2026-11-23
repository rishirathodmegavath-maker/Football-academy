"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useDeliveryJobs } from "@/hooks/use-delivery-jobs";
import type { DeliveryJobRow, DeliveryState } from "@/domain/communication";

const STATES: { value: DeliveryState | ""; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "QUEUED", label: "Queued" },
  { value: "PROVIDER_ACCEPTED", label: "Accepted by provider" },
  { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "READ", label: "Read" },
  { value: "FAILED", label: "Failed" },
  { value: "UNKNOWN", label: "Unknown" },
  { value: "CANCELLED", label: "Cancelled" },
];
/** The delivery history of one player, one page at a time, with a status
 * filter and a search box (guardian, period, reason). The server does the
 * filtering and paging; this component never holds more than the pages the
 * person has opened. */
export function DeliveryJobList({
  academyId,
  playerId,
  refreshKey,
  guardianName,
  canCancel,
  busy,
  onCancel,
}: {
  academyId: string | undefined;
  playerId: string;
  /** Changes when the Communication view was refetched. */
  refreshKey: unknown;
  guardianName: (guardianId: string) => string;
  canCancel: boolean;
  busy: boolean;
  onCancel: (job: DeliveryJobRow) => void;
}) {
  const [state, setState] = useState<DeliveryState | "">(""),
    [text, setText] = useState(""),
    [q, setQ] = useState("");
  // Search as the person pauses typing, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const list = useDeliveryJobs(
    academyId,
    { playerId, state, q },
    Boolean(academyId),
    refreshKey,
  );
  const filtered = Boolean(state || q.trim());
  return (
    <div className="delivery-jobs">
      <div className="delivery-jobs-filters">
        <label>
          Status
          <select
            value={state}
            onChange={(e) => setState(e.target.value as DeliveryState | "")}
          >
            {STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search notifications
          <input
            type="search"
            value={text}
            maxLength={80}
            placeholder="Guardian, period or reason"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>
      {list.status === "loading" && (
        <p role="status" className="delivery-jobs-note">
          Loading notifications…
        </p>
      )}
      {list.error && (
        <p role="alert" className="delivery-jobs-note">
          {list.error}{" "}
          <Button variant="secondary" onClick={() => void list.reload()}>
            Try again
          </Button>
        </p>
      )}
      {list.status === "ready" && !list.jobs.length && (
        <p role="status" className="delivery-jobs-note">
          {filtered
            ? "No notifications match these filters."
            : "No notifications have been queued for this player yet."}
        </p>
      )}
      {list.jobs.map((j) => (
        <div className="list-row" key={j.id}>
          <div>
            <strong>
              {j.type} · {j.period}
            </strong>
            <p>
              {guardianName(j.guardianId)} · {j.state}
            </p>
            <small>
              {j.reason} · attempts {j.attempts}
            </small>
          </div>
          {canCancel && j.state === "QUEUED" && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onCancel(j)}
            >
              Cancel notification
            </Button>
          )}
        </div>
      ))}
      {list.jobs.length > 0 && (
        <p role="status" className="delivery-jobs-note">
          Showing {list.jobs.length} notification
          {list.jobs.length === 1 ? "" : "s"}
          {list.hasMore ? ", newest first." : ". That is all of them."}
        </p>
      )}
      {list.hasMore && (
        <Button
          variant="secondary"
          disabled={list.loadingMore}
          onClick={() => void list.loadMore()}
        >
          {list.loadingMore ? "Loading…" : "Show older notifications"}
        </Button>
      )}
    </div>
  );
}
