import "server-only";
import { atomic, database } from "./database";

/** Shared-by-all-processes fixed-window counters in SQLite (see rate-limit.ts). No dependency on authentication, so authentication itself can use them. */
export interface RateLimit {
  /** Names the protected action, for example "write" or "invitation-accept". */
  name: string;
  max: number;
  windowSeconds: number;
}
export function envLimit(variable: string, fallback: number) {
  const value = Number(process.env[variable]);
  return Number.isInteger(value) && value >= 1 && value <= 100000
    ? value
    : fallback;
}
/** Seconds until the fixed window that contains `now` ends (at least 1). */
export function secondsUntilWindowEnds(limit: RateLimit, now = Date.now()) {
  const windowMs = limit.windowSeconds * 1000;
  return Math.max(
    1,
    Math.ceil(((Math.floor(now / windowMs) + 1) * windowMs - now) / 1000),
  );
}
/** Counts one event for `subject` (for example `user:<id>`) and returns the
 * number counted so far in the current window. Never throws for being over. */
export function countRateLimit(
  subject: string,
  limit: RateLimit,
  now = Date.now(),
) {
  const windowMs = limit.windowSeconds * 1000,
    scope = `${limit.name}:${subject}`,
    bucket = String(Math.floor(now / windowMs));
  return atomic(() => {
    const db = database();
    // Expired windows are swept occasionally, not on every request (the
    // expiresAt index keeps the sweep cheap).
    if (Math.random() < 0.02)
      db.prepare("DELETE FROM request_rate_limits WHERE expiresAt < ?").run(
        now,
      );
    return Number(
      db
        .prepare(
          "INSERT INTO request_rate_limits(scope,bucket,requests,expiresAt) VALUES(?,?,1,?) ON CONFLICT(scope,bucket) DO UPDATE SET requests=requests+1 RETURNING requests",
        )
        .get(scope, bucket, now + 2 * windowMs)?.requests,
    );
  });
}
/** Events already counted for `subject` in the current window; counts nothing. */
export function rateLimitUsed(
  subject: string,
  limit: RateLimit,
  now = Date.now(),
) {
  const windowMs = limit.windowSeconds * 1000;
  return Number(
    database()
      .prepare(
        "SELECT requests FROM request_rate_limits WHERE scope=? AND bucket=? AND expiresAt>=?",
      )
      .get(`${limit.name}:${subject}`, String(Math.floor(now / windowMs)), now)
      ?.requests ?? 0,
  );
}
/** Forgets the counts for `subject` (for example after a successful sign-in). */
export function clearRateLimit(subject: string, limit: RateLimit) {
  database()
    .prepare("DELETE FROM request_rate_limits WHERE scope=?")
    .run(`${limit.name}:${subject}`);
}
