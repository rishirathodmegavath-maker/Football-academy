"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { workspaceRequest } from "@/hooks/use-workspace";
import { Button, Card, PageTitle } from "@/components/ui/primitives";
import "./secure.css";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";

type Status = { enabled: boolean; required: boolean; policy: string };
type Setup = { uri: string; key: string; recoveryCodes: string[] };
const keyFromUri = (uri: string) =>
  new URL(uri).searchParams.get("secret") ?? "";

/**
 * Account security: two-step verification (authenticator app + recovery codes),
 * password change and "sign out other devices". Everything here calls the same
 * Better Auth endpoints the rest of the application uses; the server decides
 * what is allowed.
 */
export function AccountSecurity() {
  const [status, setStatus] = useState<Status | null>(null),
    [signedIn, setSignedIn] = useState<boolean | null>(null),
    [setup, setSetup] = useState<Setup | null>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await workspaceRequest<{ account: Status }>(
        "/api/workspaces",
        "GET",
      );
      setStatus(result.account);
      setSignedIn(true);
    } catch {
      setSignedIn(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of the account state
    void load();
  }, [load]);
  /** Runs one account action, showing its result and keeping the form usable. */
  async function run(
    action: () => Promise<{ error?: { message?: string } | null } | unknown>,
    done: string,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await action()) as {
        error?: { message?: string } | null;
      };
      if (result?.error) setError(result.error.message ?? "That did not work.");
      else {
        setNotice(done);
        await load();
        return true;
      }
    } catch {
      setError("Could not complete that. Please retry.");
    } finally {
      setBusy(false);
    }
    return false;
  }
  if (signedIn === false)
    return (
      <main className="secure-page">
        <PageTitle
          title="Account security"
          description="Sign in to manage your account."
        />
        <Link className="button primary" href="/sign-in">
          Sign in
        </Link>
      </main>
    );
  return (
    <main className="secure-page">
      <div className="secure-topline">
        <Link className="secure-wordmark" href="/">
          <SportozenSymbol />
          <span className="secure-wordmark-text">
            Sportozen <span>ACADEMY</span>
          </span>
        </Link>
        <Link className="text-link" href="/workspace">
          Back to your academies
        </Link>
      </div>
      <PageTitle
        title="Account security"
        description="Protect your account with a second step and manage your sessions."
      />
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="two-columns">
        <Card>
          <h2>Two-step verification</h2>
          {status?.required && !status.enabled && (
            <p role="alert">
              Your role requires two-step verification. Turn it on to keep using
              your academy.
            </p>
          )}
          <p>
            {status?.enabled
              ? "On. You enter a code from your authenticator app each time you sign in."
              : "Off. Turn it on to require a code from an authenticator app when you sign in."}
          </p>
          {codes && (
            <>
              <p>
                Save these recovery codes somewhere safe. Each works once if you
                lose your phone. They are shown only now.
              </p>
              <pre aria-label="Recovery codes">{codes.join("\n")}</pre>
              <Button variant="secondary" onClick={() => setCodes(null)}>
                I have saved them
              </Button>
            </>
          )}
          {setup ? (
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await run(
                    () => authClient.twoFactor.verifyTotp({ code }),
                    "Two-step verification is on.",
                  )
                ) {
                  setCodes(setup.recoveryCodes);
                  setSetup(null);
                  setCode("");
                }
              }}
            >
              <p>
                1. Add this account to an authenticator app: open{" "}
                <a href={setup.uri}>the setup link</a> on your phone, or enter
                this key by hand.
              </p>
              <pre aria-label="Setup key">{setup.key}</pre>
              <p>2. Enter the 6-digit code the app shows.</p>
              <label>
                Authentication code
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <Button disabled={busy}>Confirm and turn on</Button>
            </form>
          ) : (
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const turningOn = !status?.enabled;
                const outcome = await run(
                  async () => {
                    if (turningOn) {
                      const result = await authClient.twoFactor.enable({
                        password,
                      });
                      if (result.data && "totpURI" in result.data)
                        setSetup({
                          uri: result.data.totpURI,
                          key: keyFromUri(result.data.totpURI),
                          recoveryCodes: result.data.backupCodes ?? [],
                        });
                      return result;
                    }
                    return authClient.twoFactor.disable({ password });
                  },
                  turningOn
                    ? "Scan or enter the key below to finish."
                    : "Two-step verification is off.",
                );
                if (outcome) setPassword("");
              }}
            >
              <label>
                Your password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <Button disabled={busy}>
                {status?.enabled ? "Turn off" : "Turn on"}
              </Button>
              {status?.enabled && (
                <Button
                  variant="secondary"
                  type="button"
                  disabled={busy || !password}
                  onClick={async () => {
                    if (!password) return;
                    setBusy(true);
                    setError("");
                    const result = await authClient.twoFactor
                      .generateBackupCodes({ password })
                      .catch(() => null);
                    setBusy(false);
                    if (result?.data) {
                      setCodes(result.data.backupCodes);
                      setPassword("");
                    } else setError("Check your password and try again.");
                  }}
                >
                  Make new recovery codes
                </Button>
              )}
            </form>
          )}
        </Card>
        <Card>
          <h2>Password and sessions</h2>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (next !== repeat) {
                setError("The two new passwords do not match.");
                return;
              }
              if (
                await run(
                  () =>
                    authClient.changePassword({
                      currentPassword: current,
                      newPassword: next,
                      revokeOtherSessions: true,
                    }),
                  "Password changed. Your other devices were signed out.",
                )
              ) {
                setCurrent("");
                setNext("");
                setRepeat("");
              }
            }}
          >
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <label>
              Repeat the new password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </label>
            <Button disabled={busy}>Change password</Button>
          </form>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              run(
                () => authClient.revokeOtherSessions(),
                "Every other device was signed out.",
              )
            }
          >
            Sign out other devices
          </Button>
        </Card>
      </div>
    </main>
  );
}
