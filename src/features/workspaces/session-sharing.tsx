"use client";
import { useState } from "react";
import type { FootballSession } from "@/domain/training";
import {
  buildIcs,
  googleCalendarLink,
  type IcsEvent,
} from "@/services/calendar-ics";
import { sessionMessage, type MessageSession } from "@/services/session-message";
import type { PortalController } from "./portal-types";
import { SharePeople } from "./share-people";

/** One session as a calendar event: time, place and drills only. */
export function sessionToEvent(
  session: FootballSession,
  batchName: string,
): IcsEvent {
  const drills = (session.agenda ?? [])
    .map(
      (a, i) =>
        `${i + 1}. ${a.drill.name}${a.duration ? ` (${a.duration} min)` : ""}`,
    )
    .join("\n");
  return {
    uid: `${session.id}@sportozen`,
    title: session.title?.trim() || `${batchName} training`,
    startAt: session.startAt,
    endAt: session.endAt,
    location: session.location,
    description: [batchName, drills && `Drills:\n${drills}`]
      .filter(Boolean)
      .join("\n\n"),
    sequence: session.version,
    updatedAt: session.updatedAt,
  };
}

/** Add this one session to the calendar on this device. Free; no account with Google needed on our side. */
export function AddToCalendar({
  session,
  batchName,
}: {
  session: FootballSession;
  batchName: string;
}) {
  if (!session.startAt || session.status === "DRAFT") return null;
  return <AddEventToCalendar event={sessionToEvent(session, batchName)} />;
}

/** The same two buttons for any event (a parent's schedule row has no staff session record behind it). */
export function AddEventToCalendar({ event }: { event: IcsEvent }) {
  function download() {
    const blob = new Blob([buildIcs(event.title, [event])], {
      type: "text/calendar;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "training-session.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return (
    <div className="ss-box">
      <strong>Add to my calendar</strong>
      <div className="ss-row">
        <a
          className="button secondary"
          target="_blank"
          rel="noopener noreferrer"
          href={googleCalendarLink(event)}
        >
          Google Calendar
        </a>
        <button type="button" className="secondary" onClick={download}>
          Apple / Outlook file (.ics)
        </button>
      </div>
    </div>
  );
}

type Person = {
  userId: string;
  role: "COACH" | "PARENT";
  name: string;
  email: string;
  phone: string | null;
  children: string[];
};
type Share = {
  academyName: string;
  country: string;
  session: MessageSession & { id: string };
  people: Person[];
};

/**
 * Tell the coaches running a session and the parents of its players, for free. One row per person; the buttons open the
 * sender's own WhatsApp or mail app with the message ready. Nothing is sent from here and nothing says "delivered".
 */
export function SessionShare({
  workspace: w,
  sessionId,
}: {
  workspace: PortalController;
  sessionId: string;
}) {
  const [share, setShare] = useState<Share | null>(null),
    [note, setNote] = useState(""),
    [error, setError] = useState("");
  async function load() {
    setError("");
    const value = await w.action<Share>("sessionShare", sessionId);
    if (value) setShare(value);
    else setError("The people for this session could not be loaded.");
  }
  if (!share)
    return (
      <div className="ss-box">
        <strong>Tell the coaches and parents</strong>
        <p>
          Opens a list of the coaches and the parents on this session. You
          press a button for each person and your own WhatsApp or mail app opens
          with the message ready. Free.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={w.busy}
          onClick={() => void load()}
        >
          Show who to tell
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  return (
    <div className="ss-box">
      <strong>Tell the coaches and parents</strong>
      <label>
        Add a note (optional)
        <textarea
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {share.people.length === 0 && (
        <p className="muted">
          Nobody with an account is linked to this session yet. Invite the
          parents from Settings, then come back.
        </p>
      )}
      {share.people.length > 0 && (
        <SharePeople
          workspace={w}
          country={share.country}
          people={share.people.map((p) => ({
            ...p,
            label:
              p.role === "COACH" ? "Coach" : `Parent of ${p.children.join(", ")}`,
          }))}
          messageFor={(p) => {
            const full = share.people.find((x) => x.userId === p.userId)!;
            return sessionMessage({
              academyName: share.academyName,
              session: share.session,
              person: full,
              note,
            });
          }}
        />
      )}
    </div>
  );
}

/** A private calendar link for the signed-in person: add it once and every session follows by itself. */
export function CalendarLinkCard({ workspace: w }: { workspace: PortalController }) {
  const [link, setLink] = useState<{ https: string; webcal: string } | null>(null),
    [copied, setCopied] = useState(false);
  async function make() {
    const value = await w.action<{ token: string }>("calendarLink");
    if (!value) return;
    const { host, protocol } = window.location,
      path = `//${host}/api/calendar/${value.token}.ics`;
    setLink({ https: `${protocol}${path}`, webcal: `webcal:${path}` });
    setCopied(false);
  }
  return (
    <details className="ss-box ss-calendar">
      <summary>My calendar link (free)</summary>
      <p>
        Add this link once to Google, Apple or Outlook calendar. New, changed
        and cancelled sessions then appear there by themselves, with the drills.
        Keep it private: anyone who has it can read your sessions. Making a new
        link stops the old one.
      </p>
      {!link ? (
        <button
          type="button"
          className="secondary"
          disabled={w.busy}
          onClick={() => void make()}
        >
          Make my calendar link
        </button>
      ) : (
        <>
          <input readOnly aria-label="Calendar link" value={link.https} />
          <div className="ss-row">
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.https);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="button secondary" href={link.webcal}>
              Open in my calendar app
            </a>
            <a
              className="button secondary"
              target="_blank"
              rel="noopener noreferrer"
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(link.webcal)}`}
            >
              Add to Google Calendar
            </a>
          </div>
          <small>
            Google can only read the link once the app is on its public web
            address.
          </small>
        </>
      )}
    </details>
  );
}
