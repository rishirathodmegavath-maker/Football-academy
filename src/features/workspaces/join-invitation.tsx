"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card } from "@/components/ui/primitives";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";
import { authClient } from "@/lib/auth-client";
import { workspaceRequest } from "@/hooks/use-workspace";
import { AuthSplitShell } from "./auth-split-shell";
import { invitationRoleWords } from "./role-labels";
import { markJustSignedIn } from "./just-signed-in";
import type { InviteContext } from "./sign-in";
import "./secure.css";

/**
 * The invitation page for someone who is already signed in (for example,
 * returning from Google). If the signed-in address is the invited one, one
 * press of "Join the academy" accepts it (with an optional WhatsApp number)
 * and the person lands inside; otherwise they are told which address the
 * invitation is for.
 */
export function JoinSignedIn({
  invite,
  signedInEmail,
}: {
  invite: InviteContext;
  signedInEmail: string;
}) {
  const router = useRouter(),
    [phone, setPhone] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    // A player link is not tied to an address: whoever is signed in may use it, once.
    matches =
      invite.open || signedInEmail.toLowerCase() === invite.email.toLowerCase();
  const accept = async () => {
    setError("");
    setBusy(true);
    try {
      const joined = await workspaceRequest<{ academyId: string }>(
        "/api/invitations/accept",
        "POST",
        { token: invite.token, ...(phone.trim() ? { phone: phone.trim() } : {}) },
      );
      markJustSignedIn();
      router.replace(`/workspace/${joined.academyId}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The invitation could not be accepted. Please retry.",
      );
      setBusy(false);
    }
  };
  return (
    <AuthSplitShell
      story={{
        eyebrow: "YOU ARE INVITED",
        title: <>Join {invite.academyName}</>,
        lead: "You are signed in. Joining takes you straight to your academy.",
      }}
    >
      <main className="secure-entry">
        <Link className="secure-wordmark" href="/">
          <SportozenSymbol />
          <span className="secure-wordmark-text">
            Sportozen <span>ACADEMY</span>
          </span>
        </Link>
        <Card>
          <p className="report-kicker">YOUR INVITATION</p>
          <h1>Join {invite.academyName}</h1>
          <p>
            You are invited as {invitationRoleWords[invite.role] ?? "a member"}
            {invite.playerNames.length
              ? ` for ${invite.playerNames.join(", ")}`
              : ""}
            .
          </p>
          {matches ? (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void accept();
              }}
            >
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
              {busy && <p role="status">Joining your academy…</p>}
              {error && <p role="alert">{error}</p>}
              <Button disabled={busy}>{error ? "Try again" : "Join the academy"}</Button>
              <Link className="text-link" href="/workspace">
                Go to my academies
              </Link>
            </form>
          ) : (
            <>
              <p role="alert">
                You are signed in as {signedInEmail}, but this invitation is for{" "}
                {invite.email}. Sign out, then open the link again with the
                invited address.
              </p>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await authClient.signOut();
                  router.refresh();
                  setBusy(false);
                }}
              >
                Sign out
              </Button>
            </>
          )}
        </Card>
      </main>
    </AuthSplitShell>
  );
}
