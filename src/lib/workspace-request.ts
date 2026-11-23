import { StoreRequestError, reportRefusal } from "./academy-store";

/** How long a read may take before the screen is told to retry. Reads have no
 * side effects, so giving up on one is always safe. A write is never timed
 * out here: its outcome would be unknown to the user while the server may still
 * complete it. */
export const READ_TIMEOUT_MS = 30_000;
/** Aborts when the caller's signal does or after `ms`, and says which. */
function withTimeout(outer: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const relay = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", relay, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    },
  };
}
/** JSON request to a workspace API route. A failure throws an Error with the
 * server's message; `status` carries the HTTP status so callers (and the
 * academy store) can tell a refusal (401, 403) from other failures. */
export async function workspaceRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  /** The academy store makes its own requests and handles refusals itself. */
  { quiet = false }: { quiet?: boolean } = {},
): Promise<T> {
  const limit = method === "GET" ? withTimeout(signal, READ_TIMEOUT_MS) : null;
  let response: Response, value: T & { error?: string };
  try {
    response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: limit ? limit.signal : signal,
    });
    // A proxy or gateway can refuse with a body that is not JSON.
    value = await response.json().catch(() => ({}) as T);
    // An aborted body read is swallowed above; it must not pass as an empty answer.
    if (limit?.timedOut()) throw new Error("timed out");
  } catch (error) {
    if (limit?.timedOut())
      throw new StoreRequestError(
        "The server took too long to respond. Check your connection and try again.",
      );
    throw error;
  } finally {
    limit?.done();
  }
  // A refusal means access may have changed; the store decides what to drop.
  if (!quiet && (response.status === 401 || response.status === 403))
    reportRefusal(response.status);
  if (!response.ok)
    throw new StoreRequestError(
      value.error ?? "Request could not be completed.",
      response.status,
    );
  return value;
}
