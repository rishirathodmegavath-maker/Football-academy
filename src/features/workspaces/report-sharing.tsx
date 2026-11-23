"use client";
import { useState } from "react";
import type { WorkspaceReport } from "@/domain/workspace";
import { reportFilename } from "@/services/reports/report-view-model";
import type { PortalController } from "./portal-types";
import { SharePeople, type SharePerson } from "./share-people";

type Person = SharePerson;
type Share = {
  academyName: string;
  country: string;
  report: { id: string; period: string; childFirstName: string };
  people: Person[];
};

/**
 * Send an approved report to a child's parents, for free.
 *  - "Share the PDF": on a phone the system share sheet hands the real PDF to WhatsApp or Mail. A computer cannot attach a
 *    file through a link, so the PDF is downloaded and the sender attaches it in the message that opens.
 *  - Per parent: WhatsApp or mail opens with a short message and the private sign-in page, so a child's report is never
 *    pasted into a chat.
 * "Opened" means a button was pressed; delivery and reading are unknowable and are never claimed.
 */
export function ShareReport({
  workspace: w,
  academyId,
  report,
}: {
  workspace: PortalController;
  academyId: string;
  report: WorkspaceReport;
}) {
  const [share, setShare] = useState<Share | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setError("");
    const value = await w.action<Share>("reportShare", report.id);
    if (value) setShare(value);
    else setError("The parents for this report could not be loaded.");
  }
  async function sharePdf() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/workspaces/${academyId}/reports/${report.id}/pdf`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "PDF unavailable.");
      const blob = await response.blob(),
        name = reportFilename(report.snapshot!),
        file = new File([blob], name, { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: "Development report",
            text: "Development report",
          });
          setNotice("Share sheet opened.");
          return;
        } catch (e) {
          // The person closed the sheet: nothing to do, nothing failed.
          if ((e as Error).name === "AbortError") return;
          throw e;
        }
      }
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice(
        "This device cannot send a file straight to WhatsApp. The PDF was downloaded: press WhatsApp or Mail on a parent below and attach it there.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare the PDF.");
    } finally {
      setBusy(false);
    }
  }
  if (!share)
    return (
      <div className="ss-box">
        <strong>Send to parents (free)</strong>
        <button
          type="button"
          className="secondary"
          disabled={w.busy}
          onClick={() => void load()}
        >
          Send this report to parents
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const page = `${window.location.origin}/workspace/${academyId}`,
    subject = `${share.report.childFirstName}'s development report · ${share.report.period}`;
  return (
    <div className="ss-box">
      <strong>Send to parents (free)</strong>
      <div className="ss-row">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void sharePdf()}
        >
          {busy ? "Preparing PDF…" : "Share the PDF"}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {share.people.length === 0 && (
        <p className="muted">
          No parent account is linked to this child yet. Invite the parent from
          Settings first.
        </p>
      )}
      {share.people.length > 0 && (
        <SharePeople
          workspace={w}
          country={share.country}
          people={share.people}
          messageFor={(p) => {
            const first = p.name.trim().split(/\s+/)[0] || "there";
            return {
              subject,
              text: [
                `Hello ${first},`,
                "",
                `${share.report.childFirstName}'s development report for ${share.report.period} is ready.`,
                `You can read it privately here after signing in: ${page}`,
                "",
                `— ${share.academyName}`,
              ].join("\n"),
            };
          }}
        />
      )}
    </div>
  );
}
