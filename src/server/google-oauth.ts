import "server-only";
import { database } from "./database";

/**
 * Google sign-in, configured through Better Auth's own `socialProviders`. There
 * is no second authentication system: Better Auth runs the authorization-code
 * flow with PKCE and a signed state, and creates the same session as a password
 * sign-in. What this file adds is configuration and the rules of this
 * application (docs/GOOGLE_SIGN_IN.md).
 */

/** The only place a successful Google sign-in ends. Authorization is still
 * decided by the same checks as for a password sign-in. */
export const AFTER_GOOGLE_SIGN_IN = "/workspace";
/** Where every Google failure lands; the screen explains it (see
 * src/services/google-sign-in-errors.ts). */
export const GOOGLE_ERROR_LANDING = "/sign-in?source=google";

export type GoogleOAuthConfig = { clientId: string; clientSecret: string };

/**
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or null when neither is set.
 * Setting only one is a mistake that would otherwise show up as a failing
 * button, so it stops start-up instead.
 */
export function googleOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret)
    throw new Error(
      "Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.",
    );
  return { clientId, clientSecret };
}

/** Whether the sign-in screen should offer Google. Never throws and never
 * returns a value: only a yes or no leaves the server. */
export function googleSignInAvailable(): boolean {
  try {
    return googleOAuthConfig() !== null;
  } catch {
    return false;
  }
}

type Gate = { error: string; errorDescription: string } | undefined;
/**
 * Better Auth's `user.validateUserInfo` gate, run before it creates a user,
 * links a Google account to an existing user, or lets a linked user in again.
 * Rejecting here sends the browser back to the sign-in screen with
 * `?error=<code>`, before any account row or session exists.
 *
 *  - Google must vouch for the address (`email_verified`). Otherwise nobody can
 *    open an account with an address Google has not confirmed, and nobody is
 *    linked to one.
 *  - An account that uses two-step verification must sign in with its password
 *    and code. Better Auth's second step only follows password sign-in, so a
 *    Google sign-in would skip it.
 *
 * Linking to an existing account is decided before this runs, by
 * `account.accountLinking` (src/server/auth.ts): only when that account's own
 * address is already verified.
 */
export function googleGate({
  user,
  source,
}: {
  user: { id?: unknown; emailVerified?: unknown };
  source: { method: string; oauth?: { providerId: string } };
}): Gate {
  if (source.method !== "oauth" || source.oauth?.providerId !== "google")
    return undefined;
  if (user.emailVerified !== true)
    return {
      error: "email_not_verified",
      errorDescription: "Google has not confirmed this email address.",
    };
  if (typeof user.id === "string") {
    const row = database()
      .prepare('SELECT twoFactorEnabled FROM "user" WHERE id=?')
      .get(user.id);
    if (row && Number(row.twoFactorEnabled) === 1)
      return {
        error: "two_step_required",
        errorDescription: "This account uses two-step verification.",
      };
  }
  return undefined;
}
