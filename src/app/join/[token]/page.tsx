import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/primitives";
import { SportozenSymbol } from "@/components/brand/sportozen-symbol";
import { AuthSplitShell } from "@/features/workspaces/auth-split-shell";
import { SignIn } from "@/features/workspaces/sign-in";
import { JoinSignedIn } from "@/features/workspaces/join-invitation";
import { emailConfig } from "@/server/email/config";
import { googleSignInAvailable } from "@/server/google-oauth";
import { currentSession } from "@/server/auth";
import { previewInvitation } from "@/server/membership-service";
import "@/features/workspaces/secure.css";

// The address holds a single-use secret: never indexed, never cached.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your invitation",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
const PROBLEMS = {
  INVALID:
    "This invitation link is not valid. Check that you copied the whole link, or ask the academy to send you a new one.",
  USED: "This invitation has already been used. If that was you, sign in to open your academy.",
  EXPIRED:
    "This invitation has expired. Ask the academy to send you a new link.",
  ACADEMY_NOT_OPEN:
    "This academy is not open yet. Ask the academy to send you the link again once it opens.",
} as const;

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ invitation?: string }>;
}) {
  const { token } = await params;
  // Arriving from the older /workspace?invitation= address leaves the code in
  // the query as well; keep the clean address.
  if ((await searchParams).invitation) redirect(`/join/${token}`);
  const preview = previewInvitation(token);
  if (preview.state !== "OPEN")
    return (
      <AuthSplitShell>
        <main className="secure-entry">
          <Link className="secure-wordmark" href="/">
            <SportozenSymbol />
            <span className="secure-wordmark-text">
              Sportozen <span>ACADEMY</span>
            </span>
          </Link>
          <Card>
            <p className="report-kicker">YOUR INVITATION</p>
            <h1>This link cannot be used</h1>
            <p role="alert">{PROBLEMS[preview.state]}</p>
            <Link className="text-link" href="/sign-in">
              Go to sign in
            </Link>
          </Card>
        </main>
      </AuthSplitShell>
    );
  const invite = {
    token,
    email: preview.email,
    academyName: preview.academyName,
    role: preview.role,
    playerNames: preview.playerNames,
    accountExists: preview.accountExists,
    open: preview.open,
  };
  const session = await currentSession(await headers());
  if (session)
    return <JoinSignedIn invite={invite} signedInEmail={session.user.email} />;
  let verification = false,
    recovery = false;
  try {
    const config = emailConfig();
    verification = config.verification === "required";
    recovery = config.recovery;
  } catch {
    // A misconfiguration is reported by the authentication API itself.
  }
  return (
    <SignIn
      invite={invite}
      verificationRequired={verification}
      recoveryAvailable={recovery}
      googleAvailable={googleSignInAvailable()}
    />
  );
}
