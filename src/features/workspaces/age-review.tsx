"use client";
import { useState } from "react";
import type { WorkspacePlayer } from "@/domain/workspace";
import { ageState, ageStateLabel } from "@/domain/player-age";
import type { PortalController } from "./portal-types";

/**
 * Players are under 18. This shows the owner who needs a decision: players who have turned 18 (accept = archive, reject =
 * keep for now with a reason and a day to look again), who turn 18 within a month, and who has no date of birth yet. Only
 * the owner can decide; coaches and admins see the same list without the buttons.
 */
export function AgeReview({
  workspace: w,
  today,
  onEdit,
}: {
  workspace: PortalController;
  today: string;
  onEdit: (player: WorkspacePlayer) => void;
}) {
  const d = w.data!,
    owner = d.membership.role === "OWNER",
    [keeping, setKeeping] = useState<WorkspacePlayer | null>(null),
    [reason, setReason] = useState(""),
    [recheckOn, setRecheckOn] = useState(""),
    [archiving, setArchiving] = useState<WorkspacePlayer | null>(null);
  const order = { DECIDE: 0, BIRTH_DATE_MISSING: 1, TURNING_18: 2, KEPT: 3, OK: 4 } as const;
  const items = d.records.player
    .map((player) => ({ player, state: ageState(player, today) }))
    .filter((item) => item.state.kind !== "OK")
    .sort(
      (a, b) =>
        order[a.state.kind] - order[b.state.kind] ||
        a.player.name.localeCompare(b.player.name),
    );
  if (!items.length) return null;
  const needs = items.filter((item) => item.state.kind === "DECIDE").length;
  return (
    <section
      className={`age-review${needs ? " needs" : ""}`}
      aria-label="Age review"
    >
      <h2>
        Age review
        {needs ? ` · ${needs} need${needs === 1 ? "s" : ""} your decision` : ""}
      </h2>
      <p>Players must be under 18.</p>
      <ul>
        {items.map(({ player, state }) => (
          <li key={player.id}>
            <span>
              <strong>{player.name}</strong>
              <small>{ageStateLabel(state)}</small>
            </span>
            <span className="age-review-actions">
              {state.kind === "BIRTH_DATE_MISSING" && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onEdit(player)}
                >
                  Add date of birth
                </button>
              )}
              {(state.kind === "DECIDE" || state.kind === "KEPT") && owner && (
                <>
                  <button
                    type="button"
                    className="button primary"
                    disabled={w.busy}
                    onClick={() => setArchiving(player)}
                  >
                    Accept · archive
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={w.busy}
                    onClick={() => {
                      setKeeping(player);
                      setReason("");
                      setRecheckOn("");
                    }}
                  >
                    Reject · keep for now
                  </button>
                </>
              )}
              {state.kind === "DECIDE" && !owner && (
                <small>Waiting for the owner</small>
              )}
            </span>
          </li>
        ))}
      </ul>
      {archiving && (
        <div className="age-review-form" role="group" aria-label="Archive player">
          <p>
            <strong>Archive {archiving.name}?</strong> They turned 18, so they
            leave the active list. Their record, history and reports are kept,
            and an owner can restore the profile later.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={w.busy}
            onClick={async () => {
              if (await w.action("ageReview", archiving.id, { decision: "ARCHIVE" }))
                setArchiving(null);
            }}
          >
            Archive player
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setArchiving(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {keeping && (
        <form
          className="age-review-form form-stack"
          aria-label="Keep player for now"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await w.action("ageReview", keeping.id, {
                decision: "KEEP",
                reason,
                recheckOn,
              })
            )
              setKeeping(null);
          }}
        >
          <p>
            <strong>Keep {keeping.name} for now?</strong> Players are meant to
            be under 18. Give a reason and the day to look at this again (at
            most a year away); you will be asked again then.
          </p>
          <label>
            Why does this player stay?
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            Look at this again on
            <input
              type="date"
              required
              min={today}
              value={recheckOn}
              onChange={(e) => setRecheckOn(e.target.value)}
            />
          </label>
          <button className="button primary" disabled={w.busy}>
            Keep for now
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setKeeping(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {w.error && <p role="alert">{w.error}</p>}
    </section>
  );
}
