import "server-only";
import { WorkspaceError } from "./auth";
import {
  countRateLimit,
  envLimit,
  secondsUntilWindowEnds,
  type RateLimit,
} from "./rate-counter";

export type { RateLimit };

/**
 * Fixed-window request limits shared by every server process (the counters
 * live in SQLite, not in memory), keyed by the AUTHENTICATED user. Nothing is
 * counted, and nothing is written, for a caller who is not signed in: such a
 * request is refused by authentication anyway, and a limiter keyed on anything
 * the client chooses (a cookie value, a header) could be evaded or used to
 * grow the table. This is abuse and runaway-client protection for one
 * deployment, not a substitute for edge rate limiting or DDoS mitigation.
 */
/** Every state-changing request. Generous for people, tight for scripts. */
export const WRITE_LIMIT: RateLimit = {
  name: "write",
  max: envLimit("SPORTOZEN_WRITE_LIMIT_PER_MINUTE", 240),
  windowSeconds: 60,
};
// Requests that passed the same-origin check and so change state. The route
// marks its request; the first authenticated step then applies WRITE_LIMIT to
// the person it identified. Keyed by the request's Headers object, which the
// routes pass on unchanged.
const writeRequests = new WeakSet<Headers>();
export function markWriteRequest(request: Request) {
  writeRequests.add(request.headers);
}
/** Called right after authentication with the verified user id. */
export function enforceWriteLimit(headers: Headers, userId: string) {
  if (writeRequests.has(headers)) enforceRateLimit(userId, WRITE_LIMIT);
}
/** Counts one request by this user; throws 429 once the window is used up. */
export function enforceRateLimit(
  userId: string,
  limit: RateLimit,
  now = Date.now(),
) {
  if (countRateLimit(`user:${userId}`, limit, now) > limit.max)
    throw new WorkspaceError(
      429,
      "Too many requests in a short time. Wait a moment and try again.",
      { "Retry-After": String(secondsUntilWindowEnds(limit, now)) },
    );
}
