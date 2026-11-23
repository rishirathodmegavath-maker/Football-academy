/**
 * A small in-memory store for the data one signed-in user is looking at in one
 * academy. It exists to avoid duplicate requests and to refresh only what a
 * save changed. It is NOT a source of authority:
 *
 * - It holds nothing between page loads and nothing for another academy: a
 *   store belongs to one academy, and asking for another academy's store
 *   discards the previous one first.
 * - It never remembers an authorisation decision. A cached value may be shown
 *   while a request is in flight or for a short time afterwards, but every
 *   fetch is a normal authorised API request; a 401, or a 403 that the
 *   bootstrap confirms as ended access, empties the whole store.
 * - Entries expire (`maxAgeMs`) and are invalidated by tag after saves; an
 *   invalidated entry that is still on screen is refetched, never kept.
 */

export class StoreRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StoreRequestError";
  }
}

export type Fetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

export interface EntryState<T = unknown> {
  status: "idle" | "loading" | "ready" | "error";
  data?: T;
  error?: string;
}

interface Entry {
  url: string;
  tags: Set<string>;
  state: EntryState;
  fetchedAt: number;
  /** Set by invalidate, an outdated response or an error: never reused. */
  stale: boolean;
  /** Bumped by invalidate and clear; a response for an older version is not
   * trusted as current. */
  version: number;
  inflight?: Promise<unknown>;
  abort?: AbortController;
  /** Sensitive data (money, contacts, private notes) is fetched again every
   * time a screen opens it, never served from memory to a new screen. */
  sensitive: boolean;
  /** When the server last refused this entry's request (403). Until it ages
   * out, a screen mounting the entry sees the refusal instead of asking again
   * and again; a forced load, an invalidation or a success clears it. */
  refusedAt?: number;
}

export interface StoreOptions {
  /** Longest a fetched value is reused without a new request. */
  maxAgeMs?: number;
  /** Called after a 401 or 403 emptied the store. */
  onDenied?: (status: number) => void;
  now?: () => number;
}

export class AcademyStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshots = new Map<string, EntryState>();
  private hidden = new WeakMap<EntryState, EntryState>();
  private generation = 0;
  /** Components currently showing each key. Kept apart from the entries so a
   * refusal that empties the entries does not forget who is on screen. */
  private shown = new Map<string, number>();
  private recovering = false;
  private probing = false;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    readonly academyId: string,
    private readonly fetcher: Fetcher,
    private readonly options: StoreOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  private entry(key: string, url: string, tags: string[]) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        url,
        tags: new Set(tags),
        state: { status: "idle" },
        fetchedAt: 0,
        stale: true,
        version: 0,
        sensitive: false,
      };
      this.entries.set(key, entry);
    }
    entry.url = url;
    for (const tag of tags) entry.tags.add(tag);
    return entry;
  }
  private shownCount(key: string) {
    return this.shown.get(key) ?? 0;
  }
  private publish(key: string, entry: Entry, state: EntryState) {
    entry.state = state;
    this.snapshots.set(key, state);
    this.notify();
  }

  /**
   * Current state of an entry; a stable object until it changes. Data the
   * store already knows is out of date (invalidated, failed to refresh or past
   * its age) is not handed to a component that is not yet showing it: that
   * component sees a loading entry, so it never acts on a record a save or
   * another user has since changed. A component already on screen keeps its
   * data while the refetch runs, as a reload always did.
   */
  state<T>(key: string): EntryState<T> {
    const entry = this.entries.get(key),
      raw = this.snapshots.get(key) as EntryState<T> | undefined;
    if (!entry || !raw) return IDLE as EntryState<T>;
    const shown = this.shownCount(key) > 0;
    const outdated =
      entry.stale ||
      (entry.sensitive && !shown) ||
      (raw.status === "ready" && this.now() - entry.fetchedAt >= this.maxAgeMs);
    if (!outdated || shown || raw.data === undefined) return raw;
    let hidden = this.hidden.get(raw);
    if (!hidden) {
      hidden = {
        status: raw.status === "error" ? "error" : "loading",
        error: raw.error,
      };
      this.hidden.set(raw, hidden);
    }
    return hidden as EntryState<T>;
  }

  private fresh(key: string, entry: Entry) {
    return (
      entry.state.status === "ready" &&
      !entry.stale &&
      !(entry.sensitive && this.shownCount(key) === 0) &&
      this.now() - entry.fetchedAt < this.maxAgeMs
    );
  }

  /**
   * The value for `key`: from memory when it is fresh, otherwise fetched. A
   * request already in flight for the key is shared. `force` always fetches.
   */
  load<T>(
    key: string,
    url: string,
    tags: string[],
    { force = false, sensitive = false } = {},
  ): Promise<T> {
    const entry = this.entry(key, url, tags);
    if (sensitive) entry.sensitive = true;
    if (
      !force &&
      entry.refusedAt !== undefined &&
      this.now() - entry.refusedAt < this.maxAgeMs
    )
      return Promise.reject(
        new StoreRequestError(entry.state.error ?? "Not allowed.", 403),
      );
    if (!force && this.fresh(key, entry))
      return Promise.resolve(entry.state.data as T);
    if (entry.inflight && !force) return entry.inflight as Promise<T>;
    entry.abort?.abort();
    const controller = new AbortController(),
      version = entry.version,
      generation = this.generation;
    entry.abort = controller;
    // Out-of-date data stays only for components already showing it; for
    // anyone who mounts next it is dropped, so a later retain() cannot bring
    // it back before the fresh response arrives.
    this.publish(
      key,
      entry,
      this.shownCount(key) > 0
        ? { ...entry.state, status: "loading", error: undefined }
        : { status: "loading" },
    );
    // A forced load replaces the request in flight. Whoever was waiting on the
    // replaced one gets the replacement's result, not an abort error.
    const replacement = () =>
      generation === this.generation &&
      controller.signal.aborted &&
      entry.inflight &&
      entry.inflight !== request
        ? (entry.inflight as Promise<T>)
        : undefined;
    const request: Promise<T> = this.fetcher(url, controller.signal).then(
      (data) => {
        if (generation !== this.generation || controller.signal.aborted)
          return replacement() ?? (data as T);
        entry.inflight = undefined;
        entry.abort = undefined;
        entry.fetchedAt = this.now();
        entry.refusedAt = undefined;
        entry.stale = entry.version !== version;
        // A save invalidated the entry while this request was running: the
        // response may predate it, so show it but fetch again.
        const outdated = entry.version !== version;
        this.publish(key, entry, { status: "ready", data });
        if (outdated && this.shownCount(key) > 0)
          void this.load(key, entry.url, [], { force: true }).catch(() => {});
        return data as T;
      },
      (error: unknown) => {
        if (generation !== this.generation || controller.signal.aborted) {
          const next = replacement();
          if (next) return next;
          throw error;
        }
        entry.inflight = undefined;
        entry.abort = undefined;
        const status =
          error instanceof StoreRequestError ? error.status : undefined;
        if (status === 401 || status === 403) {
          this.refuse(status, {
            key,
            entry,
            message: (error as Error).message,
          });
          throw error;
        }
        entry.stale = true;
        this.publish(key, entry, {
          status: "error",
          data: entry.state.data,
          error: error instanceof Error ? error.message : "Request failed.",
        });
        throw error;
      },
    );
    entry.inflight = request;
    return request;
  }

  /**
   * Stores a value the page already received from the server (for example the
   * bootstrap the server page computed while authorising the request), as if
   * it had just been fetched. Used before any component subscribes; an entry
   * that already exists is left alone.
   */
  seed(key: string, url: string, tags: string[], data: unknown) {
    if (this.entries.has(key)) return;
    const entry = this.entry(key, url, tags);
    entry.state = { status: "ready", data };
    entry.fetchedAt = this.now();
    entry.stale = false;
    this.snapshots.set(key, entry.state);
  }

  /** Marks entries carrying any of the tags as out of date and refetches the
   * ones currently on screen. Resolves when those refetches have finished. */
  async invalidate(...tags: string[]) {
    const refetches: Promise<unknown>[] = [];
    for (const [key, entry] of this.entries) {
      if (![...entry.tags].some((tag) => tags.includes(tag))) continue;
      entry.version++;
      entry.stale = true;
      entry.refusedAt = undefined;
      if (this.shownCount(key) > 0)
        refetches.push(this.load(key, entry.url, [], { force: true }));
    }
    await Promise.all(refetches);
  }

  /** Targeted update after a save, when the saved record is known. */
  update<T>(key: string, change: (current: T) => T) {
    const entry = this.entries.get(key);
    if (
      !entry ||
      entry.state.status === "idle" ||
      entry.state.data === undefined
    )
      return;
    this.publish(key, entry, {
      ...entry.state,
      data: change(entry.state.data as T),
    });
  }

  /** A component starts showing the entry; returns the release function. */
  retain(key: string) {
    this.shown.set(key, this.shownCount(key) + 1);
    return () => {
      const left = this.shownCount(key) - 1;
      if (left > 0) this.shown.set(key, left);
      else this.shown.delete(key);
    };
  }

  /**
   * The server refused a request. A 403 does not by itself mean access ended:
   * the server also uses it for a role limit or a business rule on one action.
   * So a 403 marks only its own entry as refused and asks the bootstrap (the
   * request every screen depends on) whether access still stands; only if that
   * is refused too does the whole store go. A 401 always does.
   */
  private refuse(
    status: number,
    refused?: { key: string; entry: Entry; message: string },
  ) {
    const bootstrap = this.entries.get("bootstrap");
    if (status !== 403 || !bootstrap || refused?.key === "bootstrap") {
      this.revoke(status, refused);
      return;
    }
    if (refused) {
      refused.entry.stale = true;
      refused.entry.refusedAt = this.now();
      this.publish(refused.key, refused.entry, {
        status: "error",
        error: refused.message,
      });
    }
    if (this.probing || this.recovering) return;
    this.probing = true;
    void this.load("bootstrap", bootstrap.url, [...bootstrap.tags], {
      force: true,
    })
      .catch(() => {})
      .finally(() => {
        this.probing = false;
      });
  }

  /**
   * Access ended (401, or a 403 on the bootstrap). Nothing fetched under the old
   * permissions survives: the store is emptied at once. The refused entry keeps
   * only the refusal, so its screen can say why it has no data. The entries on
   * screen are then fetched again, once: if access really ended, those fetches
   * are refused too and show the refusal; if only one action was not allowed
   * (a role limit), the other screens get their data back instead of blanking.
   * A refusal during that recovery marks its own entry and does not start
   * another round.
   */
  private revoke(
    status: number,
    refused?: { key: string; entry: Entry; message: string },
  ) {
    const mark = () => {
      if (!refused) return;
      refused.entry.stale = true;
      refused.entry.refusedAt = this.now();
      refused.entry.state = { status: "error", error: refused.message };
      this.entries.set(refused.key, refused.entry);
      this.publish(refused.key, refused.entry, refused.entry.state);
    };
    if (this.recovering) {
      mark();
      return;
    }
    const onScreen = [...this.entries]
      .filter(([key]) => key !== refused?.key && this.shownCount(key) > 0)
      .map(([key, entry]) => ({
        key,
        url: entry.url,
        tags: [...entry.tags],
        sensitive: entry.sensitive,
      }));
    this.clear();
    mark();
    this.options.onDenied?.(status);
    this.recovering = true;
    void Promise.allSettled(
      onScreen.map((entry) =>
        this.load(entry.key, entry.url, entry.tags, {
          force: true,
          sensitive: entry.sensitive,
        }),
      ),
    ).finally(() => {
      this.recovering = false;
    });
  }
  /** A request made outside the store (a save, for instance) was refused. */
  refusedByServer(status: number) {
    this.refuse(status);
  }

  /** Empties the store: academy switch, sign-out, 401 or 403. Requests still
   * in flight are abandoned and their responses ignored. */
  clear() {
    this.generation++;
    for (const entry of this.entries.values()) entry.abort?.abort();
    this.entries.clear();
    this.snapshots.clear();
    this.notify();
  }
}

const IDLE: EntryState = { status: "idle" };

let current: AcademyStore | undefined;
/** The store for the academy on screen. Asking for a different academy drops
 * the previous store, so one academy's data is never reachable from another. */
export function academyStore(
  academyId: string,
  create: () => AcademyStore,
): AcademyStore {
  if (current?.academyId === academyId) return current;
  current?.clear();
  current = create();
  return current;
}
/** The server refused a request made outside the store (401 or 403). */
export function reportRefusal(status: number) {
  current?.refusedByServer(status);
}
/** Drops the current store (sign-out). When `only` is given, the store is
 * dropped only if it is still the current one: a portal ending after another
 * academy's store replaced its own must not empty the newer store. */
export function clearAcademyStore(only?: AcademyStore) {
  if (only && current !== only) return;
  current?.clear();
  current = undefined;
}
