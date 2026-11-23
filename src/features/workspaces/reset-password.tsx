"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button, Card } from "@/components/ui/primitives";
import "./secure.css";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";

export function ResetPassword({
  token,
  linkFailed,
}: {
  token: string;
  linkFailed: boolean;
}) {
  const [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  // Keep the one-time token out of the address bar and the browser history.
  useEffect(() => {
    if (window.location.search)
      window.history.replaceState(null, "", "/reset-password");
  }, []);
  return (
    <main className="secure-entry">
      <Link className="secure-wordmark" href="/">
        <SportozenSymbol />
        <span className="secure-wordmark-text">
          Sportozen <span>ACADEMY</span>
        </span>
      </Link>
      <Card>
        <p className="report-kicker">ONE PLATFORM. YOUR ACADEMY.</p>
        <h1>Choose a new password</h1>
        {done ? (
          <>
            <p role="status">
              Your password has been changed and you were signed out everywhere.
              Sign in with the new password.
            </p>
            <Link className="text-link" href="/sign-in">
              Go to sign in
            </Link>
          </>
        ) : linkFailed ? (
          <>
            <p role="alert">
              This reset link is not valid or has expired. Links work once and
              last 60 minutes.
            </p>
            <Link className="text-link" href="/sign-in">
              Back to sign in to request a new link
            </Link>
          </>
        ) : (
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              if (password !== confirm) {
                setError("The two passwords do not match.");
                return;
              }
              setBusy(true);
              try {
                const result = await authClient.resetPassword({
                  newPassword: password,
                  token,
                });
                if (result.error)
                  setError(
                    result.error.code === "INVALID_TOKEN"
                      ? "This reset link is not valid or has expired. Request a new one from the sign-in page."
                      : (result.error.message ??
                          "The password could not be changed."),
                  );
                else setDone(true);
              } catch {
                setError("Could not change the password. Please retry.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              Repeat the new password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <p className="muted">
              Use at least 12 characters. All your existing sessions end when
              you change the password.
            </p>
            {error && <p role="alert">{error}</p>}
            <Button disabled={busy}>
              {busy ? "Please wait…" : "Change password"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
