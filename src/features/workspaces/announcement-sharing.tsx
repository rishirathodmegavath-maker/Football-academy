"use client";
import { useState } from "react";
import type { PortalController } from "./portal-types";
import { SharePeople, type SharePerson } from "./share-people";
import "./portal-calendar.css";

type Share = {
  academyName: string;
  country: string;
  heading: string;
  body: string;
  optedOut: number;
  people: (SharePerson & { children: string[] })[];
};

/** Send an approved announcement to the parents of its batches, for free: one WhatsApp and one mail button per parent. */
export function AnnouncementShare({
  workspace: w,
  announcementId,
}: {
  workspace: PortalController;
  announcementId: string;
}) {
  const [share, setShare] = useState<Share | null>(null),
    [error, setError] = useState("");
  async function load() {
    setError("");
    const value = await w.action<Share>("announcementShare", announcementId);
    if (value) setShare(value);
    else setError("The parents for this announcement could not be loaded.");
  }
  if (!share)
    return (
      <div className="ss-box">
        <strong>Send it to parents (free)</strong>
        <p>
          Parents already see it in the app. To also message them, show the list
          and press WhatsApp or Mail for each parent: your own app opens with
          the message ready.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={w.busy}
          onClick={() => void load()}
        >
          Show parents to message
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  return (
    <div className="ss-box">
      <strong>Send it to parents (free)</strong>
      {share.people.length === 0 && (
        <p className="muted">No parent with an account is linked to these batches.</p>
      )}
      {share.optedOut > 0 && (
        <p className="muted">
          {share.optedOut} parent{share.optedOut === 1 ? " has" : "s have"} asked
          not to be messaged and {share.optedOut === 1 ? "is" : "are"} left out.
        </p>
      )}
      {share.people.length > 0 && (
        <SharePeople
          workspace={w}
          country={share.country}
          people={share.people.map((p) => ({
            ...p,
            label: `Parent of ${p.children.join(", ")}`,
          }))}
          messageFor={(p) => ({
            subject: `${share.heading} · ${share.academyName}`,
            text: [
              `Hello ${p.name.trim().split(/\s+/)[0] || "there"},`,
              "",
              share.heading,
              share.body,
              "",
              `— ${share.academyName}`,
            ].join("\n"),
          })}
        />
      )}
    </div>
  );
}
