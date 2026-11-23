"use client";
import { useCallback, useState, useRef } from "react";
import type { WorkspaceKind, WorkspacePayload } from "@/domain/workspace";
import type { WorkspaceBootstrap, WorkspaceShell } from "@/domain/home-summary";
import type { FootballSession } from "@/domain/training";
import { workspaceRequest } from "@/lib/workspace-request";
import { payloadFor } from "@/services/workspace-profiles";
import { useAcademyStore, useStoreEntry } from "./use-store-entry";

export { workspaceRequest };

function isSavedSession(value: unknown): value is FootballSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    [
      "id",
      "academyId",
      "sportId",
      "branchId",
      "squadId",
      "location",
      "timezone",
      "startLocal",
      "endLocal",
      "startAt",
      "endAt",
      "theme",
      "updatedAt",
      "updatedBy",
    ].every((key) => typeof record[key] === "string") &&
    typeof record.version === "number" &&
    typeof record.status === "string" &&
    ["DRAFT", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(
      record.status,
    ) &&
    Array.isArray(record.coachIds) &&
    Array.isArray(record.roster) &&
    Array.isArray(record.agenda) &&
    Array.isArray(record.objectives)
  );
}

/** A screen that reads a record kind its payload did not load would see it
 * empty. Report that loudly instead of silently showing no records. */
const guarded = new WeakMap<WorkspacePayload, WorkspacePayload>();
function guardUnloadedKinds(data: WorkspacePayload): WorkspacePayload {
  const loaded = data.loadedKinds;
  if (!loaded) return data;
  const known = guarded.get(data);
  if (known) return known;
  const warned = new Set<string>();
  const result: WorkspacePayload = {
    ...data,
    records: new Proxy(data.records, {
      get(records, kind: string) {
        if (
          kind in records &&
          !loaded.includes(kind as WorkspaceKind) &&
          !warned.has(kind)
        ) {
          warned.add(kind);
          console.warn(
            `This screen read the "${kind}" records, which its academy payload did not load.`,
          );
        }
        return records[kind as WorkspaceKind];
      },
    }),
  };
  guarded.set(data, result);
  return result;
}

/** Per-command options. `invalidates` names the cached data a successful
 * write changed; the default is the academy payload, Home and the fee account. A command that
 * changes neither (finance, trial rules, communication settings) names only
 * the data it did change. */
export interface MutateOptions {
  invalidates?: string[];
}
// The fee account derives invoice suggestions from sessions, players, batches
// and trials, so a save to any of them also makes the cached fee account stale.
const WORKSPACE_CHANGED = ["workspace", "home", "finance"];

/**
 * The academy workspace for the portal. The small bootstrap loads on mount;
 * the academy payload loads only as much as the current screen needs (Home
 * none, some screens a few record kinds, the rest everything) and is kept in
 * the academy-scoped store, which a save invalidates by tag.
 */
export function useWorkspace(
  academyId: string,
  {
    screen = "home",
    initialBootstrap,
  }: { screen?: string; initialBootstrap?: WorkspaceBootstrap } = {},
) {
  const pending = useRef(false);
  const store = useAcademyStore(
    academyId,
    initialBootstrap && {
      key: "bootstrap",
      url: `/api/workspaces/${academyId}/bootstrap`,
      tags: ["bootstrap"],
      data: initialBootstrap,
    },
  );
  const [mutationError, setMutationError] = useState(""),
    [trainingFeedback, setTrainingFeedback] = useState<{
      academyId: string;
      notice: string;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const base = `/api/workspaces/${academyId}`;
  const bootstrap = useStoreEntry<WorkspaceBootstrap>(
    store,
    "bootstrap",
    `${base}/bootstrap`,
    ["bootstrap"],
  );
  const role = bootstrap.data?.membership.role,
    wanted = role ? payloadFor(screen, role) : "none",
    kinds = Array.isArray(wanted) ? [...wanted].sort() : undefined,
    key = kinds ? `workspace:${kinds.join(",")}` : "workspace:all",
    url = kinds ? `${base}?kinds=${kinds.join(",")}` : base;
  const payload = useStoreEntry<WorkspacePayload>(
    store,
    key,
    url,
    ["workspace"],
    Boolean(role) && wanted !== "none",
  );
  const reload = useCallback(async () => {
    await store.load<WorkspacePayload>(key, url, ["workspace"], {
      force: true,
    });
  }, [store, key, url]);
  async function mutate<T>(
    path: string,
    method: string,
    body: unknown,
    options: MutateOptions = {},
  ): Promise<T | undefined> {
    if (pending.current) return undefined;
    pending.current = true;
    setBusy(true);
    setMutationError("");
    try {
      const value = await workspaceRequest<T>(`${base}${path}`, method, body);
      try {
        await store.invalidate(...(options.invalidates ?? WORKSPACE_CHANGED));
      } catch {
        if (
          path === "/training" &&
          typeof body === "object" &&
          body !== null &&
          "action" in body &&
          body.action === "session" &&
          isSavedSession(value) &&
          value.academyId === academyId
        ) {
          const session = value;
          store.update<WorkspacePayload>(key, (current) => {
            if (current.academy.id !== academyId) return current;
            const previous = current.records.session.find(
              (record) => record.id === session.id,
            );
            if (previous && previous.version > session.version) return current;
            return {
              ...current,
              records: {
                ...current.records,
                session: [
                  ...current.records.session.filter(
                    (record) => record.id !== session.id,
                  ),
                  session,
                ],
              },
            };
          });
        }
        setMutationError(
          "Saved to academy records, but the refreshed view could not load. Reload to see the confirmed result.",
        );
      }
      return value;
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : "Could not save.");
      return undefined;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const fullData =
      payload.data?.academy.id === academyId
        ? guardUnloadedKinds(payload.data)
        : null,
    bootData = bootstrap.data?.academy.id === academyId ? bootstrap.data : null;
  const loadError =
    (bootstrap.status === "error" ? bootstrap.error : "") ||
    (payload.status === "error" ? payload.error : "");
  return {
    /** The academy payload for this screen (see payloadFor), once loaded. */
    data: fullData,
    /** The signed-in academy context: the payload once loaded, else the
     * bootstrap. Enough to render the shell and to decide what to load. */
    shell: (fullData ?? bootData) as WorkspaceShell | null,
    /** Reloads whatever failed to load. */
    retry: () => {
      void store
        .load("bootstrap", `${base}/bootstrap`, ["bootstrap"], { force: true })
        .catch(() => {});
      if (wanted !== "none") void reload().catch(() => {});
    },
    error: mutationError || loadError,
    trainingNotice:
      trainingFeedback?.academyId === academyId ? trainingFeedback.notice : "",
    setTrainingNotice: (notice: string) =>
      setTrainingFeedback({ academyId, notice }),
    busy,
    reload,
    /** Marks cached data out of date and refetches what is on screen. */
    invalidate: (...tags: string[]) => store.invalidate(...tags),
    store,
    save: <T>(kind: WorkspaceKind, body: unknown, id?: string) =>
      mutate<T>(
        `/records/${kind}${id ? `/${id}` : ""}`,
        id ? "PUT" : "POST",
        body,
      ),
    action: <T>(
      action: string,
      id?: string,
      payload?: unknown,
      verified = false,
    ) => mutate<T>("/actions", "POST", { action, id, data: payload, verified }),
    configure: (body: unknown) =>
      mutate(
        "",
        "PATCH",
        {
          expectedVersion:
            fullData?.academy.configVersion ??
            bootData?.academy.configVersion ??
            0,
          ...(typeof body === "object" && body !== null ? body : {}),
        },
        { invalidates: [...WORKSPACE_CHANGED, "bootstrap"] },
      ),
    training: <T>(body: unknown) => mutate<T>("/training", "POST", body),
    period: <T>(body: unknown) => mutate<T>("/periods", "POST", body),
    communication: <T>(body: unknown, options?: MutateOptions) =>
      mutate<T>("/communication", "POST", body, options),
    finance: <T>(body: unknown, options?: MutateOptions) =>
      mutate<T>("/finance", "POST", body, options),
  };
}
