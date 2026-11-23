"use client";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/hooks/use-workspace";
import { BranchesAndBatches } from "./branches-batches";

/** Settings → Sessions: branches and batches, plus the owner-only support review grant. */
export function AcademyStructure({
  workspace: w,
}: {
  workspace: ReturnType<typeof useWorkspace>;
  sportId?: string;
}) {
  const d = w.data!,
    [support, setSupport] = useState(""),
    [reason, setReason] = useState(""),
    [playerId, setPlayerId] = useState("");
  return (
    <>
      <BranchesAndBatches workspace={w} />
      {d.membership.role === "OWNER" && (
        <details className="as-card">
          <summary>Authorise a one-hour platform support review</summary>
          <p>
            Only a registered platform administrator can be selected. Access is
            limited to the selected player’s approved reports and plan
            snapshots; messages, dietary notes and private coach notes remain
            hidden. The grant and reads are audited.
          </p>
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              await w.action("support", undefined, {
                userId: support,
                playerIds: [playerId],
                reason,
              });
            }}
          >
            <label>
              Registered platform support account ID
              <input
                required
                value={support}
                onChange={(e) => setSupport(e.target.value)}
              />
            </label>
            <label>
              Specific player
              <select
                required
                value={playerId}
                onChange={(e) => setPlayerId(e.target.value)}
              >
                <option value="">Choose player</option>
                {d.records.player.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reason for access
              <textarea
                minLength={10}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <Button disabled={w.busy}>Grant scoped support review</Button>
          </form>
        </details>
      )}
    </>
  );
}
