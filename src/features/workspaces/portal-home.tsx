"use client";
import Image from "next/image";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  Clock3,
  FileText,
  Lightbulb,
  MapPin,
  MessageSquare,
  UserPlus,
  UserRoundPlus,
  Users,
  Target,
  BookOpen,
  WalletCards,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { PortalLoading } from "./portal-loading";
import "./portal-setup.css";
import {
  portalDate,
  academyDate,
  academyGreeting,
} from "@/services/portal-records";
import { sessionHeading } from "@/services/session-display";
import { useHomeSummary } from "@/hooks/use-home-summary";
import type { PortalController, PortalNavigate } from "./portal-types";
import { useFinance } from "@/hooks/use-finance";

function OwnerFinanceAction({
  workspace: w,
  onNavigate,
}: {
  workspace: PortalController;
  onNavigate: PortalNavigate;
}) {
  const f = useFinance(w);
  const outstanding = f.data?.invoices.filter(
    (i) => i.outstandingMinor > 0,
  ).length;
  const pending = f.data?.payments.filter((p) => p.status === "PENDING").length;
  return (
    <button className="portal-home-activity" onClick={() => onNavigate("fees")}>
      <span className="portal-round amber">
        <WalletCards size={19} />
      </span>
      <span>
        <strong>
          {f.data
            ? `${outstanding} outstanding invoices`
            : f.error
              ? "Fee accounts unavailable"
              : "Loading fee accounts…"}
        </strong>
        {f.data && (
          <small>{pending} payment references awaiting verification</small>
        )}
      </span>
      <ArrowRight size={16} />
    </button>
  );
}

function HomeCard({
  title,
  action,
  onAction,
  children,
  className = "",
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section className={`portal-card ${className}`} aria-labelledby={headingId}>
      <div className="portal-card-heading">
        <h2 id={headingId}>{title}</h2>
        {onAction && (
          <button
            className="portal-link"
            aria-describedby={headingId}
            onClick={onAction}
          >
            {action ?? "View all"}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
/** The current time, refreshed every minute so the greeting follows the clock. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function PortalHome({
  workspace: w,
  onNavigate,
}: {
  workspace: PortalController;
  onNavigate: PortalNavigate;
}) {
  const d = w.shell!,
    { summary, error } = useHomeSummary(w),
    now = useNow();
  const name = d.viewer?.name.split(" ")[0] ?? "there",
    coach = d.membership.role === "COACH",
    owner = ["OWNER", "ADMIN"].includes(d.membership.role);
  if (!summary)
    return (
      <div className="portal-home-page" aria-busy={!error}>
        <div className="portal-page-heading">
          <div>
            <h1>
              {academyGreeting(d, now)}, {coach ? "Coach " : ""}
              {name}
            </h1>
          </div>
        </div>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <PortalLoading label="Loading your academy summary…" />
        )}
      </div>
    );
  const session = summary.nextSession;
  // The first-run path of a new academy. Owners and admins only: a coach cannot create batches, and a family is not shown it.
  const setupSteps = [
    {
      done: summary.activePlayers > 0,
      label: "Add your first player",
      go: () => onNavigate("players", { create: "player" }),
    },
    {
      done: summary.batches > 0,
      label: "Set up a batch and venue",
      go: () => onNavigate("training", { create: "setup" }),
    },
    {
      done: summary.upcomingSessions > 0 || summary.todaySessions.length > 0,
      label: "Create your first session",
      go: () => onNavigate("training", { create: "session" }),
    },
  ];
  const setupDone = setupSteps.filter((step) => step.done).length;
  const recent = summary.recent.map((r) =>
    r.kind === "EVIDENCE"
      ? {
          id: r.id,
          title: `Reviewed observation · ${r.playerName ?? "Authorised player"}`,
          date: r.date,
          go: () =>
            onNavigate("training", {
              session: r.sessionId,
              player: r.playerId,
            }),
        }
      : {
          id: r.id,
          title: `${r.subject} · ${r.playerName ?? "Player"}`,
          date: r.date,
          go: () => onNavigate("messages", { player: r.playerId }),
        },
  );
  const {
    month,
    total: monthTotal,
    approved: monthApproved,
  } = summary.reportsThisMonth;
  return (
    <div className="portal-home-page">
      <div className="portal-page-heading">
        <div>
          <h1>
            {academyGreeting(d, now)}, {coach ? "Coach " : ""}
            {name}
          </h1>
          <p>
            {coach
              ? "Let’s build better players today."
              : "Your academy’s sessions, reviews and next steps."}
          </p>
        </div>
        <time dateTime={academyDate(d, now)}>
          {portalDate(now.toISOString(), d)}
        </time>
      </div>
      {owner && setupDone < setupSteps.length && (
        <HomeCard title="Set up your academy" className="portal-home-setup">
          <p className="portal-setup-intro">
            {setupDone} of {setupSteps.length} steps done.
          </p>
          <ol className="portal-setup-steps">
            {setupSteps.map((step) => (
              <li key={step.label} className={step.done ? "done" : ""}>
                {step.done ? (
                  <>
                    <CheckCircle2 size={20} aria-hidden="true" />
                    <span>{step.label}</span>
                    <span className="portal-setup-state">Done</span>
                  </>
                ) : (
                  <>
                    <Circle size={20} aria-hidden="true" />
                    <button className="button secondary" onClick={step.go}>
                      {step.label}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        </HomeCard>
      )}
      <div className="portal-home-top">
        <section className="portal-home-hero" aria-labelledby="home-hero-title">
          <Image
            src="/portal/football-session.png"
            fill
            alt=""
            sizes="(max-width: 767px) 100vw, 55vw"
            unoptimized
            priority
          />
          <div className="portal-home-hero-content">
            <span>
              {session &&
              academyDate(d, new Date(session.startAt)) === summary.today
                ? "Today’s session"
                : "Next training session"}
            </span>
            <h2 id="home-hero-title">
              {session
                ? sessionHeading(session, session.batchName)
                : "Your next session starts here"}
            </h2>
            {session ? (
              <>
                <p>
                  <Clock3 size={17} />
                  {portalDate(session.startAt, d, true)} –{" "}
                  {portalDate(session.endAt, d, true)}
                  {academyDate(d, new Date(session.startAt)) !==
                    summary.today && ` · ${portalDate(session.startAt, d)}`}
                </p>
                <p>
                  <MapPin size={17} />
                  {session.location}
                </p>
                <small>
                  <Users size={15} />
                  {session.rosterCount} players · {session.batchName}
                </small>
                <button
                  className="button primary"
                  onClick={() =>
                    onNavigate("training", { session: session.id })
                  }
                >
                  {session.status === "IN_PROGRESS"
                    ? "Continue session"
                    : "Open session"}
                  <ArrowRight size={19} />
                </button>
              </>
            ) : (
              <>
                <p>Create a dated session for an academy batch.</p>
                <button
                  className="button primary"
                  onClick={() => onNavigate("training", { create: "session" })}
                >
                  Create session <ArrowRight size={19} />
                </button>
              </>
            )}
          </div>
        </section>
        <HomeCard
          title="Today’s schedule"
          action="View calendar"
          onAction={() => onNavigate("calendar")}
          className="portal-home-schedule"
        >
          {summary.todaySessions.length ? (
            summary.todaySessions.slice(0, 3).map((s) => (
              <button
                className="portal-schedule-row"
                key={s.id}
                onClick={() => onNavigate("calendar", { session: s.id })}
              >
                <span className="portal-schedule-dot" />
                <time>{portalDate(s.startAt, d, true)}</time>
                <span>
                  <strong>{sessionHeading(s, s.batchName)}</strong>
                  <small>{s.location}</small>
                </span>
                <span className="portal-status muted">
                  {s.status === "COMPLETED" ? "Completed" : "Today"}
                </span>
              </button>
            ))
          ) : (
            <div className="portal-home-no-schedule">
              <CalendarDays size={30} />
              <strong>No sessions scheduled today</strong>
              <p>
                {summary.upcomingSessions
                  ? `${summary.upcomingSessions} upcoming confirmed sessions`
                  : "Your calendar is ready when you are."}
              </p>
              <button
                className="portal-link"
                onClick={() => onNavigate("calendar")}
              >
                Open calendar <ArrowRight size={14} />
              </button>
            </div>
          )}
        </HomeCard>
      </div>
      <HomeCard
        title="Coming up"
        action="View calendar"
        onAction={() => onNavigate("calendar")}
        className="portal-home-coming"
      >
        {summary.comingSessions.length ? (
          <>
            {summary.comingSessions.map((s) => {
              const day = academyDate(d, new Date(s.startAt));
              return (
                <button
                  className="portal-schedule-row"
                  key={s.id}
                  onClick={() => onNavigate("calendar", { session: s.id })}
                >
                  <span className="portal-schedule-dot" />
                  <time>{portalDate(s.startAt, d, true)}</time>
                  <span>
                    <strong>{sessionHeading(s, s.batchName)}</strong>
                    <small>
                      {s.batchName ? `${s.batchName} · ` : ""}
                      {s.location}
                    </small>
                  </span>
                  <span className="portal-status muted">
                    {day === academyDate(d, new Date(now.getTime() + 864e5))
                      ? "Tomorrow"
                      : portalDate(s.startAt, d)}
                  </span>
                </button>
              );
            })}
            {summary.upcomingSessions >
              summary.comingSessions.length + summary.todaySessions.length && (
              <button
                className="portal-link"
                onClick={() => onNavigate("calendar")}
              >
                More in the calendar <ArrowRight size={14} />
              </button>
            )}
          </>
        ) : (
          <div className="portal-home-no-schedule">
            <CalendarDays size={30} />
            <strong>Nothing coming up after today</strong>
            <p>Create a session for a batch to see it here.</p>
          </div>
        )}
      </HomeCard>
      <div
        className="portal-stat-grid"
        role="group"
        aria-label="Academy at a glance"
      >
        {[
          {
            Icon: Users,
            value: summary.activePlayers,
            label: "Active players",
            note: coach ? "Your assigned players" : "Academy football players",
            tone: "",
            go: () => onNavigate("players"),
          },
          {
            Icon: CalendarDays,
            value: summary.batches,
            label: "Active batches",
            note: "Recorded football batches",
            tone: "blue",
            go: () => onNavigate("training"),
          },
          {
            Icon: ClipboardList,
            value: summary.upcomingSessions,
            label: "Upcoming sessions",
            note: "Confirmed dated sessions",
            tone: "blue",
            go: () => onNavigate("calendar"),
          },
          {
            Icon: MessageSquare,
            value: summary.openConversations,
            label: "Open conversations",
            note: "Private parent communication",
            tone: "red",
            go: () => onNavigate("messages"),
          },
        ].map(({ Icon, value, label, note, tone, go }) => (
          <button
            className="portal-card portal-stat portal-stat-button"
            key={label}
            onClick={go}
          >
            <span className={`portal-round ${tone}`}>
              <Icon size={25} />
            </span>
            <span>
              <strong>{value}</strong>
              <p>{label}</p>
              <small>{note}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="portal-home-middle">
        <HomeCard
          title="Recent activity"
          onAction={() => onNavigate("messages")}
        >
          {recent.length ? (
            recent.map((r) => (
              <button
                className="portal-home-activity"
                key={r.id}
                onClick={r.go}
              >
                <span className="portal-round">
                  <FileText size={19} />
                </span>
                <span>
                  {r.title}
                  <small>{portalDate(r.date, d)}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="portal-subtle">
              Activity appears here when a coach reviews an observation or a
              private conversation receives a message.
            </p>
          )}
        </HomeCard>
        <HomeCard
          title="Pending actions"
          onAction={() => onNavigate("training")}
        >
          {["OWNER", "ADMIN"].includes(d.membership.role) &&
            d.academy.modules.includes("fees") && (
              <OwnerFinanceAction workspace={w} onNavigate={onNavigate} />
            )}
          {[
            {
              n: summary.observationsToReview.count,
              label: "observations to review",
              Icon: Users,
              tone: "red",
              go: () =>
                onNavigate("training", {
                  session: summary.observationsToReview.firstSessionId,
                }),
            },
            {
              n: summary.reportDrafts,
              label: "report drafts",
              Icon: FileText,
              tone: "blue",
              go: () => onNavigate("reports"),
            },
            {
              n: summary.unmarkedToday.count,
              label: "attendance records unmarked today",
              Icon: CheckCircle2,
              tone: "",
              go: () =>
                onNavigate("training", {
                  session: summary.unmarkedToday.firstSessionId,
                }),
            },
          ].map(({ n, label, Icon, tone, go }) => (
            <button className="portal-home-activity" key={label} onClick={go}>
              <span className={`portal-round ${tone}`}>
                <Icon size={19} />
              </span>
              <span>
                <strong>
                  {n} {label}
                </strong>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
        </HomeCard>
        <HomeCard title="Quick actions">
          <div className={`portal-home-quick${owner ? " has-invite" : ""}`}>
            {[
              {
                label: "Create session",
                Icon: CalendarDays,
                tone: "",
                go: () => onNavigate("training", { create: "session" }),
              },
              {
                label: "Add player",
                Icon: UserRoundPlus,
                tone: "blue",
                go: () => onNavigate("players", { create: "player" }),
              },
              {
                label: "Message parent",
                Icon: MessageSquare,
                tone: "purple",
                go: () => onNavigate("messages"),
              },
              {
                label: "Prepare report",
                Icon: FileText,
                tone: "amber",
                go: () => onNavigate("reports", { prepare: "monthly" }),
              },
              // The academy owner invites coaches, parents and players from here.
              ...(owner
                ? [
                    {
                      label: "Invite people",
                      Icon: UserPlus,
                      tone: "",
                      go: () => onNavigate("settings", { tab: "team" }),
                    },
                  ]
                : []),
            ].map(({ label, Icon, tone, go }) => (
              <button
                key={label}
                className={`portal-quick-action ${tone}`}
                onClick={go}
              >
                <Icon size={25} />
                <strong>{label}</strong>
              </button>
            ))}
          </div>
        </HomeCard>
      </div>
      <div className="portal-home-bottom">
        <HomeCard
          title="Player development focus"
          action="View players"
          onAction={() => onNavigate("players")}
        >
          <div className="portal-focus">
            <span className="portal-round">
              <Target size={24} />
            </span>
            <div>
              <small>
                {summary.focus?.playerName ?? "Shared batch development"}
              </small>
              <h3>
                {summary.focus?.focus ||
                  session?.sharedObjective?.goal ||
                  "Set a focus in your next batch plan"}
              </h3>
              <p>
                {summary.focus?.observe ||
                  session?.sharedObjective?.observe ||
                  "Players follow the batch plan unless you choose an optional adjustment."}
              </p>
            </div>
          </div>
        </HomeCard>
        <HomeCard
          title="Reports this month"
          onAction={() => onNavigate("reports")}
        >
          <div className="portal-home-report-count">
            <div
              className="portal-report-ring"
              role="img"
              aria-label={`${monthApproved} of ${monthTotal} reports approved this month`}
              style={{
                background: `conic-gradient(var(--portal-green) ${monthTotal ? (360 * monthApproved) / monthTotal : 0}deg,#e6edf3 0)`,
              }}
            >
              <strong>
                {monthApproved}/{monthTotal}
              </strong>
            </div>
            <div>
              <p>
                <i className="portal-dot" aria-hidden="true" />
                {monthApproved} Approved
              </p>
              <p>
                <i className="portal-dot amber" aria-hidden="true" />
                {monthTotal - monthApproved} Awaiting review
              </p>
              <small>Report status · {month}</small>
            </div>
          </div>
          <span className="portal-subtle">
            {summary.approvedReports} approved reports in recorded history
          </span>
        </HomeCard>
        <HomeCard title="What’s next">
          <button
            className="portal-home-next"
            onClick={() => onNavigate("training", { view: "weekly" })}
          >
            <span className="portal-round">
              <Lightbulb size={23} />
            </span>
            <span>
              <strong>Prepare next week’s plan</strong>
              <small>Shared batch plan, optional player adjustments</small>
            </span>
            <ArrowRight size={17} />
          </button>
          {!summary.hasBranch && (
            <button
              className="portal-link"
              onClick={() => onNavigate("settings", { tab: "sessions" })}
            >
              <BookOpen size={15} /> Complete academy setup
            </button>
          )}
        </HomeCard>
      </div>
    </div>
  );
}
