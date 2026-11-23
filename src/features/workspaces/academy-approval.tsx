"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/primitives";
import { workspaceRequest } from "@/lib/workspace-request";
import type { WorkspaceBootstrap } from "@/domain/home-summary";
import type { AcademyConfiguration } from "@/domain/workspace";
import type { ChecklistItem } from "@/domain/academy-lifecycle";
import { AcademyForm } from "./academy-form";
import "./secure.css";
import "./academy-approval.css";
import { displayInstant } from "@/services/date-display";

// What an owner sees while the academy is not yet approved: where the
// application stands, the reviewer's feedback, what is left to do, the academy
// profile, and the submit button. No operational screen is reachable from here
// (the server refuses those requests; this page only does not offer them).

interface OwnerView {
  state: string;
  label: string;
  text: string;
  version: number;
  submissions?: number;
  feedback?: string | null;
  checklist?: ChecklistItem[];
  progress?: { done: number; total: number };
  canSubmit?: boolean;
  canEdit?: boolean;
  history?: {
    action: string;
    state: string;
    reason: string | null;
    at: string;
  }[];
}
const ACTION_TEXT: Record<string, string> = {
  REGISTERED: "Academy created",
  MIGRATED: "Existing academy recorded by the approval migration",
  SUBMITTED: "Submitted for approval",
  RESUBMITTED: "Resubmitted for approval",
  REVIEW_STARTED: "A reviewer opened the application",
  APPROVED: "Approved",
  REJECTED: "Not approved",
  SUSPENDED: "Suspended",
  REACTIVATED: "Reactivated",
};
const when = (iso: string) => displayInstant(iso, undefined, { time: true });

export function AcademyApproval({
  academyId,
  bootstrap,
}: {
  academyId: string;
  bootstrap: WorkspaceBootstrap;
}) {
  const manager = ["OWNER", "ADMIN"].includes(bootstrap.membership.role),
    owner = bootstrap.membership.role === "OWNER";
  const [view, setView] = useState<OwnerView | null>(null),
    [academy, setAcademy] = useState<AcademyConfiguration>(bootstrap.academy),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState("");
  const router = useRouter();
  const load = useCallback(async () => {
    try {
      const next = await workspaceRequest<OwnerView>(
        `/api/workspaces/${encodeURIComponent(academyId)}/lifecycle`,
        "GET",
        undefined,
        undefined,
        { quiet: true },
      );
      setView(next);
      setError("");
      // The decision arrived while this page was open: open the academy.
      if (next.state === "ACTIVE") router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load the approval status.",
      );
    }
  }, [academyId, router]);
  useEffect(() => {
    // Loading the status is the effect of opening this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!manager)
    return (
      <main className="secure-page approval">
        <h1>{academy.name}</h1>
        <p role="status">This academy is not open yet.</p>
        <Link className="button secondary" href="/workspace">
          Your academy workspaces
        </Link>
      </main>
    );

  const submit = async () => {
    if (!view || busy) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      setView(
        await workspaceRequest<OwnerView>(
          `/api/workspaces/${encodeURIComponent(academyId)}/lifecycle`,
          "POST",
          { action: "submit", expectedVersion: view.version },
          undefined,
          { quiet: true },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="secure-page approval">
      <p className="report-kicker">Academy approval</p>
      <h1>{academy.name}</h1>
      <Link href="/workspace">Your academy workspaces</Link>
      {error && <p role="alert">{error}</p>}
      {!view ? (
        !error && <p role="status">Loading the approval status…</p>
      ) : (
        <>
          <Card>
            <h2>Application status</h2>
            <p className="approval-state" data-state={view.state}>
              <strong>{view.label}</strong>
              {view.submissions && view.submissions > 1
                ? ` · submitted ${view.submissions} times`
                : ""}
            </p>
            <p>{view.text}</p>
            {view.state === "REJECTED" && view.feedback && (
              <div className="approval-feedback" role="status">
                <strong>Feedback from Sportozen</strong>
                <p>{view.feedback}</p>
              </div>
            )}
            {/* The submit button is shown only where submitting is a step the owner can still take: while setting up, or after a
                rejection. Once the application is submitted, under review or decided, a greyed-out button is only noise. */}
            {owner && (view.state === "CONFIGURING" || view.state === "REJECTED") && (
              <button
                type="button"
                className="button"
                disabled={busy || !view.canSubmit}
                onClick={submit}
              >
                {busy
                  ? "Submitting…"
                  : view.state === "REJECTED"
                    ? "Resubmit for approval"
                    : "Submit for approval"}
              </button>
            )}
            {owner &&
              !view.canSubmit &&
              (view.state === "CONFIGURING" || view.state === "REJECTED") && (
                <p className="muted">
                  Complete the items marked “Required” below to submit.
                </p>
              )}
            {!owner && (
              <p className="muted">Only the academy owner can submit.</p>
            )}
            {(view.state === "SUBMITTED" ||
              view.state === "PENDING_REVIEW") && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void load()}
              >
                Check for a decision
              </button>
            )}
          </Card>

          {view.checklist && view.progress && (
            <Card>
              <h2>Onboarding progress</h2>
              <p>
                {view.progress.done} of {view.progress.total} complete
              </p>
              <ul className="approval-checklist">
                {view.checklist.map((item) => (
                  <li key={item.id} data-done={item.done}>
                    <span aria-hidden="true">{item.done ? "✓" : "○"}</span>{" "}
                    {item.label}
                    <span className="approval-tag">
                      {item.done ? "Done" : "To do"}
                      {item.required ? " · Required" : " · Optional"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {view.canEdit && (
            <Card>
              <h2>Academy profile</h2>
              <p className="muted">
                {view.state === "SUBMITTED" || view.state === "PENDING_REVIEW"
                  ? "You can still update your profile. A change while the application is under review asks the reviewer to look again."
                  : "Update the details Sportozen will review."}
              </p>
              {saved && <p role="status">{saved}</p>}
              <AcademyForm
                initial={academy}
                busy={busy}
                onSave={async (value) => {
                  setBusy(true);
                  setError("");
                  setSaved("");
                  try {
                    const next = await workspaceRequest<AcademyConfiguration>(
                      `/api/workspaces/${encodeURIComponent(academyId)}`,
                      "PATCH",
                      {
                        ...(value as object),
                        expectedVersion: academy.configVersion ?? 0,
                      },
                      undefined,
                      { quiet: true },
                    );
                    setAcademy(next);
                    setSaved("Academy profile saved.");
                    await load();
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : "Could not save.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </Card>
          )}

          {view.history && view.history.length > 0 && (
            <Card>
              <h2>History</h2>
              <ol className="approval-history">
                {view.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <strong>{ACTION_TEXT[h.action] ?? h.action}</strong>{" "}
                    <time dateTime={h.at}>{when(h.at)}</time>
                    {h.reason && <p>{h.reason}</p>}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
