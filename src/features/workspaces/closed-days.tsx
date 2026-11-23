"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CalendarOff, X } from "lucide-react";
import type { FootballClosure, FootballSession } from "@/domain/training";
import type { WorkspacePayload } from "@/domain/workspace";
import { closureCovering } from "@/services/closure-rules";
import type { TrainingSubmit } from "./training";
import { displayDay, displayDayRange } from "@/services/date-display";

type Data = Pick<WorkspacePayload, "academy" | "membership" | "records">;
const range = (c: Pick<FootballClosure, "startDate" | "endDate">) =>
  c.startDate === c.endDate
    ? displayDay(c.startDate)
    : displayDayRange(c.startDate, c.endDate, " to ");
const scopeOf = (c: FootballClosure, data: Data) =>
  c.branchId
    ? (data.records.branch.find((b) => b.id === c.branchId)?.name ?? "One branch")
    : "Whole academy";

/** Sessions that still sit on a closed day. A closure never cancels them. */
export function sessionsOnClosedDays(
  closure: FootballClosure,
  sessions: readonly FootballSession[],
) {
  return sessions.filter(
    (s) =>
      ["DRAFT", "SCHEDULED", "IN_PROGRESS"].includes(s.status) &&
      closureCovering([closure], s.branchId, s.startLocal.slice(0, 10)),
  );
}

/** One line per upcoming or current closure, for every staff role. */
export function ClosedDaysBanner({ data, today }: { data: Data; today: string }) {
  const upcoming = data.records.closure
    .filter((c) => c.status === "ACTIVE" && c.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (!upcoming.length) return null;
  return (
    <ul className="pc-closures" aria-label="Closed days">
      {upcoming.map((c) => (
        <li key={c.id}>
          <CalendarOff size={15} aria-hidden="true" /> Closed {range(c)} ·{" "}
          {scopeOf(c, data)}
          {c.reason ? ` · ${c.reason}` : ""}
        </li>
      ))}
    </ul>
  );
}

/** Owner and admin: record, review and lift all-day closures. The server
 * enforces the role and every rule; this dialog only collects the input. */
export function ClosedDaysManager({
  data,
  submit,
  busy,
  today,
}: {
  data: Data;
  submit: TrainingSubmit;
  busy: boolean;
  today: string;
}) {
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  if (!["OWNER", "ADMIN"].includes(data.membership.role)) return null;
  const closures = [...data.records.closure].sort((a, b) =>
    b.startDate.localeCompare(a.startDate),
  );
  async function add(form: HTMLFormElement) {
    const f = new FormData(form),
      value = (name: string) => String(f.get(name) ?? "").trim();
    const saved = await submit("closure", {
      branchId: value("branchId"),
      startDate: value("startDate"),
      endDate: value("endDate") || value("startDate"),
      reason: value("reason"),
      publicNote: value("publicNote"),
    });
    if (saved) {
      form.reset();
      setMessage("Closure recorded. Sessions already scheduled were not cancelled.");
    } else setMessage("");
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button">
          <CalendarOff size={16} /> Closed days
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="portal-overlay" />
        <Dialog.Content className="portal-dialog">
          <Dialog.Title>Closed days</Dialog.Title>
          <Dialog.Description>
            Whole days when the academy or one branch does not train. New
            sessions cannot be scheduled on these days and weekly series skip
            them. Sessions that are already scheduled stay as they are: cancel
            them from the calendar if training will not run.
          </Dialog.Description>
          <button
            className="portal-icon close"
            type="button"
            aria-label="Close closed days"
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void add(event.currentTarget);
            }}
          >
            <label>
              Applies to
              <select name="branchId" defaultValue="">
                <option value="">Whole academy</option>
                {data.records.branch.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              First closed day
              <input name="startDate" type="date" required min={today} />
            </label>
            <label>
              Last closed day (leave empty for one day)
              <input name="endDate" type="date" min={today} />
            </label>
            <label>
              Reason (staff only)
              <input name="reason" required minLength={3} maxLength={500} />
            </label>
            <label>
              Note for families (optional)
              <input name="publicNote" maxLength={300} />
            </label>
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Record closure"}
            </button>
          </form>
          {message && <p role="status">{message}</p>}
          <ul aria-label="Recorded closures">
            {closures.map((c) => {
              const stuck =
                c.status === "ACTIVE"
                  ? sessionsOnClosedDays(c, data.records.session)
                  : [];
              return (
                <li key={c.id}>
                  <strong>{range(c)}</strong> · {scopeOf(c, data)} ·{" "}
                  {c.status === "ACTIVE" ? "Active" : "Lifted"}
                  <br />
                  {c.reason}
                  {stuck.length > 0 && (
                    <p role="note">
                      {stuck.length} session{stuck.length === 1 ? "" : "s"}{" "}
                      still scheduled on these days:{" "}
                      {stuck
                        .map((s) => `${s.title ?? s.theme ?? "Session"} (${displayDay(s.startLocal)})`)
                        .join(", ")}
                      .
                    </p>
                  )}
                  {c.status === "ACTIVE" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void submit(
                          "closure",
                          {
                            branchId: c.branchId,
                            startDate: c.startDate,
                            endDate: c.endDate,
                            reason: c.reason,
                            publicNote: c.publicNote,
                            status: "LIFTED",
                          },
                          c.id,
                          c.version,
                        )
                      }
                    >
                      Lift closure
                    </button>
                  )}
                </li>
              );
            })}
            {!closures.length && <li>No closures recorded.</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
