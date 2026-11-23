"use client";
import { Check, Circle } from "lucide-react";

const COMMON = [
  "password",
  "passw0rd",
  "qwerty",
  "letmein",
  "welcome",
  "football",
  "sportozen",
  "academy",
  "iloveyou",
  "admin",
];

/** True when the text has a run of three or more steps up or down (abc, 123, 321). */
function hasSequence(text: string) {
  const s = text.toLowerCase();
  for (let i = 0; i + 2 < s.length; i++) {
    const a = s.charCodeAt(i),
      b = s.charCodeAt(i + 1),
      c = s.charCodeAt(i + 2);
    if ((b - a === 1 && c - b === 1) || (a - b === 1 && b - c === 1))
      return true;
  }
  return false;
}

export function passwordChecks(password: string, name: string, email: string) {
  const lower = password.toLowerCase(),
    parts = [
      ...name
        .toLowerCase()
        .split(/\s+/)
        .filter((part) => part.length >= 3),
      email.toLowerCase().split("@")[0],
    ].filter((part) => part && part.length >= 3);
  return [
    {
      id: "length",
      label: "At least 12 characters",
      ok: password.length >= 12,
    },
    {
      id: "common",
      label: "Avoid common words or sequences (e.g. 123456)",
      ok:
        password.length > 0 &&
        !COMMON.some((word) => lower.includes(word)) &&
        !hasSequence(password),
    },
    {
      id: "personal",
      label: "Does not contain your name or email",
      ok: password.length > 0 && !parts.some((part) => lower.includes(part)),
    },
  ];
}

/**
 * A guide beside the password box: three rules and a four-step bar. It only
 * advises; the server applies the real password policy and the length rule
 * is also enforced by the field itself.
 */
export function PasswordStrength({
  password,
  name,
  email,
}: {
  password: string;
  name: string;
  email: string;
}) {
  const checks = passwordChecks(password, name, email),
    met = checks.filter((check) => check.ok).length,
    steps =
      password.length === 0
        ? 0
        : Math.min(4, met + (password.length >= 16 ? 1 : 0)),
    word =
      password.length === 0
        ? "Enter at least 12 characters"
        : ["Weak", "Weak", "Fair", "Good", "Strong"][steps];
  return (
    <div className="password-strength" aria-live="polite">
      <div className="password-strength-head">
        <span>Password strength</span>
        <span>{word}</span>
      </div>
      <div className="password-strength-bars" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={step <= steps ? `on level-${steps}` : undefined}
          />
        ))}
      </div>
      <ul className="password-strength-rules">
        {checks.map((check) => (
          <li key={check.id} className={check.ok ? "ok" : undefined}>
            {check.ok ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Circle size={12} aria-hidden="true" />
            )}
            <span>{check.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
