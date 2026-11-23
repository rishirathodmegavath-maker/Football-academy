"use client";
import { useRef, useState } from "react";
import type {
  FootballSeries,
  FootballSession,
  SeriesPreview,
  SkippedOccurrence,
} from "@/domain/training";
import type { PortalController } from "./portal-types";
import type { TrainingSubmit } from "./training";
import { addDays } from "./portal-session-view-model";
import { DrillPickerButton } from "./drill-picker";
import { moveItem, totalMinutes } from "@/services/drill-library-view";
import "./session-extras.css";
import { displayDay } from "@/services/date-display";

const WEEKDAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [7, "Sunday"],
] as const;
const reasonText: Record<SkippedOccurrence["reason"], string> = {
  EXCLUDED: "Holiday",
  PAST: "Already started",
  TIME_INVALID: "Clock change",
  CONFLICT: "Booking conflict",
  CLOSURE: "Closed day",
};
const dateText = (date: string) => displayDay(date, { weekday: true });

/** Weekday names for a rule, e.g. "Tuesdays and Thursdays". */
export function weekdaysText(weekdays: number[]) {
  const names = WEEKDAYS.filter(([n]) => weekdays.includes(n)).map(
    ([, name]) => `${name}s`,
  );
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "");
}

function SkippedList({ skipped }: { skipped: SkippedOccurrence[] }) {
  if (!skipped.length) return null;
  return (
    <>
      <h3>
        {skipped.length} {skipped.length === 1 ? "date" : "dates"} will not be
        scheduled
      </h3>
      <ul className="sx-skipped" aria-label="Dates that will be skipped">
        {skipped.map((item) => (
          <li key={item.date}>
            <strong>{dateText(item.date)}</strong>
            <span className={`sx-reason sx-${item.reason.toLowerCase()}`}>
              {reasonText[item.reason]}
            </span>
            <span className="sx-small">{item.detail}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Weekly recurring sessions: choose the rule, preview exactly what it would
 * create and skip, then create the sessions. */
export function RecurringSessionForm({
  workspace: w,
  submit,
  onDone,
}: {
  workspace: PortalController;
  submit: TrainingSubmit;
  onDone: () => void;
}) {
  const d = w.data!;
  const viewer = d.viewer?.id ?? "";
  const isCoach = d.membership.role === "COACH";
  // One id per form, so a retry after a dropped connection is the same series.
  const seriesId = useRef(crypto.randomUUID());
  const today = new Date().toISOString().slice(0, 10);
  const [squadId, setSquadId] = useState(d.records.squad[0]?.id ?? ""),
    [venueId, setVenueId] = useState(""),
    [location, setLocation] = useState(""),
    [coachIds, setCoachIds] = useState<string[]>(isCoach ? [viewer] : []),
    [weekdays, setWeekdays] = useState<number[]>([]),
    [startDate, setStartDate] = useState(addDays(today, 1)),
    [endDate, setEndDate] = useState(addDays(today, 56)),
    [startTime, setStartTime] = useState("17:00"),
    [endTime, setEndTime] = useState("18:00"),
    [theme, setTheme] = useState(""),
    [agenda, setAgenda] = useState<{ drillId: string; duration: number }[]>([]),
    // Catalogue drills chosen from the library, by id.
    [libraryNames, setLibraryNames] = useState<Record<string, string>>({}),
    [holidays, setHolidays] = useState<{ date: string; label: string }[]>([]),
    [preview, setPreview] = useState<{ key: string; value: SeriesPreview }>(),
    [created, setCreated] = useState<FootballSeries>();
  const squad = d.records.squad.find((item) => item.id === squadId),
    branch = d.records.branch.find((item) => item.id === squad?.branchId),
    venues = d.records.venue.filter(
      (item) => item.branchId === squad?.branchId,
    );
  const payload = {
    branchId: squad?.branchId ?? "",
    squadId,
    venueId: venueId || undefined,
    location,
    coachIds,
    timezone: branch?.timezone ?? d.academy.timezone,
    weekdays,
    startDate,
    endDate,
    startTime,
    endTime,
    theme,
    agenda,
    exclusions: holidays.filter((item) => item.date),
  };
  const key = JSON.stringify(payload);
  const current = preview?.key === key ? preview.value : undefined;
  const ready = Boolean(squadId && weekdays.length && coachIds.length);

  if (created)
    return (
      <div className="sx-form" role="status">
        <h3>
          {created.skipped.length
            ? "Series created, with some dates skipped"
            : "Series created"}
        </h3>
        <p>
          {weekdaysText(created.weekdays)} at {created.startTime}-
          {created.endTime}, {dateText(created.startDate)} to{" "}
          {dateText(created.endDate)}.
        </p>
        <SkippedList skipped={created.skipped} />
        <button type="button" className="sx-primary" onClick={onDone}>
          Done
        </button>
      </div>
    );

  return (
    <form
      className="sx-form"
      aria-label="Weekly recurring sessions"
      onSubmit={async (event) => {
        event.preventDefault();
        const value = await w.training<SeriesPreview>({
          action: "seriesPreview",
          data: payload,
          requestId: crypto.randomUUID(),
        });
        if (value) setPreview({ key, value });
      }}
    >
      <p className="sx-small">
        Creates one session on each chosen weekday between the dates. A date is
        skipped, never moved, if it is a holiday, has already started, falls in
        a clock change, or clashes with another booking. Up to 26 weeks and 60
        sessions.
      </p>
      <label>
        Batch
        <select
          required
          value={squadId}
          onChange={(event) => {
            setSquadId(event.target.value);
            setVenueId("");
          }}
        >
          {d.records.squad.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Training space
        <select
          value={venueId}
          onChange={(event) => {
            setVenueId(event.target.value);
            setLocation(
              venues.find((item) => item.id === event.target.value)?.location ??
                location,
            );
          }}
        >
          <option value="">Recorded location</option>
          {venues.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Location
        <input
          required
          value={location}
          onChange={(event) => setLocation(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Weekdays</legend>
        {WEEKDAYS.map(([number, name]) => (
          <label className="check-row" key={number}>
            <input
              type="checkbox"
              checked={weekdays.includes(number)}
              onChange={(event) =>
                setWeekdays(
                  event.target.checked
                    ? [...weekdays, number]
                    : weekdays.filter((item) => item !== number),
                )
              }
            />
            {name}
          </label>
        ))}
      </fieldset>
      <div className="sx-row">
        <label>
          First date
          <input
            required
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label>
          Last date
          <input
            required
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </label>
        <label>
          Start time
          <input
            required
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <label>
          End time
          <input
            required
            type="time"
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </label>
      </div>
      <p className="sx-small">
        Times are local to the batch&apos;s branch ({payload.timezone}).
      </p>
      <fieldset>
        <legend>Assigned coaches</legend>
        {d.members
          .filter(
            (member) =>
              member.active &&
              ["COACH", "OWNER", "ADMIN"].includes(member.role),
          )
          .map((member) => (
            <label className="check-row" key={member.userId}>
              <input
                type="checkbox"
                checked={coachIds.includes(member.userId)}
                disabled={isCoach && member.userId === viewer}
                onChange={(event) =>
                  setCoachIds(
                    event.target.checked
                      ? [...coachIds, member.userId]
                      : coachIds.filter((item) => item !== member.userId),
                  )
                }
              />
              {member.name}
            </label>
          ))}
      </fieldset>
      <label>
        Session theme (optional)
        <input
          maxLength={2000}
          value={theme}
          onChange={(event) => setTheme(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Drills (optional)</legend>
        {agenda.map((item, index) => (
          <div className="sx-row" key={index}>
            <label>
              Drill {index + 1}
              <select
                value={item.drillId}
                onChange={(event) =>
                  setAgenda(
                    agenda.map((row, i) =>
                      i === index
                        ? { ...row, drillId: event.target.value }
                        : row,
                    ),
                  )
                }
              >
                {d.records.drill
                  .filter(
                    (drill) =>
                      drill.status !== "ARCHIVED" || drill.id === item.drillId,
                  )
                  .map((drill) => (
                    <option key={drill.id} value={drill.id}>
                      {drill.name}
                    </option>
                  ))}
                {Object.entries(libraryNames)
                  .filter(([id]) => !d.records.drill.some((v) => v.id === id))
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Minutes for drill {index + 1}
              <input
                type="number"
                min={1}
                max={180}
                value={item.duration}
                onChange={(event) =>
                  setAgenda(
                    agenda.map((row, i) =>
                      i === index
                        ? { ...row, duration: Number(event.target.value) }
                        : row,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => setAgenda(moveItem(agenda, index, -1))}
            >
              Move drill {index + 1} up
            </button>
            <button
              type="button"
              disabled={index === agenda.length - 1}
              onClick={() => setAgenda(moveItem(agenda, index, 1))}
            >
              Move drill {index + 1} down
            </button>
            <button
              type="button"
              onClick={() => setAgenda(agenda.filter((_, i) => i !== index))}
            >
              Remove drill {index + 1}
            </button>
          </div>
        ))}
        {agenda.length > 0 && (
          <p className="dl-total" role="status">
            Total drill time: {totalMinutes(agenda)} minutes
          </p>
        )}
        <button
          type="button"
          disabled={!d.records.drill.length}
          onClick={() =>
            setAgenda([
              ...agenda,
              {
                drillId:
                  d.records.drill.find((v) => v.status !== "ARCHIVED")?.id ??
                  d.records.drill[0].id,
                duration: 20,
              },
            ])
          }
        >
          Add a drill
        </button>
        <DrillPickerButton
          workspace={w}
          onAdd={(picked) => {
            setLibraryNames((now) => ({
              ...now,
              ...Object.fromEntries(picked.map((p) => [p.id, p.name])),
            }));
            setAgenda((now) => [
              ...now,
              ...picked.map((p) => ({
                drillId: p.id,
                duration: p.content.durationMinutes ?? 20,
              })),
            ]);
          }}
        />
      </fieldset>
      <fieldset>
        <legend>Holidays (no session on these dates)</legend>
        {holidays.map((item, index) => (
          <div className="sx-row" key={index}>
            <label>
              Holiday date {index + 1}
              <input
                type="date"
                value={item.date}
                min={startDate}
                max={endDate}
                onChange={(event) =>
                  setHolidays(
                    holidays.map((row, i) =>
                      i === index ? { ...row, date: event.target.value } : row,
                    ),
                  )
                }
              />
            </label>
            <label>
              Holiday name {index + 1}
              <input
                maxLength={200}
                value={item.label}
                onChange={(event) =>
                  setHolidays(
                    holidays.map((row, i) =>
                      i === index ? { ...row, label: event.target.value } : row,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                setHolidays(holidays.filter((_, i) => i !== index))
              }
            >
              Remove holiday {index + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setHolidays([...holidays, { date: "", label: "" }])}
        >
          Add a holiday
        </button>
      </fieldset>
      <button className="sx-primary" disabled={w.busy || !ready}>
        Preview dates
      </button>
      {!ready && (
        <p className="sx-small">
          Choose a batch, at least one weekday and at least one coach.
        </p>
      )}
      {current && (
        <section className="sx-preview" aria-label="Series preview">
          <h3 data-testid="preview-count">
            {current.occurrences.length}{" "}
            {current.occurrences.length === 1 ? "session" : "sessions"} will be
            created
          </h3>
          <ul aria-label="Sessions that will be created">
            {current.occurrences.map((item) => (
              <li key={item.date}>
                {dateText(item.date)} · {item.startLocal.slice(11)}
              </li>
            ))}
          </ul>
          <SkippedList skipped={current.skipped} />
          <button
            type="button"
            className="sx-primary"
            disabled={w.busy || !current.occurrences.length}
            onClick={async () => {
              const series = (await submit(
                "series",
                payload,
                seriesId.current,
                0,
              )) as FootballSeries | undefined;
              if (series) setCreated(series);
            }}
          >
            Create {current.occurrences.length}{" "}
            {current.occurrences.length === 1 ? "session" : "sessions"}
          </button>
        </section>
      )}
    </form>
  );
}

/** On a series session: what the series is, what was skipped, and a way to
 * add dates that were blocked (only dates that do not yet exist are created). */
export function SeriesSummary({
  workspace: w,
  session,
  submit,
}: {
  workspace: PortalController;
  session: FootballSession;
  submit: TrainingSubmit;
}) {
  const d = w.data!;
  if (!session.seriesId) return null;
  const series = d.records.series.find((item) => item.id === session.seriesId);
  if (!series)
    return (
      <p className="sx-small sx-series">Part of a weekly recurring series.</p>
    );
  const members = d.records.session.filter((s) => s.seriesId === series.id),
    now = new Date().toISOString(),
    upcoming = members.filter(
      (s) => ["DRAFT", "SCHEDULED"].includes(s.status) && s.startAt > now,
    ).length,
    cancelled = members.filter((s) => s.status === "CANCELLED").length;
  const blocked = series.skipped.filter((s) => s.reason === "CONFLICT");
  return (
    <section className="sx-series" aria-label="Weekly series">
      <p className="sx-eyebrow">Weekly series</p>
      <p>
        {weekdaysText(series.weekdays)} · {series.startTime}-{series.endTime}
      </p>
      <p className="sx-small">
        {dateText(series.startDate)} to {dateText(series.endDate)} ·{" "}
        {series.status === "CANCELLED" ? "Cancelled" : "Active"} · {upcoming}{" "}
        upcoming · {cancelled} cancelled
      </p>
      {series.skipped.length > 0 && (
        <details>
          <summary>{series.skipped.length} dates not scheduled</summary>
          <SkippedList skipped={series.skipped} />
        </details>
      )}
      {series.status === "ACTIVE" && blocked.length > 0 && (
        <button
          type="button"
          disabled={w.busy}
          onClick={() => submit("seriesSync", {}, series.id, series.version)}
        >
          Add missing dates
        </button>
      )}
      {series.status === "CANCELLED" && series.cancelOutcome && (
        <CancelOutcome series={series} />
      )}
    </section>
  );
}

/** What a series cancellation did, including every email that was or was not
 * sent, so nothing is lost silently. */
export function CancelOutcome({ series }: { series: FootballSeries }) {
  const outcome = series.cancelOutcome;
  if (!outcome) return null;
  const n = outcome.notices;
  return (
    <div className="sx-outcome" role="status">
      <p>
        <strong>
          {outcome.cancelled} {outcome.cancelled === 1 ? "session" : "sessions"}{" "}
          cancelled.
        </strong>
      </p>
      {outcome.left.length > 0 && (
        <>
          <p>Left as they were:</p>
          <ul>
            {outcome.left.map((item) => (
              <li key={item.sessionId}>
                {dateText(item.date)}: {item.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {!n.emailEnabled ? (
        <p>Email is not enabled, so no cancellation email was sent.</p>
      ) : n.guardians === 0 ? (
        <p>No linked parent needed a notice.</p>
      ) : (
        <p data-testid="notice-report">
          Parent emails: {n.queued} queued
          {n.deferred > 0 &&
            `, ${n.deferred} held back and sent within the hour (per-address limit)`}
          {n.alreadyNotified > 0 && `, ${n.alreadyNotified} already told`}
          {n.noAddress > 0 && `, ${n.noAddress} with no email address`}
          {n.refused > 0 &&
            `, ${n.refused} not sent (invalid or blocked address, or daily limit)`}
          .
        </p>
      )}
    </div>
  );
}
