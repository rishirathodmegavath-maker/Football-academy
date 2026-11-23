"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceRequest } from "@/lib/workspace-request";
import type {
  DeliveryJobPage,
  DeliveryJobRow,
  DeliveryState,
} from "@/domain/communication";

export const DELIVERY_PAGE_SIZE = 25;
export interface DeliveryJobFilters {
  playerId?: string;
  state?: DeliveryState | "";
  q?: string;
}
interface Loaded {
  /** The first-page URL these rows answer: a different filter is a different key. */
  key: string;
  jobs: DeliveryJobRow[];
  next: string | null;
  error: string;
}
/**
 * The delivery list one page at a time (GET /communication/jobs). A change of
 * filter starts again from the newest page; a change of `refreshKey` (the
 * Communication view was refetched after a command) reloads the pages already
 * shown in place, without blanking the list. Answers that arrive after the
 * filter changed again are dropped.
 */
export function useDeliveryJobs(
  academyId: string | undefined,
  filters: DeliveryJobFilters,
  enabled: boolean,
  refreshKey: unknown,
) {
  const { playerId = "", state = "", q = "" } = filters;
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [loadingMore, setLoadingMore] = useState(false),
    [moreError, setMoreError] = useState("");
  const active = enabled && Boolean(academyId);
  const url = useCallback(
    (cursor?: string, limit = DELIVERY_PAGE_SIZE) => {
      const p = new URLSearchParams({ limit: String(limit) });
      if (playerId) p.set("playerId", playerId);
      if (state) p.set("state", state);
      if (q.trim()) p.set("q", q.trim());
      if (cursor) p.set("cursor", cursor);
      return `/api/workspaces/${academyId}/communication/jobs?${p}`;
    },
    [academyId, playerId, state, q],
  );
  const key = url();
  // Rows for another filter are not shown: the list reads as loading instead.
  const current = loaded && loaded.key === key ? loaded : null;
  const generation = useRef(0),
    abort = useRef<AbortController | null>(null),
    shown = useRef(0);
  shown.current = current?.jobs.length ?? 0;

  const fetchFirst = useCallback(
    async (limit: number) => {
      const mine = ++generation.current;
      abort.current?.abort();
      const controller = (abort.current = new AbortController());
      try {
        const page = await workspaceRequest<DeliveryJobPage>(
          url(undefined, limit),
          "GET",
          undefined,
          controller.signal,
        );
        if (mine !== generation.current) return;
        setMoreError("");
        setLoaded({ key, jobs: page.jobs, next: page.nextCursor, error: "" });
      } catch (e) {
        if (mine !== generation.current || controller.signal.aborted) return;
        setLoaded((old) => ({
          key,
          jobs: old?.key === key ? old.jobs : [],
          next: old?.key === key ? old.next : null,
          error:
            e instanceof Error
              ? e.message
              : "The delivery list could not load.",
        }));
      }
    },
    [url, key],
  );
  // A new filter, player or academy: start again from the newest page.
  useEffect(() => {
    if (!active) return;
    void fetchFirst(DELIVERY_PAGE_SIZE);
    return () => abort.current?.abort();
  }, [active, fetchFirst]);
  // The view behind this list changed (a notification was cancelled, a reply
  // was attached): refresh what is on screen. The first run is the load above.
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    if (active)
      void fetchFirst(
        Math.min(100, Math.max(DELIVERY_PAGE_SIZE, shown.current)),
      );
    // `fetchFirst` changes with the filter, which has its own effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const loadMore = useCallback(async () => {
    if (!current?.next || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const page = await workspaceRequest<DeliveryJobPage>(
        url(current.next),
        "GET",
        undefined,
        abort.current?.signal,
      );
      if (mine !== generation.current) return;
      setLoaded((old) => {
        if (!old || old.key !== key) return old;
        const have = new Set(old.jobs.map((j) => j.id));
        return {
          ...old,
          jobs: [...old.jobs, ...page.jobs.filter((j) => !have.has(j.id))],
          next: page.nextCursor,
        };
      });
    } catch (e) {
      if (mine === generation.current)
        setMoreError(
          e instanceof Error ? e.message : "More notifications could not load.",
        );
    } finally {
      setLoadingMore(false);
    }
  }, [current, loadingMore, url, key]);
  return {
    jobs: current?.jobs ?? [],
    status: !current
      ? ("loading" as const)
      : current.error && !current.jobs.length
        ? ("error" as const)
        : ("ready" as const),
    error: moreError || current?.error || "",
    hasMore: Boolean(current?.next),
    loadingMore,
    loadMore,
    reload: () => fetchFirst(DELIVERY_PAGE_SIZE),
  };
}
