"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/primitives";
import { workspaceRequest } from "@/lib/workspace-request";
import { REASON_MAX, REASON_MIN } from "@/domain/academy-lifecycle";
import type { ChecklistItem } from "@/domain/academy-lifecycle";
import "./secure.css";
import "./academy-approval.css";
import { displayInstant } from "@/services/date-display";

// The platform administrator's review console: the queue of academy
// applications, one application's submitted profile and history, and the
// decisions (start review, approve, reject, suspend, reactivate). Every button
// is a request the server authorises again; hiding one is not the control.

export interface ApplicationItem {
  id: string;
  name: string;
  country: string;
  state: string;
  label: string;
  version: number;
  submissions: number;
  resubmitted: boolean;
  submittedAt: string | null;
  reviewerName: string | null;
  decidedAt: string | null;
  ownerName: string | null;
  tier: string | null;
  entitlement: string | null;
  carriedOver: boolean;
}
export interface ApplicationList {
  applications: ApplicationItem[];
  waiting: number;
  nextOffset: number | null;
}
interface Detail {
  id: string;
  state: string;
  label: string;
  version: number;
  submissions: number;
  resubmitted: boolean;
  submittedAt: string | null;
  reviewerName: string | null;
  feedback: string | null;
  owners: string[];
  carriedOver: boolean;
  profile: {
    name: string;
    contactEmail: string;
    country: string;
    location: string;
    phone: string;
    website: string;
    about: string;
    language: string;
    currency: string;
    timezone: string;
    modules: string[];
    hasLogo: boolean;
    configVersion: number;
    demo: boolean;
  };
  subscription: { tier: string; status: string; modules: string[] } | null;
  checklist: ChecklistItem[];
  allowed: string[];
  history: {
    id: number;
    from: string | null;
    to: string;
    action: string;
    actorKind: string;
    actorName: string | null;
    reason: string | null;
    configVersion: number | null;
    at: string;
  }[];
}
const FILTERS = [
  ["", "Needs attention first (all)"],
  ["SUBMITTED", "Submitted"],
  ["PENDING_REVIEW", "Pending review"],
  ["REJECTED", "Not approved"],
  ["CONFIGURING", "Setting up"],
  ["ACTIVE", "Approved and active"],
  ["SUSPENDED", "Suspended"],
] as const;
const BUTTON: Record<string, string> = {
  startReview: "Start review",
  approve: "Approve",
  reject: "Reject",
  suspend: "Suspend",
  reactivate: "Reactivate",
};
const NEEDS_REASON = new Set(["reject", "suspend"]);
const when = (iso: string | null) =>
  iso
    ? displayInstant(iso, undefined, { time: true })
    : "—";

export function PlatformAccounts({ initial }: { initial: ApplicationList }) {
  const [list, setList] = useState(initial),
    [filter, setFilter] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);

  const reload = useCallback(async (state: string) => {
    const query = state ? `?state=${encodeURIComponent(state)}` : "";
    setList(
      await workspaceRequest<ApplicationList>(
        `/api/platform/applications${query}`,
        "GET",
        undefined,
        undefined,
        { quiet: true },
      ),
    );
  }, []);
  const open = async (id: string) => {
    setError("");
    setNotice("");
    setReason("");
    try {
      setDetail(
        await workspaceRequest<Detail>(
          `/api/platform/applications/${encodeURIComponent(id)}`,
          "GET",
          undefined,
          undefined,
          { quiet: true },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open it.");
    }
  };
  const decide = async (decision: string) => {
    if (!detail || busy) return;
    const trimmed = reason.trim();
    if (NEEDS_REASON.has(decision) && trimmed.length < REASON_MIN) {
      setError(
        `Write a reason of at least ${REASON_MIN} characters. The academy owner will read it.`,
      );
      return;
    }
    if (
      decision === "suspend" &&
      !window.confirm(
        `Suspend ${detail.profile.name}? Every owner, coach and parent in this academy loses access until it is reactivated.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await workspaceRequest<{ application: Detail }>(
        `/api/platform/applications/${encodeURIComponent(detail.id)}/decision`,
        "POST",
        {
          decision,
          expectedVersion: detail.version,
          ...(trimmed ? { reason: trimmed } : {}),
        },
        undefined,
        { quiet: true },
      );
      setDetail(result.application);
      setReason("");
      setNotice(`${BUTTON[decision]}: done.`);
      await reload(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision failed.");
      // A stale version means someone else decided: show the current state.
      await open(detail.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="secure-workspace review">
      <h1>Academy applications</h1>
      <p>
        Review new academies before they can run operations. Customer metadata
        only: nothing about players is shown here, and no billing is collected.
      </p>
      <Link href="/workspace">Your academy memberships</Link>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <Card>
        <div className="review-filter">
          <label>
            Show
            <select
              value={filter}
              onChange={async (e) => {
                setFilter(e.target.value);
                try {
                  await reload(e.target.value);
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Could not load.",
                  );
                }
              }}
            >
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p role="status">{list.waiting} waiting for a decision</p>
        </div>
        {list.applications.length === 0 ? (
          <p>No academies match.</p>
        ) : (
          <ul className="review-list">
            {list.applications.map((a) => (
              <li key={a.id}>
                <div className="review-row">
                  <strong>{a.name}</strong>
                  <span>
                    {a.label}
                    {a.resubmitted ? " · resubmitted" : ""}
                  </span>
                </div>
                <div className="review-meta">
                  {a.country} · owner {a.ownerName ?? "unknown"} · submitted{" "}
                  {when(a.submittedAt)}
                  {a.reviewerName ? ` · reviewer ${a.reviewerName}` : ""}
                  {a.carriedOver
                    ? " · existed before approval was required"
                    : ""}
                </div>
                <div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => open(a.id)}
                    aria-label={`Open application: ${a.name}`}
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {list.nextOffset !== null && (
          <button
            type="button"
            className="button secondary"
            onClick={async () => {
              const query = new URLSearchParams({
                offset: String(list.nextOffset),
              });
              if (filter) query.set("state", filter);
              try {
                const more = await workspaceRequest<ApplicationList>(
                  `/api/platform/applications?${query}`,
                  "GET",
                  undefined,
                  undefined,
                  { quiet: true },
                );
                setList({
                  ...more,
                  applications: [...list.applications, ...more.applications],
                });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not load.");
              }
            }}
          >
            Show more
          </button>
        )}
      </Card>

      {detail && (
        <Card>
          <section className="review-detail" aria-label="Application details">
            <h2>{detail.profile.name}</h2>
            <p>
              <strong>{detail.label}</strong>
              {detail.resubmitted
                ? ` · submitted ${detail.submissions} times`
                : ""}
              {detail.carriedOver
                ? " · this academy existed before approval was required; no reviewer decided it"
                : ""}
            </p>
            <dl>
              <dt>Owner</dt>
              <dd>{detail.owners.join(", ") || "—"}</dd>
              <dt>Contact email</dt>
              <dd>{detail.profile.contactEmail}</dd>
              <dt>Country</dt>
              <dd>{detail.profile.country}</dd>
              <dt>Location</dt>
              <dd>{detail.profile.location || "—"}</dd>
              <dt>Phone</dt>
              <dd>{detail.profile.phone || "—"}</dd>
              <dt>Website</dt>
              <dd>{detail.profile.website || "—"}</dd>
              <dt>About</dt>
              <dd>{detail.profile.about || "—"}</dd>
              <dt>Region</dt>
              <dd>
                {detail.profile.language} · {detail.profile.currency} ·{" "}
                {detail.profile.timezone}
              </dd>
              <dt>Modules</dt>
              <dd>{detail.profile.modules.join(", ") || "—"}</dd>
              <dt>Logo</dt>
              <dd>{detail.profile.hasLogo ? "Provided" : "None"}</dd>
              <dt>Demo academy</dt>
              <dd>{detail.profile.demo ? "Yes (labelled fictional)" : "No"}</dd>
              <dt>Submitted</dt>
              <dd>{when(detail.submittedAt)}</dd>
              <dt>Reviewer</dt>
              <dd>{detail.reviewerName ?? "—"}</dd>
            </dl>
            <h3>Checklist</h3>
            <ul className="approval-checklist">
              {detail.checklist.map((c) => (
                <li key={c.id} data-done={c.done}>
                  <span aria-hidden="true">{c.done ? "✓" : "○"}</span> {c.label}
                  <span className="approval-tag">
                    {c.done ? "Done" : "To do"}
                    {c.required ? " · Required" : " · Optional"}
                  </span>
                </li>
              ))}
            </ul>

            {detail.allowed.length > 0 && (
              <div className="review-reason">
                <label htmlFor="review-reason-text">
                  Reason or note for the academy owner (required to reject or
                  suspend; optional otherwise)
                </label>
                <textarea
                  id="review-reason-text"
                  value={reason}
                  maxLength={REASON_MAX}
                  aria-describedby="review-reason-count"
                  onChange={(e) => setReason(e.target.value)}
                />
                <span id="review-reason-count" className="review-counter">
                  {reason.trim().length} / {REASON_MAX} characters (at least{" "}
                  {REASON_MIN} to reject or suspend)
                </span>
                <div className="review-actions">
                  {detail.allowed.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={
                        a === "approve" ||
                        a === "startReview" ||
                        a === "reactivate"
                          ? "button"
                          : "button secondary"
                      }
                      disabled={busy}
                      onClick={() => decide(a)}
                    >
                      {BUTTON[a]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <h3>History</h3>
            <ol className="approval-history">
              {detail.history.map((h) => (
                <li key={h.id}>
                  <strong>{h.action.replace("_", " ").toLowerCase()}</strong>{" "}
                  <time dateTime={h.at}>{when(h.at)}</time> ·{" "}
                  {h.actorKind === "SYSTEM"
                    ? (h.actorName ?? "system")
                    : (h.actorName ?? h.actorKind.toLowerCase())}
                  {h.configVersion !== null
                    ? ` · profile version ${h.configVersion}`
                    : ""}
                  {h.reason && <p>{h.reason}</p>}
                </li>
              ))}
            </ol>
          </section>
        </Card>
      )}
    </main>
  );
}
