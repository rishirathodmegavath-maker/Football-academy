"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button, Card } from "@/components/ui/primitives";
import "./secure.css";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";
import { GoogleSignIn } from "./google-sign-in";
import { PasswordField } from "./password-field";
import { AuthSplitShell } from "./auth-split-shell";
import { PasswordStrength } from "./password-strength";
import { markJustSignedIn } from "./just-signed-in";
import { workspaceRequest } from "@/hooks/use-workspace";
import { invitationRoleWords } from "./role-labels";

/** What an invitation link says, shown on the page it opens (see app/join). */
export interface InviteContext {
  token: string;
  email: string;
  academyName: string;
  /** COACH, PARENT or PLAYER. */
  role: string;
  playerNames: string[];
  /** An account for this address exists: the person signs in instead of creating one. */
  accountExists: boolean;
  /** A player link: not tied to one address (the person uses their own), and it works once. */
  open?: boolean;
}

export function SignIn({
  verificationRequired = false,
  recoveryAvailable = false,
  demoAvailable = false,
  googleAvailable = false,
  googleError,
  landing,
  invite,
  environmentNotice,
}: {
  /** Set by the server in non-production environments only (services/environment-notice.ts). */
  environmentNotice?: string | null;
  /** Set by the invitation page: the address is fixed and, once signed in, the invitation is accepted. */
  invite?: InviteContext;
  /** Set by the server from SPORTOZEN_EMAIL_VERIFICATION. */
  verificationRequired?: boolean;
  /** Set by the server from SPORTOZEN_PASSWORD_RECOVERY. */
  recoveryAvailable?: boolean;
  /** The browser demo is not served in production (see app/(demo)/layout.tsx). */
  demoAvailable?: boolean;
  /** Set by the server: Google OAuth is configured (the secret never reaches the page). */
  googleAvailable?: boolean;
  /** Set by the server when Google sent the browser back with a failure: a fixed message, never address text. */
  googleError?: string;
  /** Set by the server from the emailed link's redirect (?verified / ?error). */
  landing?: "verified" | "invalid-link";
}) {
  const router = useRouter(),
    [register, setRegister] = useState(invite ? !invite.accountExists : false),
    [forgot, setForgot] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(invite?.email ?? ""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    // Optional WhatsApp number, saved with the membership when an invitation is accepted.
    [phone, setPhone] = useState(""),
    // Second step of sign-in, shown only for an account that turned on two-step verification.
    [challenge, setChallenge] = useState(false),
    [code, setCode] = useState(""),
    [recoveryCode, setRecoveryCode] = useState(false),
    [busy, setBusy] = useState(false),
    // Google is being contacted; the e-mail form waits.
    [googleBusy, setGoogleBusy] = useState(false),
    [error, setError] = useState(
      googleError ??
        (landing === "invalid-link"
          ? "That confirmation link is not valid or has expired. Sign in again and we will send a new one."
          : ""),
    ),
    [notice, setNotice] = useState(
      landing === "verified"
        ? "Your email address is confirmed. You can sign in now."
        : "",
    );
  // Drop the query string once it has been read (the invitation page keeps its address).
  useEffect(() => {
    if (!invite && window.location.search)
      window.history.replaceState(null, "", "/sign-in");
  }, [invite]);
  // The link proves the person owns the invited address, so an account still
  // waiting for its confirmation e-mail is confirmed before signing in.
  const confirmInviteEmail = () =>
    invite
      ? workspaceRequest("/api/invitations/confirm-email", "POST", {
          token: invite.token,
        }).catch(() => undefined)
      : Promise.resolve(undefined);
  // Signed in: an invited person joins the academy and lands inside it.
  const finish = async () => {
    markJustSignedIn();
    if (invite) {
      try {
        const joined = await workspaceRequest<{ academyId: string }>(
          "/api/invitations/accept",
          "POST",
          { token: invite.token, ...(phone.trim() ? { phone: phone.trim() } : {}) },
        );
        router.push(`/workspace/${joined.academyId}`);
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "The invitation could not be accepted. Please retry.",
        );
        return;
      }
    } else router.push("/workspace");
    router.refresh();
  };
  return (
    <AuthSplitShell
      registering={register}
      story={
        invite
          ? {
              eyebrow: "YOU ARE INVITED",
              title: (
                <>
                  Join {invite.academyName}
                  <br />
                  in one step.
                </>
              ),
              lead: "Set up your sign-in once. Next time, sign in with the same email and password, or with Google, and you go straight to your academy.",
            }
          : undefined
      }
    >
      <main className="secure-entry">
        <Link className="secure-wordmark" href="/">
          <SportozenSymbol />
          <span className="secure-wordmark-text">
            Sportozen <span>ACADEMY</span>
          </span>
        </Link>
        <Card>
          <p className="report-kicker">
            {invite ? "YOUR INVITATION" : "ONE PLATFORM. YOUR ACADEMY."}
          </p>
          <h1>
            {challenge
              ? "Two-step verification"
              : forgot
                ? "Reset your password"
                : invite
                  ? `Join ${invite.academyName}`
                  : register
                    ? "Create your account"
                    : "Sign in"}
          </h1>
          <p>
            {invite && !challenge && !forgot
              ? `You are invited as ${invitationRoleWords[invite.role] ?? "a member"}${invite.playerNames.length ? ` for ${invite.playerNames.join(", ")}` : ""}. ${register ? "Choose a name and a password." : "Sign in to join."} ${invite.open ? "Use the email address you want for your account." : `Use ${invite.email}.`}`
              : challenge
                ? recoveryCode
                  ? "Enter one of your recovery codes. Each code works once."
                  : "Enter the 6-digit code from your authenticator app."
                : forgot
                  ? "Enter the email address of your account and we will send you a link to choose a new password."
                  : "Access only the academies where you have an active membership."}
          </p>
          {!challenge && !forgot && (
            <GoogleSignIn
              available={googleAvailable}
              registering={register}
              disabled={busy}
              onPending={setGoogleBusy}
              returnTo={invite ? `/join/${invite.token}` : undefined}
            />
          )}
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setNotice("");
              try {
                if (challenge) {
                  const verified = recoveryCode
                    ? await authClient.twoFactor.verifyBackupCode({ code })
                    : await authClient.twoFactor.verifyTotp({ code });
                  if (verified.error)
                    setError(
                      verified.error.status === 429
                        ? "Too many attempts. Wait a few seconds and try again."
                        : "That code was not accepted. Check it and try again, or sign in again if it has been a few minutes.",
                    );
                  else await finish();
                  return;
                }
                if (forgot) {
                  // The link is always offered; where e-mail delivery is not
                  // switched on, say so instead of promising a message.
                  if (!recoveryAvailable) {
                    setNotice(
                      "Password reset by email is not switched on for this deployment yet. Ask your academy owner to help you regain access.",
                    );
                    return;
                  }
                  const reset = await authClient.requestPasswordReset({
                    email,
                    redirectTo: "/reset-password",
                  });
                  if (reset.error?.status === 429) {
                    setError(
                      "Too many reset requests. Wait a minute and try again.",
                    );
                    return;
                  }
                  // The same answer whether or not the address has an account.
                  setNotice(
                    "If an account exists for that address, a reset link is on its way. It works once and expires in 60 minutes.",
                  );
                  return;
                }
                if (register && password !== confirm) {
                  setError("The two passwords do not match.");
                  return;
                }
                if (invite && !invite.open && !register) await confirmInviteEmail();
                const result = register
                  ? await authClient.signUp.email({
                      email,
                      password,
                      name,
                    })
                  : await authClient.signIn.email({
                      email,
                      password,
                    });
                if (result.data && "twoFactorRedirect" in result.data) {
                  setChallenge(true);
                  setPassword("");
                  setConfirm("");
                  setCode("");
                } else if (result.error) {
                  setError(
                    result.error.status === 403 && verificationRequired
                      ? "Confirm your email address first. We have sent you a fresh confirmation link."
                      : (result.error.message ?? "Check your account details."),
                  );
                } else if (
                  register &&
                  verificationRequired &&
                  (!invite || invite.open)
                ) {
                  // A player link cannot confirm an address (it is not tied to one), so the usual confirmation email applies.
                  setRegister(false);
                  setPassword("");
                  setConfirm("");
                  setNotice(
                    invite?.open
                      ? "Check your email: we sent a link to confirm your address. Once you have followed it, sign in here to finish joining."
                      : "Check your email: we sent a link to confirm your address. Sign in once you have followed it.",
                  );
                } else {
                  if (invite && register && verificationRequired) {
                    // The account exists but is not signed in yet: the link has
                    // confirmed the address, so sign in now.
                    await confirmInviteEmail();
                    const again = await authClient.signIn.email({
                      email,
                      password,
                    });
                    if (again.error) {
                      setError(
                        again.error.message ?? "Check your account details.",
                      );
                      return;
                    }
                  }
                  await finish();
                }
              } catch {
                setError(
                  forgot
                    ? "Could not send the reset link. Please retry."
                    : "Could not sign in. Please retry.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {challenge && (
              <label>
                {recoveryCode ? "Recovery code" : "Authentication code"}
                <input
                  autoComplete="one-time-code"
                  inputMode={recoveryCode ? "text" : "numeric"}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            )}
            {!challenge && register && !forgot && (
              <label>
                Your name
                <input
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {!challenge && (
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  readOnly={!!invite && !invite.open}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
            {invite && !challenge && !forgot && (
              <label>
                Your WhatsApp number (optional)
                <input
                  type="tel"
                  autoComplete="tel"
                  maxLength={40}
                  placeholder="+91 98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <small className="muted">
                  Saved so the academy can WhatsApp you. You will not be asked
                  again, and you can change it later.
                </small>
              </label>
            )}
            {!challenge && !forgot && (
              <PasswordField
                value={password}
                onChange={setPassword}
                autoComplete={register ? "new-password" : "current-password"}
                minLength={12}
              />
            )}
            {register && !forgot && !challenge && (
              <>
                <PasswordStrength
                  password={password}
                  name={name}
                  email={email}
                />
                <PasswordField
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  autoComplete="new-password"
                  minLength={12}
                />
              </>
            )}
            {register && !forgot && (
              <p className="muted">
                Use at least 12 characters. Credentials stay in the server
                authentication system.
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && <p role="alert">{error}</p>}
            <Button disabled={busy || googleBusy}>
              {busy
                ? "Please wait…"
                : challenge
                  ? "Verify"
                  : forgot
                    ? "Send reset link"
                    : register
                      ? "Create account"
                      : "Sign in"}
            </Button>
          </form>
          {challenge && (
            <Button
              variant="secondary"
              onClick={() => {
                setRecoveryCode(!recoveryCode);
                setCode("");
                setError("");
              }}
            >
              {recoveryCode
                ? "Use an authenticator code"
                : "Use a recovery code"}
            </Button>
          )}
          {!challenge && !register && (
            <Button
              variant="secondary"
              onClick={() => {
                setForgot(!forgot);
                setError("");
                setNotice("");
              }}
            >
              {forgot ? "Back to sign in" : "Forgot your password?"}
            </Button>
          )}
          {!challenge && !forgot && (
            <Button
              variant="secondary"
              onClick={() => {
                setRegister(!register);
                setConfirm("");
                setError("");
                setNotice("");
              }}
            >
              {register ? "Use an existing account" : "Create an account"}
            </Button>
          )}
          {!challenge && environmentNotice && (
            <p className="muted" role="note">
              {environmentNotice}
            </p>
          )}
        </Card>
        {demoAvailable && (
          <Link href="/owner/dashboard">
            Explore the fictional browser demo
          </Link>
        )}
      </main>
    </AuthSplitShell>
  );
}
