import "server-only";
import { randomUUID } from "node:crypto";
import { WorkspaceError } from "./auth";
import { log, errorFields } from "./log";
import { securityEvent } from "./security-events";

/** Largest accepted JSON request body. Academy settings may carry a PNG logo
 * of up to 300,000 characters; every other request body is far smaller. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Reads the request body as JSON. Only problems with the client's own body
 * become 4xx responses here; errors raised later by services or by stored data
 * keep their original type, so apiError still reports them as internal. */
export async function readJson(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge();
  const text = await readText(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkspaceError(400, "Send the request details as valid JSON.");
  }
}
/** Reads the whole request body, refusing (413) anything over `maxBytes`. */
export async function readBytes(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function readText(request: Request, maxBytes: number) {
  // TextDecoder drops a leading byte-order mark, as Request.json() does.
  return new TextDecoder().decode(await readBytes(request, maxBytes));
}
function tooLarge() {
  return new WorkspaceError(413, "The request is too large to process.");
}

export function privateJson(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      Vary: "Cookie",
      ...headers,
    },
  });
}
/** Smallest JSON body worth compressing; below this the gzip header and
 * CPU cost outweigh the saving. */
export const MIN_COMPRESSED_JSON_BYTES = 1024;
/** Whether the client accepts gzip. An explicit gzip entry decides; otherwise
 * a wildcard does. A quality of 0 means "not acceptable". */
function acceptsGzip(request: Request) {
  const quality = new Map<string, number>();
  for (const part of (request.headers.get("accept-encoding") ?? "").split(
    ",",
  )) {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";");
    if (!coding) continue;
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    quality.set(coding.trim(), q === undefined ? 1 : Number(q.slice(2)));
  }
  return (quality.get("gzip") ?? quality.get("*") ?? 0) > 0;
}
/**
 * privateJson for GET responses that can be large. The body is gzip-compressed
 * when it is at least MIN_COMPRESSED_JSON_BYTES and the client accepts gzip.
 * Measured on Next.js 16.4.1 `next start`: HTML is gzipped by the framework but
 * route-handler JSON is not (docs/WP2_IMPLEMENTATION_REPORT.md), so this is the
 * one compression layer for API JSON. A proxy in front sees an already-encoded
 * response and leaves it alone. Status, content type and
 * cache headers are exactly those of privateJson; Vary also names
 * Accept-Encoding because the body now depends on it.
 */
export function compressibleJson(
  request: Request,
  value: unknown,
  status = 200,
) {
  const json = JSON.stringify(value),
    headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, private",
      Vary: "Cookie, Accept-Encoding",
    };
  if (
    Buffer.byteLength(json) < MIN_COMPRESSED_JSON_BYTES ||
    !acceptsGzip(request)
  )
    return new Response(json, { status, headers });
  return new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
    { status, headers: { ...headers, "Content-Encoding": "gzip" } },
  );
}
// SQLite result codes carried by node:sqlite errors (`errcode`). The low byte
// is the primary code; constraint failures keep their kind in the high bits.
const SQLITE_BUSY = 5,
  SQLITE_LOCKED = 6,
  CONSTRAINT_FOREIGNKEY = 787,
  CONSTRAINT_PRIMARYKEY = 1555,
  CONSTRAINT_UNIQUE = 2067;
/** Database failures a caller can act on. Everything else stays internal. */
function databaseRefusal(
  error: unknown,
):
  | { status: number; message: string; headers: Record<string, string> }
  | undefined {
  const code =
    error instanceof Error && "errcode" in error
      ? Number((error as { errcode: unknown }).errcode)
      : NaN;
  if (!Number.isInteger(code)) return undefined;
  // Busy and locked also come as extended codes (261, 517, ...): compare the
  // primary code, the low byte.
  if ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)
    return {
      status: 503,
      message: "The service is busy. Try again in a moment.",
      headers: { "Retry-After": "1" },
    };
  if (
    code === CONSTRAINT_UNIQUE ||
    code === CONSTRAINT_PRIMARYKEY ||
    code === CONSTRAINT_FOREIGNKEY
  )
    return {
      status: 409,
      message:
        "This conflicts with a record that already exists or was just changed. Reload and try again.",
      headers: {},
    };
  return undefined;
}
/** Maps an error to the existing `{ error }` response contract. Expected
 * refusals keep their status; invalid input is 400; a duplicate or busy
 * database is 409 / 503; anything else is logged with a reference (also sent
 * as a header) and answered with a generic 500. A NOT NULL or CHECK failure
 * is deliberately not mapped: it means the service let bad data through. */
export function apiError(error: unknown, request?: Request) {
  const requestId = request?.headers.get("x-request-id") ?? undefined,
    route = request
      ? `${request.method} ${new URL(request.url).pathname}`
      : undefined;
  if (error instanceof WorkspaceError) {
    // Refusals worth seeing in a security review; ordinary 401s and 4xx
    // validation answers are normal application behaviour and are not logged.
    if (error.status === 403)
      securityEvent("access.denied", { requestId, route, status: 403 });
    else if (error.status === 429)
      securityEvent("ratelimit.blocked", { requestId, route, status: 429 });
    return privateJson(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      error.status,
      error.headers,
    );
  }
  if (error instanceof Error && error.name === "ZodError")
    return privateJson(
      { error: "Check the required fields and valid record links." },
      400,
    );
  const refusal = databaseRefusal(error);
  if (refusal) {
    // Mapped, but still traceable: a bug that surfaces as a UNIQUE failure
    // must leave a record on the server.
    log("warn", "db.refused", {
      requestId,
      route,
      status: refusal.status,
      ...errorFields(error),
    });
    return privateJson(
      { error: refusal.message },
      refusal.status,
      refusal.headers,
    );
  }
  const reference = randomUUID().slice(0, 8);
  // The reference is also returned to the caller (X-Error-Reference); with the
  // request id it finds this line, the proxy's access-log entry and any
  // security event for the same request.
  log("error", "request.failed", {
    reference,
    requestId,
    route,
    ...errorFields(error),
  });
  return privateJson({ error: "The request could not be completed." }, 500, {
    "X-Error-Reference": reference,
  });
}
