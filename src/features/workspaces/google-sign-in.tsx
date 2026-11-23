"use client";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/primitives";

/** Where Better Auth sends the browser once Google has confirmed the person.
 * Fixed here: the screen never forwards a destination taken from the address bar. */
import { markJustSignedIn } from "./just-signed-in";
const AFTER_GOOGLE = "/workspace";

/** The multi-colour "G" mark, drawn inline so the page loads nothing from Google. */
function GoogleMark() {
  return (
    <svg
      className="google-mark"
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * "Continue with Google" for sign-in and registration alike. It only starts
 * Better Auth's own social sign-in (`authClient.signIn.social`); the role and
 * the academy a person may enter never come from this screen.
 *
 * `available` is set by the server from its Google OAuth configuration. Until
 * it is, the button stays visible but disabled and says why.
 */
export function GoogleSignIn({
  available,
  registering = false,
  disabled = false,
  onPending,
  returnTo = AFTER_GOOGLE,
}: {
  available: boolean;
  /** Where Google sends the browser back to. Only the app's own invitation
   * page sets this; the address bar never does. */
  returnTo?: string;
  /** Registration mode only adds a sentence about how access is granted. */
  registering?: boolean;
  /** The e-mail form is working, so Google must wait. */
  disabled?: boolean;
  /** Lets the e-mail form wait while Google is being contacted. */
  onPending?: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  // Coming back with the browser's Back button restores this page as it was
  // left, with the button still waiting; start again from a clean state.
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setPending(false);
      onPending?.(false);
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, [onPending]);
  const fail = (message: string) => {
    setError(message);
    setPending(false);
    onPending?.(false);
  };
  const start = async () => {
    setError("");
    setPending(true);
    onPending?.(true);
    try {
      // Read once by the academy list after Google sends the browser back.
      markJustSignedIn();
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: returnTo,
      });
      if (result.error)
        fail(
          result.error.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : "Google sign-in could not be started. Try again, or use your email and password.",
        );
      // Otherwise the browser is already on its way to Google: stay in the
      // waiting state until the page is replaced.
    } catch {
      fail(
        "Google sign-in could not be started. Check your connection and try again.",
      );
    }
  };
  return (
    <div className="google-signin">
      <Button
        type="button"
        variant="secondary"
        className="google"
        disabled={!available || disabled || pending}
        aria-busy={pending}
        aria-describedby={!available ? "google-unavailable" : undefined}
        onClick={start}
      >
        {pending ? (
          <span className="google-spinner" aria-hidden="true" />
        ) : (
          <GoogleMark />
        )}
        <span>{pending ? "Opening Google…" : "Continue with Google"}</span>
      </Button>
      {!available && (
        <p className="muted" id="google-unavailable">
          Google sign-in is not switched on for this deployment yet.
        </p>
      )}
      {registering && available && (
        <p className="muted">
          Google confirms who you are. Access to an academy still comes from
          your invitation or the academy&apos;s approval.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="secure-divider" role="separator" aria-label="or">
        <span aria-hidden="true">OR</span>
      </div>
    </div>
  );
}
