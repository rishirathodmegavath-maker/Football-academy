"use client";
import { useCallback, useRef, useState } from "react";
import type {
  FinanceActionResult,
  FinanceCommand,
  FinancePayload,
} from "@/domain/finance";
import type { useWorkspace } from "./use-workspace";
import { useStoreEntry } from "./use-store-entry";

export function useFinance(workspace: ReturnType<typeof useWorkspace>) {
  const academyId = workspace.shell?.academy.id;
  const role = workspace.shell?.membership.role;
  const allowed = role === "OWNER" || role === "ADMIN" || role === "PARENT";
  const enabled = Boolean(workspace.shell?.academy.modules.includes("fees"));
  const active = Boolean(academyId && enabled && allowed);
  const url = `/api/workspaces/${academyId}/finance`;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retry = useRef<{ fingerprint: string; command: FinanceCommand } | null>(
    null,
  );
  // The fee account lives in the academy store, so Home and Fees share one
  // fetch while it is fresh and a finance save refetches it exactly once.
  const entry = useStoreEntry<FinancePayload>(
    workspace.store,
    "finance",
    url,
    ["finance"],
    active,
    { sensitive: true },
  );
  const reload = useCallback(async () => {
    if (!active) return;
    await workspace.store.load<FinancePayload>("finance", url, ["finance"], {
      force: true,
      sensitive: true,
    });
  }, [active, workspace.store, url]);
  async function mutate(
    action: FinanceCommand["action"],
    values: unknown,
    extra: { id?: string; expectedVersion?: number } = {},
  ) {
    if (pending.current || !academyId || !enabled || !allowed) return undefined;
    const fingerprint = JSON.stringify({ academyId, action, values, extra });
    const command =
      retry.current?.fingerprint === fingerprint
        ? retry.current.command
        : { requestId: crypto.randomUUID(), action, data: values, ...extra };
    retry.current = { fingerprint, command };
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      // Finance commands write only the academy_finance_* tables, so the
      // academy payload is left alone; the fee account is refetched below.
      const result = await workspace.finance<FinanceActionResult>(command, {
        invalidates: [],
      });
      if (!result) {
        setError(
          "The change was not saved. Your draft is retained; review the error and retry.",
        );
        return undefined;
      }
      retry.current = null;
      try {
        await workspace.invalidate("finance");
      } catch {
        setError(
          "Saved successfully. The fee account could not refresh; refresh it before the next change.",
        );
      }
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh the fee account. Retry safely with the same draft.",
      );
      return undefined;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const data = entry.data ?? null;
  const scopedData =
    allowed &&
    enabled &&
    data !== null &&
    data?.academyId === academyId &&
    data.canManage === (role !== "PARENT")
      ? data
      : null;
  return {
    data: scopedData,
    error: !enabled
      ? "Fees are not enabled for this academy."
      : !allowed
        ? "Your academy role has no finance access."
        : error || (entry.status === "error" ? (entry.error ?? "") : ""),
    busy,
    reload,
    mutate,
  };
}
