// WP2.5: the academy-scoped store. These tests pin its guarantees: it never
// serves another academy's data, never outlives a 401/403, deduplicates
// requests, expires entries, and refetches exactly what a save invalidated.
import { describe, expect, it, vi } from "vitest";
import {
  AcademyStore,
  StoreRequestError,
  academyStore,
  clearAcademyStore,
  type Fetcher,
} from "@/lib/academy-store";

function harness(
  options: { maxAgeMs?: number; onDenied?: (s: number) => void } = {},
) {
  let clock = 1_000;
  const calls: string[] = [];
  const pending: {
    url: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    signal: AbortSignal;
  }[] = [];
  const fetcher: Fetcher = (url, signal) =>
    new Promise((resolve, reject) => {
      calls.push(url);
      pending.push({ url, resolve, reject, signal });
    });
  const store = new AcademyStore("academy-1", fetcher, {
    ...options,
    now: () => clock,
  });
  return {
    store,
    calls,
    pending,
    tick: (ms: number) => (clock += ms),
    answer: (value: unknown, index = pending.length - 1) =>
      pending[index].resolve(value),
    fail: (error: unknown, index = pending.length - 1) =>
      pending[index].reject(error),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loading", () => {
  it("shares one request between concurrent loads of a key", async () => {
    const h = harness();
    const a = h.store.load("k", "/a", ["t"]),
      b = h.store.load("k", "/a", ["t"]);
    expect(h.calls).toEqual(["/a"]);
    h.answer({ n: 1 });
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 1 });
    expect(h.store.state("k")).toEqual({ status: "ready", data: { n: 1 } });
  });
  it("reuses a fresh value and fetches again once it expires", async () => {
    const h = harness({ maxAgeMs: 10_000 });
    const first = h.store.load("k", "/a", ["t"]);
    h.answer("one");
    await first;
    h.tick(9_999);
    expect(await h.store.load("k", "/a", ["t"])).toBe("one");
    expect(h.calls).toHaveLength(1);
    h.tick(2);
    const again = h.store.load("k", "/a", ["t"]);
    expect(h.calls).toHaveLength(2);
    h.answer("two");
    expect(await again).toBe("two");
  });
  it("force always fetches", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", []);
    h.answer(1);
    await first;
    void h.store.load("k", "/a", [], { force: true });
    expect(h.calls).toHaveLength(2);
  });
  it("keeps keys separate", async () => {
    const h = harness();
    void h.store.load("one", "/one", []);
    void h.store.load("two", "/two", []);
    expect(h.calls).toEqual(["/one", "/two"]);
    h.answer("A", 0);
    await flush();
    expect(h.store.state("one").data).toBe("A");
    expect(h.store.state("two").data).toBeUndefined();
  });
  it("notifies subscribers when an entry changes", async () => {
    const h = harness();
    const listener = vi.fn();
    const stop = h.store.subscribe(listener);
    const loading = h.store.load("k", "/a", []);
    h.answer(1);
    await loading;
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
    const seen = listener.mock.calls.length;
    h.store.clear();
    expect(listener.mock.calls.length).toBe(seen);
  });
});

describe("invalidation", () => {
  it("makes tagged entries stale and refetches only those on screen", async () => {
    const h = harness();
    for (const [key, tag] of [
      ["home", "home"],
      ["fin", "finance"],
      ["ws", "workspace"],
    ]) {
      const p = h.store.load(key, `/${key}`, [tag]);
      h.answer(`${key}-1`);
      await p;
    }
    h.store.retain("home");
    h.store.retain("fin");
    h.calls.length = 0;
    const done = h.store.invalidate("home", "workspace");
    expect(h.calls).toEqual(["/home"]); // on screen and tagged; "ws" is not on screen
    h.answer("home-2");
    await done;
    expect(h.store.state("home").data).toBe("home-2");
    // The off-screen tagged entry refetches the next time it is asked for.
    void h.store.load("ws", "/ws", ["workspace"]);
    expect(h.calls).toEqual(["/home", "/ws"]);
    // The untagged entry is still fresh.
    expect(await h.store.load("fin", "/fin", ["finance"])).toBe("fin-1");
    expect(h.calls).toHaveLength(2);
  });
  it("does not trust a response that began before the invalidation", async () => {
    const h = harness();
    h.store.retain("k"); // no entry yet: no-op
    const first = h.store.load("k", "/a", ["t"]);
    const release = h.store.retain("k");
    const done = h.store.invalidate("t");
    expect(h.calls).toHaveLength(2); // the forced refetch started at once
    h.answer("old", 0); // the older request answers first
    h.answer("new", 1);
    await done;
    // The older request was replaced: its caller gets the replacement's data.
    expect(await first).toBe("new");
    expect(h.store.state("k").data).toBe("new");
    release();
  });
  it("refetches an entry that was invalidated while its request ran", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", ["t"]);
    h.store.retain("k");
    // Invalidate by tag without waiting: marks the version outdated.
    const invalidated = h.store.invalidate("t");
    h.answer("stale-answer", 0);
    h.answer("fresh-answer", h.pending.length - 1);
    await first.catch(() => {});
    await invalidated;
    expect(h.store.state("k").data).toBe("fresh-answer");
  });
  it("applies a targeted update to a loaded entry", async () => {
    const h = harness();
    const p = h.store.load("list", "/l", []);
    h.answer([1, 2]);
    await p;
    h.store.update<number[]>("list", (rows) => [...rows, 3]);
    expect(h.store.state("list").data).toEqual([1, 2, 3]);
    h.store.update("missing", () => 0); // no entry: ignored
  });
});

describe("out-of-date data", () => {
  it("is not handed to a component that is not yet showing it", async () => {
    const h = harness({ maxAgeMs: 10_000 });
    const first = h.store.load("k", "/a", ["t"]);
    h.answer("v1");
    await first;
    expect(h.store.state("k").data).toBe("v1");
    // Invalidated: a newly mounting component sees loading, never "v1".
    void h.store.invalidate("t");
    expect(h.store.state("k")).toEqual({ status: "loading" });
    expect(h.store.state("k")).toBe(h.store.state("k")); // stable snapshot
    // Age is treated the same way.
    const fresh = h.store.load("k", "/a", ["t"], { force: true });
    h.answer("v2");
    await fresh;
    expect(h.store.state("k").data).toBe("v2");
    h.tick(10_001);
    expect(h.store.state("k")).toEqual({ status: "loading" });
  });
  it("is not revealed by retaining the entry while its refresh is still running", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", ["t"]);
    h.answer("v1");
    await first;
    void h.store.invalidate("t");
    // A component mounts: it loads, then retains, in the same effect.
    void h.store.load("k", "/a", ["t"]);
    h.store.retain("k");
    expect(h.store.state("k")).toEqual({ status: "loading" });
    h.answer("v2");
    await flush();
    expect(h.store.state("k").data).toBe("v2");
  });
  it("stays visible to a component that is already on screen while it refreshes", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", ["t"]);
    h.answer("v1");
    await first;
    h.store.retain("k");
    const done = h.store.invalidate("t");
    expect(h.store.state("k")).toMatchObject({ status: "loading", data: "v1" });
    h.answer("v2");
    await done;
    expect(h.store.state("k").data).toBe("v2");
  });
  it("hides data of an entry whose refresh failed from a new component", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", []);
    h.answer("v1");
    await first;
    const again = h.store.load("k", "/a", [], { force: true });
    const rejected = expect(again).rejects.toThrow("boom");
    h.fail(new StoreRequestError("boom", 500));
    await rejected;
    expect(h.store.state("k")).toEqual({ status: "error", error: "boom" });
  });
});

describe("authorisation", () => {
  it.each([401, 403])("empties the whole store on a %i", async (status) => {
    const onDenied = vi.fn();
    const h = harness({ onDenied });
    const a = h.store.load("a", "/a", []);
    h.answer("secret");
    await a;
    const b = h.store.load("b", "/b", []);
    const rejected = expect(b).rejects.toBeInstanceOf(StoreRequestError);
    h.fail(new StoreRequestError("Not allowed", status));
    await rejected;
    expect(onDenied).toHaveBeenCalledWith(status);
    expect(h.store.state("a")).toEqual({ status: "idle" });
    // The refused entry keeps only the refusal, so its screen can say why.
    expect(h.store.state("b")).toEqual({
      status: "error",
      error: "Not allowed",
    });
    // The next request for "a" goes to the server again.
    void h.store.load("a", "/a", []);
    expect(h.calls.filter((c) => c === "/a")).toHaveLength(2);
  });
  it("keeps what a shown component had, marked as an error, on other failures", async () => {
    const h = harness();
    const a = h.store.load("a", "/a", []);
    h.answer("kept");
    await a;
    h.store.retain("a");
    const again = h.store.load("a", "/a", [], { force: true });
    const rejected = expect(again).rejects.toThrow("boom");
    h.fail(new StoreRequestError("boom", 500));
    await rejected;
    expect(h.store.state("a")).toEqual({
      status: "error",
      data: "kept",
      error: "boom",
    });
    // An errored entry is never treated as fresh.
    void h.store.load("a", "/a", []);
    expect(h.calls).toHaveLength(3);
  });
  it("abandons responses that arrive after the store was cleared", async () => {
    const h = harness();
    const p = h.store.load("a", "/a", []);
    const settled = p.catch(() => "aborted");
    h.store.clear();
    expect(h.pending[0].signal.aborted).toBe(true);
    h.answer("late");
    await settled;
    expect(h.store.state("a")).toEqual({ status: "idle" });
  });
});

describe("seeding", () => {
  it("serves data the page already holds without a request, once", async () => {
    const h = harness();
    h.store.seed("boot", "/boot", ["bootstrap"], { who: "viewer" });
    expect(h.store.state("boot")).toEqual({
      status: "ready",
      data: { who: "viewer" },
    });
    expect(await h.store.load("boot", "/boot", ["bootstrap"])).toEqual({
      who: "viewer",
    });
    expect(h.calls).toEqual([]);
    // A second seed never replaces what the store has.
    h.store.seed("boot", "/boot", ["bootstrap"], { who: "someone else" });
    expect(h.store.state("boot").data).toEqual({ who: "viewer" });
  });
  it("is treated like fetched data: it expires, is invalidated and is dropped on a refusal", async () => {
    const h = harness({ maxAgeMs: 5_000 });
    h.store.seed("boot", "/boot", ["bootstrap"], "seeded");
    h.tick(5_001);
    void h.store.load("boot", "/boot", ["bootstrap"]);
    expect(h.calls).toEqual(["/boot"]); // expired: asked again
    h.store.clear();
    h.store.seed("again", "/again", ["bootstrap"], "x");
    await h.store.invalidate("bootstrap");
    void h.store.load("again", "/again", ["bootstrap"]);
    expect(h.calls).toEqual(["/boot", "/again"]); // invalidated: asked again
  });
});

describe("sensitive data", () => {
  it("is fetched again each time a screen opens it, but shared while it is shown", async () => {
    const h = harness();
    const first = h.store.load("fin", "/fin", ["finance"], { sensitive: true });
    h.answer("v1");
    await first;
    const release = h.store.retain("fin");
    // A second component showing it right now shares what is on screen.
    expect(
      await h.store.load("fin", "/fin", ["finance"], { sensitive: true }),
    ).toBe("v1");
    expect(h.calls).toHaveLength(1);
    release();
    // Reopened later: not served from memory, and not even shown while loading.
    expect(h.store.state("fin")).toEqual({ status: "loading" });
    const reopened = h.store.load("fin", "/fin", ["finance"], {
      sensitive: true,
    });
    expect(h.calls).toHaveLength(2);
    h.store.retain("fin");
    expect(h.store.state("fin")).toEqual({ status: "loading" });
    h.answer("v2");
    await reopened;
    expect(h.store.state("fin").data).toBe("v2");
  });
  it("ordinary data keeps being reused when reopened within its age", async () => {
    const h = harness();
    const first = h.store.load("list", "/l", ["w"]);
    h.answer("v1");
    await first;
    h.store.retain("list")();
    expect(await h.store.load("list", "/l", ["w"])).toBe("v1");
    expect(h.calls).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("fetches what is on screen again once, so a refused action does not blank other screens", async () => {
    const h = harness();
    for (const key of ["a", "b", "c"]) {
      const p = h.store.load(key, "/" + key, ["t"]);
      h.answer(key + "-1");
      await p;
    }
    h.store.retain("a");
    h.store.retain("b"); // "c" is not on screen
    h.calls.length = 0;
    h.store.refusedByServer(403); // e.g. a save was refused by a role limit
    // Everything was dropped at once; the screens on screen are asked again.
    expect(h.store.state("c")).toEqual({ status: "idle" });
    expect(h.calls.sort()).toEqual(["/a", "/b"]);
    for (const request of h.pending.slice(-2))
      request.resolve(request.url.slice(1) + "-2");
    await flush();
    expect(h.store.state("a").data).toBe("a-2");
    expect(h.store.state("b").data).toBe("b-2");
    expect(h.calls).toHaveLength(2); // no second round
  });
  it("shows the refusal on every screen, and does not loop, when access really ended", async () => {
    const onDenied = vi.fn();
    const h = harness({ onDenied });
    for (const key of ["a", "b"]) {
      const p = h.store.load(key, "/" + key, ["t"]);
      h.answer(key + "-1");
      await p;
      h.store.retain(key);
    }
    h.calls.length = 0;
    const refused = h.store.load("a", "/a", [], { force: true });
    const settled = refused.catch(() => "refused");
    h.fail(new StoreRequestError("No active membership.", 403));
    await settled;
    // "b" is on screen: asked again, and refused as well.
    expect(h.calls).toEqual(["/a", "/b"]);
    const second = h.pending[h.pending.length - 1];
    second.reject(new StoreRequestError("No active membership.", 403));
    await flush();
    expect(h.store.state("a")).toEqual({
      status: "error",
      error: "No active membership.",
    });
    expect(h.store.state("b")).toEqual({
      status: "error",
      error: "No active membership.",
    });
    expect(h.calls).toHaveLength(2);
    expect(onDenied).toHaveBeenCalled();
  });
  it("remembers which screens are showing an entry across a refusal", async () => {
    const h = harness();
    const p = h.store.load("a", "/a", ["t"]);
    h.answer("1");
    await p;
    const release = h.store.retain("a");
    h.store.refusedByServer(401);
    h.answer("2");
    await flush();
    // Still on screen after the refusal: an invalidation refetches it.
    h.calls.length = 0;
    const done = h.store.invalidate("t");
    expect(h.calls).toEqual(["/a"]);
    h.answer("3");
    await done;
    release();
    expect(h.store.state("a").data).toBe("3");
  });
});

describe("overlapping loads", () => {
  it("gives the caller of a replaced load the replacement's result", async () => {
    const h = harness();
    const first = h.store.load("k", "/a", ["t"], { force: true });
    const second = h.store.load("k", "/a", ["t"], { force: true });
    // The first request was abandoned (the fetcher rejects on abort).
    h.fail(new DOMException("aborted", "AbortError"), 0);
    h.answer("fresh", 1);
    expect(await second).toBe("fresh");
    expect(await first).toBe("fresh");
    expect(h.store.state("k").data).toBe("fresh");
  });
});

describe("a 403 that is not ended access", () => {
  async function ready(h: ReturnType<typeof harness>, keys: string[]) {
    for (const key of keys) {
      const p = h.store.load(key, "/" + key, ["t"]);
      h.answer(key + "-1");
      await p;
      h.store.retain(key);
    }
    h.calls.length = 0;
  }
  it("keeps the other screens, and checks the bootstrap once", async () => {
    const h = harness();
    await ready(h, ["bootstrap", "a", "b"]);
    const refused = h.store.load("a", "/a", [], { force: true });
    const settled = refused.catch(() => "refused");
    h.fail(new StoreRequestError("Assign yourself to the session.", 403));
    await settled;
    // Only the bootstrap is asked; nothing was emptied.
    expect(h.calls).toEqual(["/a", "/bootstrap"]);
    expect(h.store.state("b").data).toBe("b-1");
    expect(h.store.state("bootstrap").data).toBe("bootstrap-1");
    expect(h.store.state("a")).toEqual({
      status: "error",
      error: "Assign yourself to the session.",
    });
    h.answer("bootstrap-2");
    await flush();
    expect(h.store.state("b").data).toBe("b-1");
    expect(h.store.state("bootstrap").data).toBe("bootstrap-2");
    expect(h.calls).toHaveLength(2);
  });
  it("treats a refused save (no entry) the same way", async () => {
    const onDenied = vi.fn();
    const h = harness({ onDenied });
    await ready(h, ["bootstrap", "a"]);
    h.store.refusedByServer(403);
    expect(h.calls).toEqual(["/bootstrap"]);
    h.answer("bootstrap-2");
    await flush();
    expect(h.store.state("a").data).toBe("a-1");
    expect(onDenied).not.toHaveBeenCalled();
  });
  it("empties the store when the bootstrap is refused too", async () => {
    const onDenied = vi.fn();
    const h = harness({ onDenied });
    await ready(h, ["bootstrap", "a"]);
    h.store.refusedByServer(403);
    h.fail(new StoreRequestError("No active membership.", 403));
    await flush();
    expect(onDenied).toHaveBeenCalledWith(403);
    expect(h.store.state("bootstrap")).toEqual({
      status: "error",
      error: "No active membership.",
    });
    // "a" is on screen, so it was asked again, once.
    expect(h.calls.filter((c) => c === "/a")).toHaveLength(1);
  });
  it("does not ask again every time a screen mounts the refused entry", async () => {
    const h = harness({ maxAgeMs: 10_000 });
    await ready(h, ["bootstrap"]);
    const first = h.store.load("comm", "/comm", []);
    const settled = first.catch(() => "refused");
    h.fail(new StoreRequestError("Not enabled.", 403));
    await settled;
    h.answer("bootstrap-2");
    await flush();
    h.calls.length = 0;
    // The screen unmounts and mounts again: no new request, same refusal.
    await expect(h.store.load("comm", "/comm", [])).rejects.toThrow(
      "Not enabled.",
    );
    expect(h.calls).toEqual([]);
    // After it ages out, or on a forced load, the server is asked again.
    h.tick(10_001);
    void h.store.load("comm", "/comm", []).catch(() => {});
    expect(h.calls).toEqual(["/comm"]);
  });
});

describe("academy scope", () => {
  it("never shares data between academies", async () => {
    const make = (id: string) => () =>
      new AcademyStore(id, async (url) => `${id}:${url}`);
    const first = academyStore("A", make("A"));
    await first.load("k", "/x", []);
    expect(first.state("k").data).toBe("A:/x");
    expect(academyStore("A", make("A"))).toBe(first);
    const second = academyStore("B", make("B"));
    expect(second).not.toBe(first);
    expect(second.state("k")).toEqual({ status: "idle" });
    // The first academy's store was emptied when the second was requested.
    expect(first.state("k")).toEqual({ status: "idle" });
    await second.load("k", "/x", []);
    expect(second.state("k").data).toBe("B:/x");
    clearAcademyStore();
    expect(second.state("k")).toEqual({ status: "idle" });
    expect(academyStore("B", make("B"))).not.toBe(second);
    clearAcademyStore();
  });
});
