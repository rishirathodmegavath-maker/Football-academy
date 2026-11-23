"use client";
import { useState } from "react";
import {
  COUNTRY_CALLING_CODE,
  mailtoLink,
  gmailLink,
  outlookLink,
  normalizePhone,
  whatsappLink,
} from "@/services/share-links";

/**
 * Free sending. The person using the app presses a button, their own WhatsApp or mail app opens with the message ready,
 * and they press Send there. Nothing is sent by the server, no business account is needed, and the number or address typed
 * here is only used to open that app: it is not stored.
 */
export function SendByLink({
  text,
  subject,
  country,
  label = "Send this yourself, free",
}: {
  text: string;
  subject: string;
  country: string;
  label?: string;
}) {
  const [phone, setPhone] = useState(""),
    [email, setEmail] = useState(""),
    callingCode = COUNTRY_CALLING_CODE[country] ?? null,
    badPhone = !!phone.trim() && !normalizePhone(phone, callingCode);
  return (
    <details className="send-by-link">
      <summary>{label}</summary>
      <p>
        Open your own WhatsApp or mail app with this message ready, then press
        Send there. It is free and goes from your own number or address.
      </p>
      <label>
        Parent’s WhatsApp number (optional)
        <input
          type="tel"
          value={phone}
          placeholder="+91 98765 43210"
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      {badPhone && (
        <p role="alert">
          Enter the number with its country code, or leave it empty to choose the
          contact in WhatsApp.
        </p>
      )}
      <label>
        Parent’s email address (optional)
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <div className="inline">
        <a
          className="button primary"
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={badPhone}
          href={badPhone ? undefined : whatsappLink(phone, text, callingCode)}
        >
          Open WhatsApp
        </a>
        <a className="button secondary" href={mailtoLink(email, subject, text)}>
          Open mail app
        </a>
        <a
          className="button secondary"
          target="_blank"
          rel="noopener noreferrer"
          href={gmailLink(email, subject, text)}
        >
          Gmail
        </a>
        <a
          className="button secondary"
          target="_blank"
          rel="noopener noreferrer"
          href={outlookLink(email, subject, text)}
        >
          Outlook
        </a>
      </div>
    </details>
  );
}
