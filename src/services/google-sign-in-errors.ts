/**
 * What the sign-in screen says when Better Auth sends the browser back with
 * `/sign-in?source=google&error=<code>`. The code comes from the address bar, so
 * it is only ever used as a key into this table: nothing from the address is
 * shown, and an unknown code gets the general message.
 */
export type GoogleErrorContext = {
  /** SPORTOZEN_EMAIL_VERIFICATION=required: signing in sends a fresh confirmation link. */
  verificationRequired: boolean;
};

const RESTART =
  "Google sign-in could not be completed. Start again from this page, or use your email and password.";

export function googleErrorMessage(
  code: string,
  { verificationRequired }: GoogleErrorContext,
): string {
  switch (code) {
    // An account for this address exists and its address is not confirmed.
    case "account_not_linked":
      return verificationRequired
        ? "An account with this email address already exists, but the address has not been confirmed yet, so Google cannot be linked to it. Sign in with your email and password: we will send you a confirmation link. Once you have confirmed it, you can use Google."
        : "An account with this email address already exists, but the address has not been confirmed, so Google cannot be linked to it. Keep signing in with your email and password. Google can be linked once the address is confirmed; email confirmation is not switched on for this deployment yet, so ask your platform administrator.";
    case "access_denied":
      return "Google sign-in was cancelled. You can try again, or use your email and password.";
    case "two_step_required":
      return "This account uses two-step verification. Sign in with your email, password and authenticator code.";
    case "email_not_verified":
      return "Google has not confirmed this email address, so it cannot be used to create or open an account. Confirm it with Google, or use another address.";
    case "email_not_found":
      return "Google did not share an email address, so we cannot sign you in with it. Use your email and password instead.";
    case "account_already_linked_to_different_user":
    case "unable_to_link_account":
    case "email_does_not_match":
      return "This Google account cannot be used with that Sportozen account. Sign in with your email and password.";
    default:
      return RESTART;
  }
}
