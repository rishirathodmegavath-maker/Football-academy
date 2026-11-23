"use client";
import { useState } from "react";
import type { FootballSession, WrapUpOutcome } from "@/domain/training";
import { useSessionWrapUp } from "@/hooks/use-training-extras";
import type { PortalController } from "./portal-types";
import type { TrainingSubmit } from "./training";
import "./session-extras.css";

const outcomeText: Record<WrapUpOutcome, string> = {
  COMPLETED: "Completed",
  PARTIAL: "Partly done",
  SKIPPED: "Skipped",
};

type Row = {
  outcome: WrapUpOutcome;
  minutes: string;
  note: string;
};

/**
 * The coach's account of how a session actually went, against its plan. Staff
 * only: parents never receive it (the server does not send it to them). It is
 * optional and never blocks completing the session.
 */
export function SessionWrapUp({
  workspace: w,
  session,
  submit,
}: {
  workspace: PortalController;
  session: FootballSession;
  submit: TrainingSubmit;
}) {
  const read = useSessionWrapUp(w, session.id);
  const open = ["IN_PROGRESS", "COMPLETED"].includes(session.status);
  if (!open)
    return (
      <p className="sx-small">
        The wrap-up can be written once training has started.
      </p>
    );
  if (read.error) return <p role="alert">{read.error}</p>;
  if (read.loading) return <p role="status">Loading wrap-up…</p>;
  // A remount per saved version puts the saved values back in the form.
  return (
    <WrapUpForm
      key={read.data?.version ?? 0}
      session={session}
      existing={read.data}
      submit={submit}
      busy={w.busy}
    />
  );
}

function WrapUpForm({
  session,
  existing,
  submit,
  busy,
}: {
  session: FootballSession;
  existing?: ReturnType<typeof useSessionWrapUp>["data"];
  submit: TrainingSubmit;
  busy: boolean;
}) {
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      session.agenda.map((item) => {
        const saved = existing?.drills.find((d) => d.drillId === item.drill.id);
        return [
          item.drill.id,
          {
            outcome: saved?.outcome ?? "COMPLETED",
            minutes: String(saved?.actualMinutes ?? item.duration),
            note: saved?.note ?? "",
          } satisfies Row,
        ];
      }),
    ),
  );
  const [observations, setObservations] = useState(
      existing?.observations ?? "",
    ),
    [achievements, setAchievements] = useState(existing?.achievements ?? ""),
    [improvements, setImprovements] = useState(existing?.improvements ?? "");
  const planned = session.agenda.reduce((sum, item) => sum + item.duration, 0),
    done = session.agenda.filter(
      (item) => rows[item.drill.id]?.outcome === "COMPLETED",
    ).length,
    actual = session.agenda.reduce(
      (sum, item) =>
        sum +
        (rows[item.drill.id]?.outcome === "SKIPPED"
          ? 0
          : Number(rows[item.drill.id]?.minutes) || 0),
      0,
    );
  const set = (id: string, change: Partial<Row>) =>
    setRows({ ...rows, [id]: { ...rows[id], ...change } });
  return (
    <form
      className="sx-wrapup"
      aria-label="Session wrap-up"
      onSubmit={async (event) => {
        event.preventDefault();
        await submit(
          "wrapup",
          {
            drills: session.agenda.map((item) => {
              const row = rows[item.drill.id];
              return {
                drillId: item.drill.id,
                outcome: row.outcome,
                ...(row.outcome === "SKIPPED" || row.minutes === ""
                  ? {}
                  : { actualMinutes: Number(row.minutes) }),
                note: row.note,
              };
            }),
            observations,
            achievements,
            improvements,
          },
          session.id,
          existing?.version ?? 0,
        );
      }}
    >
      <p className="sx-small">
        Private to academy staff. Parents do not see wrap-up notes, and writing
        one is optional.
      </p>
      {session.agenda.length > 0 && (
        <>
          <h3>Planned and completed drills</h3>
          <p className="sx-figures" data-testid="wrapup-summary">
            {done} of {session.agenda.length} drills completed · {actual} of{" "}
            {planned} planned minutes
          </p>
          <ul className="sx-drills">
            {session.agenda.map((item) => {
              const row = rows[item.drill.id];
              return (
                <li key={item.drill.id}>
                  <div className="sx-drill-head">
                    <strong>{item.drill.name}</strong>
                    <span className="sx-small">
                      Planned {item.duration} min
                    </span>
                  </div>
                  <label>
                    Outcome for {item.drill.name}
                    <select
                      value={row.outcome}
                      onChange={(event) =>
                        set(item.drill.id, {
                          outcome: event.target.value as WrapUpOutcome,
                        })
                      }
                    >
                      {(Object.keys(outcomeText) as WrapUpOutcome[]).map(
                        (value) => (
                          <option key={value} value={value}>
                            {outcomeText[value]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Minutes done for {item.drill.name}
                    <input
                      type="number"
                      min={0}
                      max={480}
                      disabled={row.outcome === "SKIPPED"}
                      value={row.outcome === "SKIPPED" ? "0" : row.minutes}
                      onChange={(event) =>
                        set(item.drill.id, { minutes: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Note for {item.drill.name}
                    <input
                      maxLength={1000}
                      value={row.note}
                      onChange={(event) =>
                        set(item.drill.id, { note: event.target.value })
                      }
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <label>
        Coach observations
        <textarea
          maxLength={4000}
          value={observations}
          onChange={(event) => setObservations(event.target.value)}
        />
      </label>
      <label>
        Achievements
        <textarea
          maxLength={4000}
          value={achievements}
          onChange={(event) => setAchievements(event.target.value)}
        />
      </label>
      <label>
        Improvement notes
        <textarea
          maxLength={4000}
          value={improvements}
          onChange={(event) => setImprovements(event.target.value)}
        />
      </label>
      <button className="sx-primary" disabled={busy}>
        {existing ? "Update wrap-up" : "Save wrap-up"}
      </button>
      {existing && (
        <p className="sx-small">
          Saved version {existing.version}. Earlier versions are kept in the
          session history.
        </p>
      )}
    </form>
  );
}
