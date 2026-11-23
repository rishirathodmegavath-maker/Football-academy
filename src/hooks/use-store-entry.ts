"use client";
import { useEffect, useSyncExternalStore } from "react";
import {
  AcademyStore,
  academyStore,
  type EntryState,
} from "@/lib/academy-store";
import { workspaceRequest } from "@/lib/workspace-request";

const fetchJson = (url: string, signal: AbortSignal) =>
  workspaceRequest<unknown>(url, "GET", undefined, signal, { quiet: true });
const IDLE: EntryState = { status: "idle" };

/**
 * The in-memory store for the academy on screen (see lib/academy-store).
 * `initial` is data the server page already holds for this user (the
 * bootstrap), placed in a new store so the portal opens without asking again.
 * On the server this returns a throwaway store: the server process serves
 * every user, so nothing may live in module state there.
 */
export function useAcademyStore(
  academyId: string,
  initial?: { key: string; url: string; tags: string[]; data: unknown },
) {
  const create = () => {
    const store = new AcademyStore(academyId, fetchJson);
    if (initial)
      store.seed(initial.key, initial.url, initial.tags, initial.data);
    return store;
  };
  return typeof window === "undefined"
    ? create()
    : academyStore(academyId, create);
}

/**
 * One store entry for a component: loads it on mount (a fresh value is reused
 * without a request; an out-of-date one is fetched) and keeps it current while
 * the component is on screen. \`enabled: false\` loads nothing.
 */
export function useStoreEntry<T>(
  store: AcademyStore,
  key: string,
  url: string,
  tags: string[],
  enabled = true,
  { sensitive = false }: { sensitive?: boolean } = {},
): EntryState<T> {
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.state<T>(key),
    () => IDLE as EntryState<T>,
  );
  const tagKey = tags.join("|");
  useEffect(() => {
    if (!enabled) return;
    void store
      .load<T>(key, url, tagKey.split("|"), { sensitive })
      .catch(() => {});
    return store.retain(key);
  }, [store, key, url, tagKey, enabled, sensitive]);
  return state;
}
