"use client";
import { useState } from "react";
import {
  COUNTRY_CALLING_CODE,
  mailtoLink,
  gmailLink,
  outlookLink,
  normalizePhone,
  savedPhoneLink,
} from "@/services/share-links";
import type { PortalController } from "./portal-types";

export type SharePerson = {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  /** Shown after the name, for example "Coach" or "Parent of Rishi". */
  label?: string;
};

/**
 * One row per person with a WhatsApp and a mail button. The buttons open the sender's own app with the message ready;
 * nothing is sent from here, and "Opened" only means a button was pressed. A missing WhatsApp number can be typed once
 * and saved for next time.
 */
export function SharePeople({
  workspace: w,
  people: initial,
  country,
  messageFor,
}: {
  workspace: PortalController;
  people: SharePerson[];
  country: string;
  messageFor: (person: SharePerson) => { subject: string; text: string };
}) {
  const [people, setPeople] = useState(initial),
    [numbers, setNumbers] = useState<Record<string, string>>({}),
    [opened, setOpened] = useState<Set<string>>(new Set()),
    code = COUNTRY_CALLING_CODE[country] ?? null;
  async function savePhone(userId: string) {
    const value = await w.action<{ phone: string | null }>(
      "setPhone",
      undefined,
      { userId, phone: numbers[userId] ?? "" },
    );
    if (value)
      setPeople(
        people.map((p) => (p.userId === userId ? { ...p, phone: value.phone } : p)),
      );
  }
  const mark = (key: string) => setOpened(new Set(opened).add(key));
  return (
    <>
      <ul className="ss-people">
        {people.map((p) => {
          const m = messageFor(p),
            typed = (numbers[p.userId] ?? "").trim(),
            badPhone = !!typed && !normalizePhone(typed, code);
          return (
            <li key={p.userId}>
              <div>
                <strong>{p.name || p.email}</strong>{" "}
                {p.label && <small>{p.label}</small>}
              </div>
              <div className="ss-row">
                {p.phone ? (
                  <a
                    className="button primary"
                    target="_blank"
                    rel="noopener noreferrer"
                    href={savedPhoneLink(p.phone, m.text)}
                    onClick={() => mark(`w${p.userId}`)}
                  >
                    {opened.has(`w${p.userId}`) ? "Opened WhatsApp" : "WhatsApp"}
                  </a>
                ) : (
                  <span className="ss-row">
                    <input
                      type="tel"
                      aria-label={`WhatsApp number for ${p.name || p.email}`}
                      placeholder="+91 98765 43210"
                      value={numbers[p.userId] ?? ""}
                      onChange={(e) =>
                        setNumbers({ ...numbers, [p.userId]: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="secondary"
                      disabled={w.busy || badPhone || !typed}
                      onClick={() => void savePhone(p.userId)}
                    >
                      Save number
                    </button>
                  </span>
                )}
                {p.email && (
                  <a
                    className="button secondary"
                    href={mailtoLink(p.email, m.subject, m.text)}
                    onClick={() => mark(`m${p.userId}`)}
                  >
                    {opened.has(`m${p.userId}`) ? "Opened mail app" : "Mail app"}
                  </a>
                )}
                {p.email && (
                  <>
                    <a
                      className="button secondary"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={gmailLink(p.email, m.subject, m.text)}
                      onClick={() => mark(`m${p.userId}`)}
                    >
                      Gmail
                    </a>
                    <a
                      className="button secondary"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={outlookLink(p.email, m.subject, m.text)}
                      onClick={() => mark(`m${p.userId}`)}
                    >
                      Outlook
                    </a>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <small>
        “Opened” means a button was pressed. The app cannot know whether the
        message was sent or read.
      </small>
    </>
  );
}
