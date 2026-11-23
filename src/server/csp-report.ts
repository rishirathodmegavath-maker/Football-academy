import "server-only";
import { securityEvent } from "./security-events";

/**
 * Content-Security-Policy violation reports. The browser posts them to an
 * unauthenticated endpoint, so everything here assumes hostile input: the body
 * is size-limited and shape-checked, only a few short fields are kept, query
 * strings and fragments (which can carry tokens) are dropped, and reports are
 * rate-limited per process. They are logged as security events; nothing is
 * stored.
 */
export const MAX_REPORT_BYTES = 8 * 1024;
/** Reports logged per minute by this process, and by any one source address. */
export const MAX_REPORTS_PER_MINUTE = 300;
export const MAX_REPORTS_PER_SOURCE_PER_MINUTE = 20;
const MAX_SOURCES_TRACKED = 1000;

const short = (value: unknown, max = 120) =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9._:/@'\- ]/g, "?").slice(0, max)
    : undefined;
/** Scheme + host (or a keyword such as inline or eval); never a path or query. */
function hostOf(value: unknown) {
  if (typeof value !== "string") return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return short(value, 40);
  try {
    const url = new URL(value);
    return url.origin === "null" ? short(url.protocol, 20) : short(url.origin);
  } catch {
    return "invalid";
  }
}
function pathOf(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    // A path can carry a secret (/join/<token>): any long token-like segment is replaced here, not left to the logger.
    return short(
      new URL(value).pathname
        .split("/")
        .map((segment) => (/^[A-Za-z0-9_-]{24,}$/.test(segment) ? ":token" : segment))
        .join("/"),
    );
  } catch {
    return undefined;
  }
}
/** The fields worth keeping from either report format, or undefined if it is not a report. */
export function summariseCspReport(body: unknown) {
  if (typeof body !== "object" || body === null) return undefined;
  const root = body as Record<string, unknown>;
  // Legacy report-uri: { "csp-report": {...} }. Reporting API: [{ type, body: {...} }].
  const report = (
    "csp-report" in root
      ? root["csp-report"]
      : Array.isArray(body)
        ? (body[0] as { body?: unknown } | undefined)?.body
        : undefined
  ) as Record<string, unknown> | undefined;
  if (typeof report !== "object" || report === null) return undefined;
  const directive = short(
    report["effective-directive"] ??
      report.effectiveDirective ??
      report["violated-directive"],
    40,
  );
  if (!directive) return undefined;
  return {
    directive,
    blockedHost: hostOf(report["blocked-uri"] ?? report.blockedURL),
    path: pathOf(report["document-uri"] ?? report.documentURL),
    disposition: short(report.disposition, 10),
  };
}
let windowStart = 0,
  inWindow = 0;
const perSource = new Map<string, number>();
/**
 * Whether one more VALID report may be logged now. Junk is dropped before this
 * is asked, so it cannot use up the budget; one source address (the proxy
 * overwrites X-Forwarded-For, so behind it the value is the client's) cannot
 * use more than its share, so a flood from one place does not hide the real
 * reports of everyone else.
 */
function withinBudget(source: string, now: number) {
  if (now - windowStart > 60_000) {
    windowStart = now;
    inWindow = 0;
    perSource.clear();
  }
  const key =
    perSource.has(source) || perSource.size < MAX_SOURCES_TRACKED
      ? source
      : "overflow";
  const mine = (perSource.get(key) ?? 0) + 1;
  perSource.set(key, mine);
  return (
    mine <= MAX_REPORTS_PER_SOURCE_PER_MINUTE &&
    ++inWindow <= MAX_REPORTS_PER_MINUTE
  );
}
const sourceOf = (request: Request) =>
  (request.headers.get("x-forwarded-for") ?? "direct")
    .split(",")[0]
    .trim()
    .slice(0, 64) || "direct";
/** Reads at most `max` bytes of the body; null when it is larger. */
async function boundedText(request: Request, max: number) {
  if (Number(request.headers.get("content-length")) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
/** Always answers 204: a reporter learns nothing, and a flood costs one log line per accepted report at most. */
export async function receiveCspReport(request: Request, now = Date.now()) {
  const done = new Response(null, { status: 204 });
  const text = await boundedText(request, MAX_REPORT_BYTES);
  if (!text) return done;
  let summary;
  try {
    summary = summariseCspReport(JSON.parse(text));
  } catch {
    return done; // not JSON
  }
  if (summary && withinBudget(sourceOf(request), now))
    securityEvent("csp.violation", summary);
  return done;
}
