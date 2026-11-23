"use client";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * A password field with a show / hide button. The button sits beside the label
 * (not inside it), so the field is still named exactly "Password"; its own name
 * is "Show password" or "Hide password" and it reports its state with
 * aria-pressed. It starts hidden.
 */
export function PasswordField({
  label = "Password",
  value,
  onChange,
  autoComplete,
  minLength,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <label>
        {label}
        <input
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          required
          // A visible password is not something to correct or suggest.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="password-toggle"
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? (
          <EyeOff size={18} aria-hidden="true" />
        ) : (
          <Eye size={18} aria-hidden="true" />
        )}
        <span className="password-toggle-text">
          {shown ? "Hide password" : "Show password"}
        </span>
      </button>
    </div>
  );
}
