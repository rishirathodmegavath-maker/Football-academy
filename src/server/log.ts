import { redact } from "./redact";

/**
 * Structured application logging: one JSON object per line on the standard
 * streams, which systemd's journal captures and any log shipper can read. No
 * provider is assumed.
 *
 *   {"ts":"…","level":"warn","event":"db.refused","requestId":"…","status":503}
 *
 * Rules enforced here, not left to callers:
 *  - only primitive values are written (no objects, so no request bodies);
 *  - every string passes through redact(), which removes links, addresses,
 *    tokens and long numbers;
 *  - `ts`, `level` and `event` cannot be overridden by a field.
 * Security events (security-events.ts) additionally restrict the field names.
 */
export type LogLevel = "info" | "warn" | "error";
type Primitive = string | number | boolean | null | undefined;
const IDENTIFIER_KEY = /(Id|Ref|reference)$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{6,64}$/;
const ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
function minimumLevel(): LogLevel {
  const value = (process.env.SPORTOZEN_LOG_LEVEL ?? "info")
    .trim()
    .toLowerCase();
  return value === "warn" || value === "error" ? value : "info";
}
export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, Primitive> = {},
) {
  if (ORDER[level] < ORDER[minimumLevel()]) return;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      value === undefined ||
      key === "ts" ||
      key === "level" ||
      key === "event"
    )
      continue;
    // Opaque identifiers (userId, requestId, accountRef…) are meant to be
    // read back; they look like tokens, so they are kept when they have exactly
    // an identifier's shape (an address or link never does).
    if (typeof value === "string")
      safe[key] =
        IDENTIFIER_KEY.test(key) && IDENTIFIER.test(value)
          ? value
          : redact(value);
    else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      safe[key] = value;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event: redact(event, 80),
    ...safe,
  });
  // Standard streams, so the journal (or any supervisor) sees them as they are.
  if (level === "info") console.info(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}
/**
 * Quoted text is removed from error messages and stacks before redaction:
 * library errors quote the data they choke on (JSON.parse echoes the start of
 * the document, constraint and parser errors echo values). No error thrown by
 * this codebase interpolates request or record data (checked by a scan, and
 * kept so in review); an unquoted value in a third-party message would still
 * only be masked if it looks like an address, link, token or number.
 */
const withoutQuotes = (text: string) =>
  text.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "…");
/** Name, redacted message and a short redacted stack of an error. */
export function errorFields(error: unknown): Record<string, string> {
  if (!(error instanceof Error))
    return { errorName: typeof error, errorMessage: "non-error value thrown" };
  return {
    errorName: error.name,
    errorMessage: redact(withoutQuotes(error.message), 300),
    ...(error.stack
      ? {
          stack: redact(
            withoutQuotes(error.stack.split("\n").slice(0, 8).join(" | ")),
            900,
          ),
        }
      : {}),
  };
}
