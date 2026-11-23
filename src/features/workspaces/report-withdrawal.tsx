"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Undo2, X } from "lucide-react";
import type { WorkspaceReport } from "@/domain/workspace";
import type { PortalController } from "./portal-types";

const MIN_REASON = 10;
/**
 * Owner and admin control that pulls an approved report back from families
 * (P1-10). The server enforces the role, the reason and the report's state;
 * this dialog only collects the reason and says plainly what will happen.
 */
export function WithdrawReport({
  workspace: w,
  report,
}: {
  workspace: PortalController;
  report: WorkspaceReport;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState("");
  const valid = reason.trim().length >= MIN_REASON;
  const submit = async () => {
    const result = await w.action<WorkspaceReport>(
      "withdrawReport",
      report.id,
      { reason: reason.trim(), expectedVersion: report.recordVersion },
    );
    if (result) {
      setOpen(false);
      setReason("");
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="button secondary" type="button">
          <Undo2 size={14} />
          Withdraw
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="portal-overlay" />
        <Dialog.Content className="portal-dialog">
          <Dialog.Title>Withdraw this approved report</Dialog.Title>
          <Dialog.Description>
            Families stop seeing the report straight away, and any update
            published from it is taken back. The approved version stays in the
            academy&apos;s history. Prepare and approve a corrected report
            afterwards if one is needed.
          </Dialog.Description>
          <button
            className="portal-icon close"
            type="button"
            aria-label="Close withdraw dialog"
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
          <label>
            Reason for withdrawing (kept in the academy audit log)
            <textarea
              required
              minLength={MIN_REASON}
              maxLength={1000}
              rows={4}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {!valid && reason.length > 0 && (
            <p role="note">
              Write at least {MIN_REASON} characters so the reason is useful
              later.
            </p>
          )}
          {w.error && <p role="alert">{w.error}</p>}
          <button
            className="button primary"
            type="button"
            disabled={!valid || w.busy}
            onClick={submit}
          >
            {w.busy ? "Withdrawing…" : "Withdraw report"}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
