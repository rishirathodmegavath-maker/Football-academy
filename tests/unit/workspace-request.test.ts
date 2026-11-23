// Phase 5: a read that never answers must end in an error the screen can show
// (with its retry), not leave the page on "Loading..." for as long as the
// browser's own, much longer, network timeout. Writes are never timed out here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_TIMEOUT_MS, workspaceRequest } from "@/lib/workspace-request";
import { StoreRequestError } from "@/lib/academy-store";

/** A fetch that never answers on its own and honours its abort signal. */
function stalledFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        // Like the real fetch: an already-aborted signal rejects at once.
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort);
      }),
  );
}
const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspaceRequest timeouts", () => {
  it("ends a read that never answers with a clear, retryable error", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    const result = workspaceRequest("/api/x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    const error = await result;
    expect(error).toBeInstanceOf(StoreRequestError);
    expect((error as Error).message).toMatch(/took too long to respond/);
    // No timer is left running afterwards.
    expect(vi.getTimerCount()).toBe(0);
  });
  it("also covers a response whose body stalls after the headers arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            const stalled = {
              ok: true,
              status: 200,
              json: () =>
                new Promise((_r, reject) =>
                  init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("aborted", "AbortError")),
                  ),
                ),
            } as unknown as Response;
            resolve(stalled);
          }),
      ),
    );
    // json() rejects on abort; the request must end as a timeout, never as an
    // empty successful answer.
    const result = workspaceRequest("/api/x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    const error = await result;
    expect(error).toBeInstanceOf(StoreRequestError);
    expect((error as Error).message).toMatch(/took too long to respond/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves a quick read alone and clears its timer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, { ok: 1 })),
    );
    await expect(workspaceRequest("/api/x")).resolves.toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("passes the caller's own abort through unchanged, and never reports it as a timeout", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    const controller = new AbortController();
    const result = workspaceRequest(
      "/api/x",
      "GET",
      undefined,
      controller.signal,
    ).catch((e: unknown) => e);
    controller.abort();
    const error = (await result) as Error;
    expect(error.name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
    // Already aborted before the call.
    const early = new AbortController();
    early.abort();
    const again = (await workspaceRequest(
      "/api/x",
      "GET",
      undefined,
      early.signal,
    ).catch((e: unknown) => e)) as Error;
    expect(again.name).toBe("AbortError");
  });
  it("never times out a write: its outcome must not become unknown to the user", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    let settled = false;
    const result = workspaceRequest("/api/x", "POST", { a: 1 }).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(10 * READ_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    finish(answer(200, { saved: true }));
    await expect(result).resolves.toEqual({ saved: true });
  });
  it("still reports server refusals with the server's message and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(409, { error: "Changed." })),
    );
    const error = (await workspaceRequest(
      "/api/x",
      "GET",
      undefined,
      undefined,
      {
        quiet: true,
      },
    ).catch((e: unknown) => e)) as StoreRequestError;
    expect(error.message).toBe("Changed.");
    expect(error.status).toBe(409);
  });
});
