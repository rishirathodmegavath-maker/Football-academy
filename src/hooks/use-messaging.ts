"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessagingView } from "@/domain/messaging";
import { workspaceRequest } from "./use-workspace";

/** The Communications screen's data and actions. Every action is one request to the academy's actions route; a refusal
 * comes back as the server's own words and is shown on the screen, never swallowed. */
export function useMessaging(academyId: string) {
  const [view, setView] = useState<MessagingView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const url = `/api/workspaces/${academyId}/actions`;
  const call = useCallback(
    <T>(action: string, body: { id?: string; data?: unknown } = {}) =>
      workspaceRequest<T>(url, "POST", { action, ...body }),
    [url],
  );
  const reload = useCallback(async () => {
    setView(await call<MessagingView>("messagingView"));
  }, [call]);
  useEffect(() => {
    let live = true;
    call<MessagingView>("messagingView")
      .then((next) => live && setView(next))
      .catch(
        (e: unknown) =>
          live &&
          setError(e instanceof Error ? e.message : "Communications unavailable."),
      );
    return () => {
      live = false;
    };
  }, [call]);
  /** Runs one action; on success the screen's data is read again. Returns undefined when the server refused. */
  async function run<T>(
    action: string,
    body: { id?: string; data?: unknown } = {},
    { refresh = true }: { refresh?: boolean } = {},
  ): Promise<T | undefined> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await call<T>(action, body);
      if (refresh) await reload();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { view, error, setError, busy, run, call, reload };
}
