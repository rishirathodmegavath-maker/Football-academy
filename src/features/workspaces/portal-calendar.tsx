"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ClipboardList,
  CircleCheck,
  Cone,
  Copy,
  MapPin,
  Pencil,
  Plus,
  Repeat,
  Target,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { FootballSeries, FootballSession } from "@/domain/training";
import type { AcademyConfiguration } from "@/domain/workspace";
import { sessionFocus, sessionSummary } from "@/services/session-display";
import {
  confirmUnsavedChanges,
  useUnsavedChanges,
} from "@/hooks/use-unsaved-changes";
import {
  useSessionAttendance,
  useSessionEvidence,
} from "@/hooks/use-session-records";
import type { SessionPortalProps, PortalController } from "./portal-types";
import { SessionEditor, useTraining, type TrainingSubmit } from "./training";
import { ClosedDaysBanner, ClosedDaysManager } from "./closed-days";
import {
  AddToCalendar,
  CalendarLinkCard,
  SessionShare,
} from "./session-sharing";
import {
  CancelOutcome,
  RecurringSessionForm,
  SeriesSummary,
} from "./recurring-sessions";
import {
  academyDay,
  addDays,
  calendarColumns,
  clock,
  dayLabel,
  sessionSegmentForDay,
  sessionIntersectsDays,
  sessionMatchesVenue,
  weekStartOf,
  sessionDay,
  sessionTone,
} from "./portal-session-view-model";
import "./portal-calendar.css";
import { displayDay } from "@/services/date-display";

type View = "Week" | "Month" | "Agenda";
type Modal =
  | { kind: "new" | "edit"; initial?: FootballSession }
  | { kind: "series" }
  | { kind: "reschedule" | "cancel"; initial: FootballSession };
const statusLabel = (value: string) => value.toLowerCase().replaceAll("_", " ");
const subscribeViewport = (callback: () => void) => {
  const media = window.matchMedia("(max-width: 1199px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

export function PortalCalendar({
  workspace: w,
  sessionId,
  onNavigate,
}: SessionPortalProps) {
  const params = useSearchParams(),
    t = useTraining(w);
  const lastFocused = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (
      lastFocused.current?.isConnected &&
      !lastFocused.current.hasAttribute("disabled")
    )
      lastFocused.current.focus();
    else
      (
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".pc-workspace button[data-session-id]",
          ),
        ).find((button) => button.dataset.sessionId === sessionId) ??
        document.querySelector<HTMLButtonElement>(".pc-heading button")
      )?.focus();
  };
  const mobilePanel = useSyncExternalStore(
    subscribeViewport,
    () => window.matchMedia("(max-width: 1199px)").matches,
    () => false,
  );
  const view: View =
    params.get("view") === "Month"
      ? "Month"
      : params.get("view") === "Agenda"
        ? "Agenda"
        : "Week";
  const selected = w.data?.records.session.find(
    (session) => session.id === sessionId,
  );
  const timezone = w.data?.academy.timezone ?? "UTC";
  const today = academyDay(new Date(), timezone);
  const requestedDay = params.get("date");
  const day =
    requestedDay &&
    /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) &&
    Number.isFinite(Date.parse(requestedDay)) &&
    new Date(`${requestedDay}T12:00:00Z`).toISOString().slice(0, 10) ===
      requestedDay
      ? requestedDay
      : selected?.startAt
        ? sessionDay(selected, timezone)
        : today;
  const batch = params.get("batch") ?? "",
    coach = params.get("coach") ?? "",
    status = params.get("sessionStatus") ?? "",
    venue = params.get("venue") ?? "";
  const [tab, setTab] = useState("Details"),
    [panelOpen, setPanelOpen] = useState(Boolean(sessionId));
  const [modal, setModal] = useState<Modal | null>(null);
  if (!w.data) return <p role="status">Loading academy calendar…</p>;
  const d = w.data,
    staff = ["OWNER", "ADMIN", "COACH"].includes(d.membership.role);
  if (!staff)
    return <p role="alert">The staff calendar is unavailable for this role.</p>;
  const weekdays =
    d.academy.weekStartsOn === 0
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const week = weekStartOf(day, d.academy.weekStartsOn),
    weekDays = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const monthStart = `${day.slice(0, 7)}-01`,
    monthDays = Array.from({ length: 42 }, (_, index) =>
      addDays(weekStartOf(monthStart, d.academy.weekStartsOn), index),
    );
  const filtered = d.records.session.filter(
    (session) =>
      (!batch || session.squadId === batch) &&
      (!coach || session.coachIds.includes(coach)) &&
      (!status || session.status === status) &&
      sessionMatchesVenue(session, venue, d.records.venue),
  );
  const dated = filtered
    .filter((session) => session.startAt)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const visible = dated.filter((session) => {
    const date = sessionDay(session, timezone);
    return view === "Month"
      ? date.slice(0, 7) === day.slice(0, 7)
      : view === "Week"
        ? sessionIntersectsDays(session, week, addDays(week, 6), timezone)
        : date >= week && date <= addDays(week, 6);
  });
  const label = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
  const title = (session: FootballSession) =>
    d.records.squad.find((squad) => squad.id === session.squadId)?.name ??
    "Archived batch";
  function choose(session: FootballSession, visibleDay?: string) {
    if (!confirmUnsavedChanges()) return;
    setPanelOpen(true);
    setTab("Details");
    onNavigate("calendar", {
      session: session.id,
      date: visibleDay || sessionDay(session, timezone) || day,
      view,
    });
  }
  function move(amount: number) {
    if (!confirmUnsavedChanges()) return;
    const date = new Date(`${day}T12:00:00Z`);
    if (view === "Month") {
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + amount);
    } else date.setUTCDate(date.getUTCDate() + amount * 7);
    const next = date.toISOString().slice(0, 10);
    onNavigate("calendar", { session: sessionId, date: next, view });
  }
  const closeModal = () => {
    if (!w.busy && confirmUnsavedChanges()) setModal(null);
  };
  const panel = selected ? (
    <SessionPanel
      workspace={w}
      submit={t.submit}
      session={selected}
      tab={tab}
      onTab={setTab}
      onClose={() => setPanelOpen(false)}
      onOpen={(desk) =>
        onNavigate("training", { session: selected.id, desk: desk ?? "" })
      }
      onEdit={() =>
        setModal({
          kind: selected.status === "DRAFT" ? "edit" : "reschedule",
          initial: selected,
        })
      }
      onCopy={async () => {
        const copied = (await t.submit(
          "copy",
          {},
          selected.id,
          selected.version,
        )) as FootballSession | undefined;
        if (copied) {
          setModal({ kind: "edit", initial: copied });
          onNavigate("calendar", { session: copied.id, date: day, view });
        }
      }}
      onCancel={() => setModal({ kind: "cancel", initial: selected })}
      onViewDate={() => {
        setPanelOpen(false);
        onNavigate("calendar", {
          session: selected.id,
          date: selected.startAt ? sessionDay(selected, timezone) : day,
          view: "Week",
        });
      }}
    />
  ) : (
    <div className="pc-empty-panel">
      {sessionId && (
        <button
          className="pc-icon"
          aria-label="Close unavailable session details"
          onClick={() => setPanelOpen(false)}
        >
          <X size={20} />
        </button>
      )}
      <CalendarDays size={32} />
      <h2>{sessionId ? "Session unavailable" : "Your session details"}</h2>
      <p>
        {sessionId
          ? "This session is no longer accessible in this academy. Choose an assigned session."
          : "Select a session to see the plan, roster and preparation."}
      </p>
    </div>
  );
  return (
    <section
      className={`portal-calendar ${panelOpen ? "pc-panel-open" : ""}`}
      aria-labelledby="pc-heading"
      onFocusCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.currentTarget.contains(event.target)
        )
          lastFocused.current = event.target;
      }}
    >
      <div className="pc-workspace">
        <header className="pc-heading">
          <div>
            <h1 id="pc-heading">Calendar</h1>
            <p>
              Plan sessions, manage your week and keep every batch on track.
            </p>
          </div>
          <div className="pc-heading-actions">
            {w.data && (
              <ClosedDaysManager
                data={w.data}
                submit={t.submit}
                busy={w.busy}
                today={today}
              />
            )}
            <button onClick={() => setModal({ kind: "series" })}>
              <Repeat size={16} /> Repeat weekly
            </button>
            <button
              className="pc-primary"
              onClick={() => setModal({ kind: "new" })}
            >
              <Plus size={18} /> Create session
            </button>
          </div>
        </header>
        {w.data && <ClosedDaysBanner data={w.data} today={today} />}
        {w.data && <CalendarLinkCard workspace={w} />}
        <div className="pc-toolbar">
          <div className="pc-date-controls">
            <button
              onClick={() => {
                onNavigate("calendar", {
                  session: sessionId,
                  date: today,
                  view,
                });
              }}
            >
              Today
            </button>
            <button
              className="pc-icon"
              aria-label={`Previous ${view === "Month" ? "month" : "week"}`}
              onClick={() => move(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <strong>{label}</strong>
            <button
              className="pc-icon"
              aria-label={`Next ${view === "Month" ? "month" : "week"}`}
              onClick={() => move(1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="pc-segments" aria-label="Calendar view">
            {(["Week", "Month", "Agenda"] as const).map((item) => (
              <button
                key={item}
                aria-pressed={view === item}
                onClick={() => {
                  onNavigate("calendar", {
                    session: sessionId,
                    date: day,
                    view: item,
                  });
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="pc-filters">
          <label>
            <span className="pc-sr">Batch</span>
            <select
              aria-label="Batch"
              value={batch}
              onChange={(event) => {
                onNavigate("calendar", { batch: event.target.value });
              }}
            >
              <option value="">All batches</option>
              {d.records.squad.map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="pc-sr">Coach</span>
            <select
              aria-label="Coach"
              value={coach}
              onChange={(event) => {
                onNavigate("calendar", { coach: event.target.value });
              }}
            >
              <option value="">All coaches</option>
              {d.members
                .filter(
                  (member) =>
                    member.active &&
                    ["COACH", "OWNER", "ADMIN"].includes(member.role),
                )
                .map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span className="pc-sr">Session status</span>
            <select
              aria-label="Session status"
              value={status}
              onChange={(event) => {
                onNavigate("calendar", { sessionStatus: event.target.value });
              }}
            >
              <option value="">All statuses</option>
              {[
                "DRAFT",
                "SCHEDULED",
                "IN_PROGRESS",
                "COMPLETED",
                "CANCELLED",
              ].map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="pc-sr">Venue or zone</span>
            <select
              aria-label="Venue or zone"
              value={venue}
              onChange={(event) => {
                onNavigate("calendar", { venue: event.target.value });
              }}
            >
              <option value="">All venues &amp; zones</option>
              {d.records.venue.map((space) => {
                const parent = d.records.venue.find(
                  (candidate) => candidate.id === space.parentVenueId,
                );
                return (
                  <option key={space.id} value={space.id}>
                    {parent ? `${parent.name} · ${space.name}` : space.name}
                  </option>
                );
              })}
            </select>
          </label>
          <span className="pc-timezone">{timezone}</span>
        </div>
        <p role="status" className="pc-notice">
          {t.notice}
        </p>
        <div
          className={`pc-calendar pc-view-${view.toLowerCase()}`}
          role="region"
          aria-label={`Calendar, ${view.toLowerCase()} view`}
          tabIndex={0}
        >
          {view === "Week" && (
            <WeekGrid
              days={weekDays}
              sessions={visible}
              timezone={timezone}
              today={today}
              selectedId={sessionId}
              selectedDay={day}
              title={title}
              choose={choose}
              preferences={d.academy}
            />
          )}
          {view === "Month" && (
            <>
              <div className="pc-month-head">
                {weekdays.map((value) => (
                  <span key={value}>{value}</span>
                ))}
              </div>
              <div className="pc-month-grid">
                {monthDays.map((date) => (
                  <div
                    className={`${date.slice(0, 7) !== day.slice(0, 7) ? "pc-other-month" : ""} ${date === today ? "pc-today" : ""}`}
                    key={date}
                  >
                    <strong>{Number(date.slice(8))}</strong>
                    {dated
                      .filter(
                        (session) => sessionDay(session, timezone) === date,
                      )
                      .map((session) => (
                        <button
                          className={`pc-month-event pc-${sessionTone(session)}`}
                          key={session.id}
                          data-session-id={session.id}
                          onClick={() => choose(session)}
                        >
                          {clock(
                            session.startAt,
                            timezone,
                            d.academy.timeFormat,
                          )}{" "}
                          · {title(session)}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            </>
          )}
          {view === "Agenda" && (
            <Agenda
              sessions={visible}
              timezone={timezone}
              title={title}
              choose={choose}
              preferences={d.academy}
            />
          )}
        </div>
        {!visible.length && (
          <p className="pc-empty">
            No dated sessions match this period and filters. Add a session or
            choose another week.
          </p>
        )}
        {filtered.some((session) => !session.startAt) && (
          <details className="pc-undated">
            <summary>
              Unscheduled drafts (
              {filtered.filter((session) => !session.startAt).length})
            </summary>
            {filtered
              .filter((session) => !session.startAt)
              .map((session) => (
                <button key={session.id} onClick={() => choose(session)}>
                  {title(session)} · {sessionSummary(session)} · Date not set
                </button>
              ))}
          </details>
        )}
        <footer className="pc-legend">
          <span>
            <i />
            Training
          </span>
          <span>
            <i className="pc-draft-dot" />
            Draft
          </span>
          <span>
            <i className="pc-cancel-dot" />
            Cancelled
          </span>
          <small>
            {visible.length} session{visible.length === 1 ? "" : "s"} in this
            period
          </small>
        </footer>
      </div>
      <aside className="pc-desktop-panel">
        {panelOpen || !selected ? (
          panel
        ) : (
          <div className="pc-empty-panel">
            <CalendarDays size={32} />
            <h2>Your session details</h2>
            <p>Select a session to see the plan, roster and preparation.</p>
          </div>
        )}
      </aside>
      {mobilePanel && (
        <Dialog.Root
          open={panelOpen}
          onOpenChange={(open) => {
            if (confirmUnsavedChanges()) setPanelOpen(open);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="pc-sheet-overlay" />
            <Dialog.Content
              className="pc-mobile-panel"
              onCloseAutoFocus={restoreFocus}
            >
              <Dialog.Title className="pc-sr">Session details</Dialog.Title>
              <Dialog.Description className="pc-sr">
                The selected academy session, roster and plan.
              </Dialog.Description>
              {panel}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      <Dialog.Root
        open={Boolean(modal)}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="pc-modal-overlay" />
          <Dialog.Content
            className="pc-dialog"
            onCloseAutoFocus={restoreFocus}
            onEscapeKeyDown={(event) => {
              if (w.busy) event.preventDefault();
            }}
          >
            <Dialog.Title>
              {modal?.kind === "new"
                ? "Add a session"
                : modal?.kind === "series"
                  ? "Repeat weekly"
                  : modal?.kind === "cancel"
                    ? "Cancel session"
                    : modal?.kind === "reschedule"
                      ? "Reschedule session"
                      : "Edit session draft"}
            </Dialog.Title>
            <Dialog.Description>
              Changes are saved to {d.academy.name}.
            </Dialog.Description>
            <button
              className="pc-dialog-close pc-icon"
              aria-label="Close editor"
              disabled={w.busy}
              onClick={closeModal}
            >
              <X size={21} />
            </button>
            {modal &&
              (modal.kind === "series" ? (
                <RecurringSessionForm
                  workspace={w}
                  submit={t.submit}
                  onDone={() => setModal(null)}
                />
              ) : modal.kind === "new" || modal.kind === "edit" ? (
                <SessionEditor
                  key={modal.initial?.id ?? "new"}
                  workspace={w}
                  submit={t.submit}
                  initial={modal.initial}
                  onSaved={(saved) => {
                    setModal(null);
                    if (modal.kind === "new") {
                      onNavigate("training", {
                        session: saved.id,
                        savedDraft: saved.id,
                      });
                    } else {
                      onNavigate("calendar", {
                        session: saved.id,
                        date: sessionDay(saved, timezone) || day,
                        view,
                      });
                    }
                  }}
                />
              ) : modal.initial ? (
                <SessionChange
                  workspace={w}
                  submit={t.submit}
                  session={modal.initial}
                  cancel={modal.kind === "cancel"}
                  onSaved={() => setModal(null)}
                />
              ) : null)}
            <p role="status">{t.notice}</p>
            {w.error && <p role="alert">{w.error}</p>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function WeekGrid({
  days,
  sessions,
  timezone,
  today,
  selectedId,
  selectedDay,
  title,
  choose,
  preferences,
}: {
  days: string[];
  sessions: FootballSession[];
  timezone: string;
  today: string;
  selectedId: string;
  selectedDay: string;
  title: (session: FootballSession) => string;
  choose: (session: FootballSession, visibleDay?: string) => void;
  preferences: AcademyConfiguration;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  const pixelsPerHour = 42;
  const segments = days.flatMap((date) =>
    sessions
      .map((session) => sessionSegmentForDay(session, date, timezone))
      .filter((segment) => segment !== undefined),
  );
  const min = Math.min(
      8 * 60,
      ...segments.map((segment) => segment.startMinute),
    ),
    max = Math.max(21 * 60, ...segments.map((segment) => segment.endMinute));
  const first = Math.floor(min / 60),
    last = Math.ceil(max / 60),
    height = (last - first) * pixelsPerHour;
  const selected = sessions.find((session) => session.id === selectedId),
    selectedStart = selected?.startAt,
    selectedEnd = selected?.endAt,
    firstDay = days[0];
  useEffect(() => {
    const viewport = timeline.current;
    if (!viewport || !selectedId) return;
    const revealSelected = () => {
      const events = Array.from(
        viewport.querySelectorAll<HTMLButtonElement>("button[data-session-id]"),
      ).filter((event) => event.dataset.sessionId === selectedId);
      const event =
        events.find((event) => event.dataset.sessionDate === selectedDay) ??
        events[0];
      if (!event) return;
      const bounds = viewport.getBoundingClientRect(),
        target = event.getBoundingClientRect();
      if (target.top < bounds.top || target.bottom > bounds.bottom)
        viewport.scrollTop += target.top - bounds.top - 20;
    };
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [selectedId, selectedDay, selectedStart, selectedEnd, firstDay, height]);
  return (
    <>
      <div className="pc-week-header">
        <span />
        <div className="pc-week-days">
          {days.map((date) => (
            <div key={date} className={date === today ? "pc-today" : ""}>
              <span>
                {new Intl.DateTimeFormat("en-GB", {
                  weekday: "short",
                  timeZone: "UTC",
                }).format(new Date(`${date}T12:00:00Z`))}
              </span>
              <strong>{Number(date.slice(8))}</strong>
            </div>
          ))}
        </div>
      </div>
      <div className="pc-week-scroll" ref={timeline}>
        <div className="pc-time-grid" style={{ height }}>
          <div className="pc-hours">
            {Array.from({ length: last - first + 1 }, (_, index) => (
              <span key={index} style={{ top: index * pixelsPerHour }}>
                {new Intl.DateTimeFormat("en-US", {
                  hour: "numeric",
                  timeZone: "UTC",
                }).format(new Date(Date.UTC(2026, 0, 1, first + index)))}
              </span>
            ))}
          </div>
          <div className="pc-week-columns">
            {days.map((date) => {
              const daily = sessions.filter((session) =>
                sessionSegmentForDay(session, date, timezone),
              );
              const columns = calendarColumns(daily);
              return (
                <div
                  className={`pc-day-column ${date === today ? "pc-today" : ""}`}
                  key={date}
                  style={{ backgroundSize: `100% ${pixelsPerHour}px` }}
                >
                  {daily.map((session) => {
                    const position = columns.get(session.id)!,
                      segment = sessionSegmentForDay(session, date, timezone)!,
                      start = segment.startMinute,
                      end = segment.endMinute;
                    return (
                      <button
                        key={session.id}
                        data-session-id={session.id}
                        data-session-date={date}
                        className={`pc-event pc-${sessionTone(session)} ${selectedId === session.id ? "pc-selected" : ""}`}
                        onClick={() => choose(session, date)}
                        style={{
                          top: ((start - first * 60) / 60) * pixelsPerHour,
                          minHeight: 42,
                          height: Math.max(
                            42,
                            ((end - start) / 60) * pixelsPerHour,
                          ),
                          left: `calc(${(position.column / position.columns) * 100}% + 3px)`,
                          width: `calc(${100 / position.columns}% - 6px)`,
                        }}
                      >
                        <strong>{title(session)}</strong>
                        {segment.continuesFromPreviousDay && (
                          <small>Continued from previous day</small>
                        )}
                        <span>{sessionSummary(session)}</span>
                        <small>
                          {clock(
                            session.startAt,
                            timezone,
                            preferences.timeFormat,
                          )}{" "}
                          –{" "}
                          {clock(
                            session.endAt,
                            timezone,
                            preferences.timeFormat,
                          )}
                        </small>
                        <small>{session.location}</small>
                        {segment.continuesToNextDay && (
                          <small>Continues next day</small>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function Agenda({
  sessions,
  timezone,
  title,
  choose,
  preferences,
}: {
  sessions: FootballSession[];
  timezone: string;
  title: (session: FootballSession) => string;
  choose: (session: FootballSession) => void;
  preferences: AcademyConfiguration;
}) {
  return (
    <div className="pc-agenda">
      {Array.from(
        new Set(sessions.map((session) => sessionDay(session, timezone))),
      ).map((date) => (
        <section key={date}>
          <h2>{dayLabel(date, false, preferences.dateFormat)}</h2>
          {sessions
            .filter((session) => sessionDay(session, timezone) === date)
            .map((session) => (
              <button
                key={session.id}
                data-session-id={session.id}
                className={`pc-agenda-event pc-${sessionTone(session)}`}
                onClick={() => choose(session)}
              >
                <time>
                  {clock(session.startAt, timezone, preferences.timeFormat)}
                  <small>
                    {clock(session.endAt, timezone, preferences.timeFormat)}
                  </small>
                </time>
                <span>
                  <strong>
                    {title(session)} · {sessionSummary(session)}
                  </strong>
                  <small>
                    {session.location} · {session.roster.length} players
                  </small>
                </span>
                <span className="pc-status">{statusLabel(session.status)}</span>
                <ChevronRight size={18} />
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}

function SessionPanel({
  workspace: w,
  submit,
  session: session,
  tab,
  onTab,
  onClose,
  onOpen,
  onEdit,
  onCopy,
  onCancel,
  onViewDate,
}: {
  workspace: PortalController;
  submit: TrainingSubmit;
  session: FootballSession;
  tab: string;
  onTab: (tab: string) => void;
  onClose: () => void;
  onOpen: (desk?: string) => void;
  onEdit: () => void;
  onCopy: () => void;
  onCancel: () => void;
  onViewDate: () => void;
}) {
  const d = w.data!,
    batch = d.records.squad.find((squad) => squad.id === session.squadId),
    // The open session's attendance and notes are read for that session
    // only, not with every session of the academy.
    attendanceRead = useSessionAttendance(w, session.id),
    evidenceRead = useSessionEvidence(w, session.id),
    attendance = attendanceRead.data ?? [],
    evidence = evidenceRead.data ?? [],
    editable = ["DRAFT", "SCHEDULED"].includes(session.status);
  return (
    <div className="pc-panel" data-session-id={session.id}>
      <header>
        <div>
          <span className="pc-eyebrow">Session details</span>
          <h2>{batch?.name ?? "Archived batch"}</h2>
          <p>{sessionSummary(session)}</p>
        </div>
        <button
          className="pc-icon"
          aria-label="Close session details"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <span className={`pc-status pc-${sessionTone(session)}`}>
        {statusLabel(session.status)}
      </span>
      <div className="pc-session-facts">
        <p>
          <CalendarDays size={17} />
          {dayLabel(
            session.startLocal.slice(0, 10),
            true,
            d.academy.dateFormat,
          )}
        </p>
        <p>
          <Clock3 size={17} />
          {session.startAt
            ? `${clock(session.startAt, session.timezone, d.academy.timeFormat)} – ${clock(session.endAt, session.timezone, d.academy.timeFormat)}`
            : "Date not set"}
        </p>
        <p className="pc-small">{session.timezone}</p>
        <p>
          <MapPin size={17} />
          {session.location || "Location not set"}
        </p>
      </div>
      <div className="pc-panel-actions">
        <button className="pc-primary" onClick={() => onOpen()}>
          Open session
        </button>
        <button disabled={!editable || w.busy} onClick={onEdit}>
          <Pencil size={15} />
          {session.status === "DRAFT" ? "Edit" : "Reschedule"}
        </button>
      </div>
      <div className="pc-panel-tabs" aria-label="Session detail sections">
        {["Details", "Players", "Plan", "Attendance", "Notes"].map((item) => (
          <button
            key={item}
            aria-pressed={tab === item}
            onClick={() => onTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="pc-panel-content">
        {tab === "Details" && (
          <>
            <dl className="pc-detail-list">
              <div>
                <dt>
                  <CalendarDays aria-hidden="true" />
                  Batch
                </dt>
                <dd>{batch?.name ?? "Archived batch"}</dd>
              </div>
              <div>
                <dt>
                  <UserRound aria-hidden="true" />
                  Coach
                </dt>
                <dd>
                  {session.coachIds
                    .map(
                      (id) =>
                        d.members.find((member) => member.userId === id)
                          ?.name ?? "Assigned coach",
                    )
                    .join(", ")}
                </dd>
              </div>
              <div>
                <dt>
                  <Cone aria-hidden="true" />
                  Session type
                </dt>
                <dd>Football training</dd>
              </div>
              <div>
                <dt>
                  <Users aria-hidden="true" />
                  Players
                </dt>
                <dd>{session.roster.length} in session roster</dd>
              </div>
            </dl>
            <SeriesSummary workspace={w} session={session} submit={submit} />
            <article className="pc-focus">
              <Target aria-hidden="true" />
              <div>
                <h3>Training focus</h3>
                <strong>{sessionFocus(session)}</strong>
                <p>
                  {session.sharedObjective?.cue ??
                    "The whole batch follows the session plan."}
                </p>
              </div>
            </article>
            <article className="pc-preparation">
              <ClipboardList aria-hidden="true" />
              <div>
                <h3>Preparation</h3>
                {session.preparation?.length ? (
                  <ul>
                    {session.preparation.map((item, index) => (
                      <li key={index}>
                        <CircleCheck size={14} aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No preparation instructions recorded.</p>
                )}
              </div>
            </article>
            {!session.venueId && (
              <p className="pc-small">
                This legacy session records a location. Space availability
                cannot be checked until a configured venue is assigned.
              </p>
            )}
            <AddToCalendar
              session={session}
              batchName={batch?.name ?? "Training"}
            />
            {session.status !== "DRAFT" && (
              <SessionShare workspace={w} sessionId={session.id} />
            )}
          </>
        )}
        {tab === "Players" && (
          <>
            <h3>Session roster · {session.roster.length}</h3>
            {session.roster.length ? (
              <ul className="pc-roster">
                {session.roster.map((player) => (
                  <li key={player.playerId}>
                    <span className="pc-avatar">
                      {player.name
                        .split(" ")
                        .map((value) => value[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span>{player.name}</span>
                    <small>
                      {attendanceRead.data
                        ? (attendance
                            .find(
                              (record) => record.playerId === player.playerId,
                            )
                            ?.status.toLowerCase() ?? "Not recorded")
                        : "Loading…"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No players are recorded for this session.</p>
            )}
            <p className="pc-small">
              The session roster is a dated snapshot of the batch.
            </p>
          </>
        )}
        {tab === "Plan" && (
          <>
            <h3>Shared batch plan</h3>
            <p>{sessionFocus(session)}</p>
            {session.agenda.map((item, index) => (
              <article
                className="pc-agenda-card"
                key={`${item.drill.id}-${index}`}
              >
                <strong>
                  {index + 1}. {item.drill.name}
                </strong>
                <span>{item.duration} min</span>
                <p>{item.drill.cue}</p>
              </article>
            ))}
            <p className="pc-small">
              Personalisation is optional. Existing player goals can be reused
              in the Session desk.
            </p>
          </>
        )}
        {tab === "Attendance" && (
          <>
            <h3>Attendance</h3>
            {attendanceRead.error ? (
              <p role="alert">{attendanceRead.error}</p>
            ) : !attendanceRead.data ? (
              <p role="status">Loading attendance…</p>
            ) : null}
            <p hidden={!attendanceRead.data}>
              {
                attendance.filter((record) => record.status === "PRESENT")
                  .length
              }{" "}
              present ·{" "}
              {attendance.filter((record) => record.status === "ABSENT").length}{" "}
              absent ·{" "}
              {
                attendance.filter((record) => record.status === "EXCUSED")
                  .length
              }{" "}
              excused ·{" "}
              {
                attendance.filter((record) => record.status === "UNMARKED")
                  .length
              }{" "}
              unmarked
            </p>
            <p className="pc-small">
              Mark or correct attendance in the Session desk. Completed records
              retain their correction history.
            </p>
            <button onClick={() => onOpen("Attendance")}>
              Open attendance desk
            </button>
          </>
        )}
        {tab === "Notes" && (
          <>
            <h3>Private coach notes</h3>
            {evidenceRead.error ? (
              <p role="alert">{evidenceRead.error}</p>
            ) : !evidenceRead.data ? (
              <p role="status">Loading notes…</p>
            ) : evidence.filter((record) => record.staffNote).length ? (
              evidence
                .filter((record) => record.staffNote)
                .map((record) => (
                  <article className="pc-note" key={record.id}>
                    <strong>
                      {session.roster.find(
                        (player) => player.playerId === record.playerId,
                      )?.name ?? "Session player"}
                    </strong>
                    <p>{record.staffNote}</p>
                    <small>{statusLabel(record.status)}</small>
                  </article>
                ))
            ) : (
              <p>No private observation notes recorded.</p>
            )}
            <p className="pc-small">
              Notes stay in the staff workspace. Parent updates require the
              existing review and approval process.
            </p>
            <button onClick={() => onOpen("Evidence")}>
              Record an observation
            </button>
          </>
        )}
      </div>
      <footer>
        <button onClick={onViewDate}>
          <CalendarDays size={15} />
          View in calendar
        </button>
        <button disabled={w.busy} onClick={onCopy}>
          <Copy size={15} />
          Copy session
        </button>
        <button
          className="pc-danger"
          disabled={
            !["DRAFT", "SCHEDULED", "IN_PROGRESS"].includes(session.status) ||
            w.busy
          }
          onClick={onCancel}
        >
          Cancel session
        </button>
      </footer>
    </div>
  );
}

export function SessionChange({
  workspace: w,
  submit,
  session,
  cancel,
  onSaved,
}: {
  workspace: PortalController;
  submit: TrainingSubmit;
  session: FootballSession;
  cancel: boolean;
  onSaved: () => void;
}) {
  const [start, setStart] = useState(session.startLocal),
    [end, setEnd] = useState(session.endLocal),
    [venueId, setVenueId] = useState(session.venueId ?? ""),
    [location, setLocation] = useState(session.location),
    [coaches, setCoaches] = useState(session.coachIds),
    [reason, setReason] = useState(""),
    [scope, setScope] = useState<"one" | "series">("one"),
    [cancelled, setCancelled] = useState<FootballSeries>();
  // A session of an active weekly series can be cancelled alone or with the
  // whole series; the series is offered only to someone who can see it.
  const series = cancel
    ? w.data!.records.series.find(
        (item) => item.id === session.seriesId && item.status === "ACTIVE",
      )
    : undefined;
  const upcoming = series
    ? w.data!.records.session.filter(
        (item) =>
          item.seriesId === series.id &&
          ["DRAFT", "SCHEDULED"].includes(item.status) &&
          item.startAt > new Date().toISOString(),
      ).length
    : 0;
  useUnsavedChanges(
    Boolean(reason) ||
      start !== session.startLocal ||
      end !== session.endLocal ||
      venueId !== (session.venueId ?? "") ||
      location !== session.location ||
      JSON.stringify(coaches) !== JSON.stringify(session.coachIds),
  );
  if (cancelled)
    return (
      <div className="pc-change-form">
        <p>
          <strong>The weekly series is cancelled.</strong>
        </p>
        <CancelOutcome series={cancelled} />
        <button className="pc-primary" onClick={onSaved}>
          Done
        </button>
      </div>
    );
  return (
    <form
      className="pc-change-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (cancel && series && scope === "series") {
          const result = (await submit(
            "seriesCancel",
            { reason },
            series.id,
            series.version,
          )) as FootballSeries | undefined;
          if (result) {
            // The reason is saved; do not warn about unsaved changes on close.
            setReason("");
            setCancelled(result);
          }
          return;
        }
        const result = cancel
          ? await submit(
              "status",
              { status: "CANCELLED", reason },
              session.id,
              session.version,
            )
          : await submit(
              "reschedule",
              {
                startLocal: start,
                endLocal: end,
                timezone: session.timezone,
                location,
                venueId: venueId || undefined,
                coachIds: coaches,
                reason,
              },
              session.id,
              session.version,
            );
        if (result) onSaved();
      }}
    >
      {series && (
        <fieldset className="sx-choice">
          <legend>What do you want to cancel?</legend>
          <label className="check-row">
            <input
              type="radio"
              name="cancel-scope"
              checked={scope === "one"}
              onChange={() => setScope("one")}
            />
            Only this session ({displayDay(session.startLocal)})
          </label>
          <label className="check-row">
            <input
              type="radio"
              name="cancel-scope"
              checked={scope === "series"}
              onChange={() => setScope("series")}
            />
            The whole weekly series ({upcoming} upcoming{" "}
            {upcoming === 1 ? "session" : "sessions"})
          </label>
          <p className="sx-small">
            Sessions already started or finished are never changed. Linked
            parents are told by email where email is enabled: once for a
            single session, one summary for a whole series.
          </p>
        </fieldset>
      )}
      <p>
        {cancel
          ? "The session and its history will be retained as cancelled. Affected unpublished weekly approvals and queued messages will be invalidated."
          : "The same session and roster are retained. Coach, player and configured space conflicts are checked before the change is accepted."}
      </p>
      {!cancel && (
        <>
          <label>
            Session start
            <input
              required
              type="datetime-local"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Session end
            <input
              required
              type="datetime-local"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <p>{session.timezone}</p>
          <label>
            Training space
            <select
              aria-label="Training space"
              value={venueId}
              onChange={(event) => {
                setVenueId(event.target.value);
                setLocation(
                  w.data!.records.venue.find(
                    (venue) => venue.id === event.target.value,
                  )?.location ?? location,
                );
              }}
            >
              <option value="">Recorded location</option>
              {w
                .data!.records.venue.filter(
                  (venue) => venue.branchId === session.branchId,
                )
                .map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
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
            <legend>Assigned coaches</legend>
            {w
              .data!.members.filter(
                (member) =>
                  member.active &&
                  ["COACH", "OWNER", "ADMIN"].includes(member.role),
              )
              .map((member) => (
                <label className="check-row" key={member.userId}>
                  <input
                    type="checkbox"
                    checked={coaches.includes(member.userId)}
                    onChange={(event) =>
                      setCoaches(
                        event.target.checked
                          ? [...coaches, member.userId]
                          : coaches.filter((id) => id !== member.userId),
                      )
                    }
                  />
                  {member.name}
                </label>
              ))}
          </fieldset>
        </>
      )}
      <label>
        {cancel ? "Cancellation reason" : "Reason for change"}
        <textarea
          required
          minLength={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button
        className={cancel ? "pc-danger-button" : "pc-primary"}
        disabled={w.busy || (!cancel && !coaches.length)}
      >
        {cancel ? "Confirm cancellation" : "Save new schedule"}
      </button>
    </form>
  );
}
