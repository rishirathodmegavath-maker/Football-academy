import "server-only";
import { log } from "./log";

/**
 * Security-relevant events (failed and blocked sign-ins, two-step verification
 * changes, session revocations, refused access, rate-limit blocks, policy
 * violations) as one JSON line each, through the structured logger. Fields are
 * an allow-list of opaque identifiers: never an address, a name, a password, a
 * token, a code or a request body. `accountRef` is a keyed hash that lets an
 * operator see repeated attempts against one account without learning whose it
 * is; `requestId` ties the line to the proxy's access log and to any error line
 * for the same request.
 */
export type SecurityEventType =
  | "signin.failed"
  | "signin.locked"
  | "signin.google_refused"
  | "mfa.enabled"
  | "mfa.disabled"
  | "mfa.codes_regenerated"
  | "mfa.reset_by_operator"
  | "session.others_revoked"
  | "password.changed"
  | "access.mfa_required"
  | "access.denied"
  | "ratelimit.blocked"
  | "webhook.rejected"
  | "csp.violation";
type Field = string | number | boolean | undefined;
const ALLOWED = new Set([
  "userId",
  "academyId",
  "accountRef",
  "retryAfterSeconds",
  "role",
  "directive",
  "blockedHost",
  "path",
  "disposition",
  "requestId",
  "status",
  "route",
  "reason",
]);
export function securityEvent(
  type: SecurityEventType,
  fields: Record<string, Field> = {},
) {
  const safe: Record<string, Field> = {};
  for (const [key, value] of Object.entries(fields))
    if (ALLOWED.has(key) && value !== undefined) safe[key] = value;
  log("warn", "security", { type, ...safe });
}
