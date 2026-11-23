"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Inbox, X } from "lucide-react";
import type { WorkspaceEnquiry, WorkspacePlayer } from "@/domain/workspace";
import type { PortalController, PortalNavigate } from "./portal-types";
import { displayDay } from "@/services/date-display";

const LABEL: Record<WorkspaceEnquiry["status"], string> = {
  OPEN: "Open",
  WAITLIST: "Waitlist",
  CLOSED: "Closed",
  CONVERTED: "Started as a trial player",
};
/**
 * Owner and admin: enquiries from families before any player record exists.
 * The server enforces the role and every rule (names, a reason when closing,
 * one player per enquiry); this dialog collects the input and shows what is due.
 */
export function Enquiries({
  workspace: w,
  today,
  onNavigate,
}: {
  workspace: PortalController;
  today: string;
  onNavigate: PortalNavigate;
}) {
  const d = w.data!,
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<WorkspaceEnquiry>(),
    [status, setStatus] = useState<WorkspaceEnquiry["status"]>("OPEN"),
    [converting, setConverting] = useState<string>();
  if (!["OWNER", "ADMIN"].includes(d.membership.role)) return null;
  const enquiries = [...d.records.enquiry].sort((a, b) =>
    (a.followUpDate ?? "9999").localeCompare(b.followUpDate ?? "9999"),
  );
  const due = enquiries.filter(
    (e) =>
      ["OPEN", "WAITLIST"].includes(e.status) &&
      e.followUpDate &&
      e.followUpDate <= today,
  ).length;
  const staff = d.members.filter(
    (m) => m.active && ["OWNER", "ADMIN", "COACH"].includes(m.role),
  );
  async function save(form: HTMLFormElement) {
    const f = new FormData(form),
      value = (name: string) => String(f.get(name) ?? "").trim();
    const saved = await w.save<WorkspaceEnquiry>(
      "enquiry",
      {
        childName: value("childName"),
        guardianName: value("guardianName"),
        contact: value("contact"),
        source: value("source"),
        followUpDate: value("followUpDate"),
        notes: value("notes"),
        status,
        ...(status === "CLOSED" ? { closedReason: value("closedReason") } : {}),
        ...(editing ? { expectedVersion: editing.recordVersion } : {}),
      },
      editing?.id,
    );
    if (saved) {
      form.reset();
      setEditing(undefined);
      setStatus("OPEN");
    }
  }
  async function convert(form: HTMLFormElement, enquiry: WorkspaceEnquiry) {
    const f = new FormData(form),
      value = (name: string) => String(f.get(name) ?? "").trim();
    const result = await w.action<{ player: WorkspacePlayer }>(
      "convertEnquiry",
      enquiry.id,
      {
        coachId: value("coachId"),
        birthDate: value("birthDate"),
        ...(value("squadId") ? { squadId: value("squadId") } : {}),
      },
    );
    if (result) {
      setConverting(undefined);
      setOpen(false);
      onNavigate("players", { player: result.player.id });
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="button secondary" type="button">
          <Inbox size={16} /> Enquiries{due ? ` (${due} due)` : ""}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="portal-overlay" />
        <Dialog.Content className="portal-dialog">
          <Dialog.Title>Enquiries</Dialog.Title>
          <Dialog.Description>
            Families who have asked about a place, before there is a player
            record. Only owners and admins can see this list. Starting a trial
            creates one trial player; set up the trial enrolment and fee from
            the player afterwards.
          </Dialog.Description>
          <button
            className="portal-icon close"
            type="button"
            aria-label="Close enquiries"
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
          <form
            key={editing?.id ?? "new"}
            onSubmit={(event) => {
              event.preventDefault();
              void save(event.currentTarget);
            }}
          >
            <h3>{editing ? "Edit enquiry" : "New enquiry"}</h3>
            <label>
              Child’s name
              <input name="childName" required minLength={2} maxLength={120} defaultValue={editing?.childName} />
            </label>
            <label>
              Parent or guardian
              <input name="guardianName" required minLength={2} maxLength={120} defaultValue={editing?.guardianName} />
            </label>
            <label>
              Phone or email
              <input name="contact" required minLength={3} maxLength={200} defaultValue={editing?.contact} />
            </label>
            <label>
              How they heard of the academy
              <input name="source" maxLength={100} defaultValue={editing?.source} />
            </label>
            <label>
              Follow up on
              <input name="followUpDate" type="date" defaultValue={editing?.followUpDate} />
            </label>
            <label>
              Status
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as WorkspaceEnquiry["status"])
                }
              >
                <option value="OPEN">Open</option>
                <option value="WAITLIST">Waitlist</option>
                <option value="CLOSED">Closed</option>
              </select>
            </label>
            {status === "CLOSED" && (
              <label>
                Why it was closed
                <input name="closedReason" required maxLength={500} defaultValue={editing?.closedReason} />
              </label>
            )}
            <label>
              Notes (staff only)
              <textarea name="notes" rows={3} maxLength={2000} defaultValue={editing?.notes} />
            </label>
            {w.error && <p role="alert">{w.error}</p>}
            <button className="button primary" disabled={w.busy}>
              {w.busy ? "Saving…" : editing ? "Save enquiry" : "Add enquiry"}
            </button>
            {editing && (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setEditing(undefined);
                  setStatus("OPEN");
                }}
              >
                Cancel edit
              </button>
            )}
          </form>
          <ul aria-label="Recorded enquiries">
            {enquiries.map((e) => (
              <li key={e.id}>
                <strong>{e.childName}</strong> · {e.guardianName} · {e.contact}
                <br />
                {LABEL[e.status]}
                {e.followUpDate
                  ? ` · follow up ${displayDay(e.followUpDate)}${["OPEN", "WAITLIST"].includes(e.status) && e.followUpDate <= today ? " (due)" : ""}`
                  : ""}
                {e.source ? ` · ${e.source}` : ""}
                {e.status === "CLOSED" && e.closedReason ? ` · ${e.closedReason}` : ""}
                {e.status !== "CONVERTED" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(e);
                        setStatus(e.status as WorkspaceEnquiry["status"]);
                      }}
                    >
                      Edit
                    </button>
                  </>
                )}
                {e.status === "CONVERTED" && e.convertedPlayerId && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onNavigate("players", { player: e.convertedPlayerId! });
                      }}
                    >
                      Open player
                    </button>
                  </>
                )}
                {["OPEN", "WAITLIST"].includes(e.status) && (
                  <>
                    {" "}
                    <button type="button" onClick={() => setConverting(e.id)}>
                      Start trial
                    </button>
                  </>
                )}
                {converting === e.id && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void convert(event.currentTarget, e);
                    }}
                  >
                    <label>
                      Coach for {e.childName}
                      <select name="coachId" required defaultValue="">
                        <option value="">Choose a coach</option>
                        {staff.map((m) => (
                          <option key={m.id} value={m.userId}>
                            {m.name} · {m.role}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Date of birth (players must be under 18)
                      <input
                        type="date"
                        name="birthDate"
                        required
                        max={new Date().toISOString().slice(0, 10)}
                      />
                    </label>
                    <label>
                      Batch (optional)
                      <select name="squadId" defaultValue="">
                        <option value="">Not placed yet</option>
                        {d.records.squad.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="button primary" disabled={w.busy}>
                      Create trial player
                    </button>
                    <button type="button" onClick={() => setConverting(undefined)}>
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            ))}
            {!enquiries.length && <li>No enquiries recorded.</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
