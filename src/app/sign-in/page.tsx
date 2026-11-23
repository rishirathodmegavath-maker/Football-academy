import { SignIn } from "@/features/workspaces/sign-in";
import { emailConfig } from "@/server/email/config";
import { googleSignInAvailable } from "@/server/google-oauth";
import { environmentNotice } from "@/services/environment-notice";
import { googleErrorMessage } from "@/services/google-sign-in-errors";

// Read the e-mail settings per request, not when the app is built.
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    verified?: string;
    error?: string;
    source?: string;
  }>;
}) {
  const { verified, error, source } = await searchParams;
  let verification = false,
    recovery = false;
  try {
    const config = emailConfig();
    verification = config.verification === "required";
    recovery = config.recovery;
  } catch {
    // A misconfiguration is reported by the authentication API itself.
  }
  // Google sends failures back as ?source=google&error=<code>. The code only
  // selects a fixed message; nothing from the address is shown.
  const googleError =
    source === "google" && error
      ? googleErrorMessage(error, { verificationRequired: verification })
      : undefined;
  return (
    <SignIn
      verificationRequired={verification}
      recoveryAvailable={recovery}
      // Only whether Google is configured; the values stay on the server.
      googleAvailable={googleSignInAvailable()}
      googleError={googleError}
      environmentNotice={environmentNotice()}
      demoAvailable={
        process.env.NODE_ENV !== "production" ||
        process.env.SPORTOZEN_GALLERY_QA === "1"
      }
      landing={
        googleError
          ? undefined
          : error
            ? "invalid-link"
            : verified
              ? "verified"
              : undefined
      }
    />
  );
}
