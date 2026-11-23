import "server-only";
import { createHmac } from "node:crypto";
import {
  clearRateLimit,
  countRateLimit,
  envLimit,
  secondsUntilWindowEnds,
  type RateLimit,
} from "./rate-counter";

/**
 * Per-account protection against password guessing. Better Auth already limits
 * sign-in attempts per client address; that does not stop a guesser who uses
 * many addresses against one account. Attempts are therefore also counted per
 * account (fixed 15-minute windows, so up to twice the limit can fall around a
 * window boundary), and once the limit is reached further attempts are
 * refused for the rest of the window, with the same answer whether or not the
 * account exists. The counter is keyed by a keyed hash of the address, so
 * nothing in `request_rate_limits` reveals an address.
 *
 * Trade-off, accepted and documented (docs/AUTHENTICATION.md): someone who
 * knows an address can keep its owner from signing in for one window at a
 * time. Recovery by e-mailed link is not blocked by this counter.
 */
export const SIGN_IN_FAILURES: RateLimit = {
  name: "signin-failure",
  max: envLimit("SPORTOZEN_SIGNIN_FAILURE_LIMIT", 10),
  windowSeconds: 900,
};
const normalised = (email: string) => email.trim().toLowerCase();
// Separate keyed hashes for the counter and for log references, so one value
// cannot be derived from the other.
const keyed = (purpose: string, email: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`${purpose}\0${normalised(email)}`)
    .digest("hex");
const subject = (email: string, secret: string) =>
  `account:${keyed("signin-failure", email, secret)}`;
/** A short, non-reversible reference to an account for logs. */
export const accountRef = (email: string, secret: string) =>
  keyed("log-reference", email, secret).slice(0, 16);
/**
 * Counts this sign-in attempt BEFORE the password is checked (so a burst of
 * parallel guesses cannot all slip past a check that only sees earlier
 * failures) and says whether the account is paused. A successful sign-in
 * clears the count. `first` is true only for the first refused attempt of a
 * window, so a flood of refused attempts logs one line.
 */
export function countSignInAttempt(email: string, secret: string) {
  const used = countRateLimit(subject(email, secret), SIGN_IN_FAILURES);
  return used > SIGN_IN_FAILURES.max
    ? {
        retryAfterSeconds: secondsUntilWindowEnds(SIGN_IN_FAILURES),
        first: used === SIGN_IN_FAILURES.max + 1,
      }
    : null;
}
export function clearSignInFailures(email: string, secret: string) {
  clearRateLimit(subject(email, secret), SIGN_IN_FAILURES);
}

/**
 * Session lifetime. `SPORTOZEN_SESSION_MAX_HOURS` is the absolute limit (8 by
 * default, as before). `SPORTOZEN_SESSION_IDLE_MINUTES`, when set, also ends a
 * session after that long without a request; it is unset by default so existing
 * users see no change until the owner approves a value.
 */
export function sessionPolicy(
  env: Record<string, string | undefined> = process.env,
) {
  const number = (
    name: string,
    min: number,
    max: number,
    fallback?: number,
  ) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    return value;
  };
  // "Stay signed in until I sign out": an explicit operator choice. The session
  // then lasts a year and renews while it is used; signing out always ends it.
  // Without it the stricter limits below apply.
  if (env.SPORTOZEN_SESSION_PERSISTENT?.trim() === "1") {
    const year = 365 * 24 * 3600;
    return { absoluteSeconds: year, expiresIn: year, updateAge: undefined };
  }
  const maxHours = number("SPORTOZEN_SESSION_MAX_HOURS", 1, 72, 8)!,
    idleMinutes = number("SPORTOZEN_SESSION_IDLE_MINUTES", 5, maxHours * 60);
  const absoluteSeconds = maxHours * 3600;
  return idleMinutes === undefined
    ? { absoluteSeconds, expiresIn: absoluteSeconds, updateAge: undefined }
    : {
        absoluteSeconds,
        expiresIn: idleMinutes * 60,
        // Renew at most every quarter of the idle window (1 to 5 minutes).
        updateAge: Math.min(300, Math.max(60, Math.floor(idleMinutes * 15))),
      };
}
/** True when the session is older than the absolute limit. */
export function pastAbsoluteLimit(
  createdAt: Date | string,
  now = Date.now(),
  policy = sessionPolicy(),
) {
  return now - new Date(createdAt).getTime() > policy.absoluteSeconds * 1000;
}
