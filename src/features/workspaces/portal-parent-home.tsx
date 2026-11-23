"use client";
import Image from "next/image";
import {
  ArrowRight,
  CalendarDays,
  ClipboardList,
  Clock3,
  MessageSquare,
  Target,
  UserRound,
  WalletCards,
} from "lucide-react";
import type { WorkspacePlayer } from "@/domain/workspace";
import {
  approvedPlayerReport,
  currentPlayerPlan,
  portalDate,
} from "@/services/portal-records";
import { useFinance } from "@/hooks/use-finance";
import { formatFinanceMoney } from "@/services/finance-rules";
import { parentCoachUpdatePreview } from "@/services/parent-coach-update";
import { PlayerAttendanceHistory } from "./attendance-history";
import { AddEventToCalendar, CalendarLinkCard } from "./session-sharing";
import "./portal-calendar.css";
import { GuardianAnnouncements } from "./guardian-announcements";
import type { PortalController, PortalNavigate } from "./portal-types";
import { displayDay, displayDayRange } from "@/services/date-display";

function ParentFeeSummary({
  workspace: w,
  player,
  onNavigate,
}: {
  workspace: PortalController;
  player: WorkspacePlayer;
  onNavigate: PortalNavigate;
}) {
  const f = useFinance(w);
  const invoices =
    f.data?.invoices.filter(
      (i) => i.playerId === player.id && i.outstandingMinor > 0,
    ) ?? [];
  if (!invoices.length) return null;
  return (
    <button
      className="portal-parent-fee"
      onClick={() => onNavigate("fees", { player: player.id })}
    >
      <span className="portal-round amber">
        <WalletCards size={20} />
      </span>
      <span>
        <strong>Fee due</strong>
        <small>
          {invoices[0].label} ·{" "}
          {formatFinanceMoney(
            invoices[0].outstandingMinor,
            invoices[0].currency,
            w.data!.academy.dateLocale,
          )}
        </small>
      </span>
      <ArrowRight size={16} />
    </button>
  );
}
export function PortalParentHome({
  workspace: w,
  player,
  onNavigate,
}: {
  workspace: PortalController;
  player?: WorkspacePlayer;
  onNavigate: PortalNavigate;
}) {
  const d = w.data!,
    name = d.viewer?.name?.split(" ")[0] ?? "there";
  const weekly = player
    ? d.records.weekly
        .filter(
          (r) =>
            r.playerId === player.id &&
            r.status === "APPROVED" &&
            r.issuedAt &&
            r.snapshot &&
            r.content.period.startAt <= new Date().toISOString() &&
            r.content.period.endAt > new Date().toISOString(),
        )
        .sort((a, b) =>
          b.content.period.startAt.localeCompare(a.content.period.startAt),
        )[0]
    : undefined;
  const report = player && approvedPlayerReport(d, player.id);
  // Parent records contain only the plan snapshots already released through
  // an approved report, never an unpublished staff working plan.
  const development = player && currentPlayerPlan(d, player.id);
  const next = player
    ? d.parentSchedule?.find(
        (s) =>
          s.childId === player.id &&
          s.status !== "CANCELLED" &&
          s.endAt >= new Date().toISOString(),
      )
    : undefined;
  const update = player
    ? d.records.update
        .filter(
          (u) =>
            u.playerId === player.id &&
            u.approvalStatus === "APPROVED" &&
            u.inAppPublicationStatus === "PUBLISHED" &&
            ["DEVELOPMENT", "REVIEWED_SESSION"].includes(u.type),
        )
        .sort((a, b) =>
          (b.approvedAt ?? "").localeCompare(a.approvedAt ?? ""),
        )[0]
    : undefined;
  const coachUpdate = parentCoachUpdatePreview({
    academyId: d.academy.id,
    playerId: player?.id ?? "",
    update,
    report: report || undefined,
  });
  return (
    <div className="portal-parent-home">
      <div className="portal-page-heading">
        <div>
          <h1>
            Hi {name} <span aria-hidden="true">👋</span>
          </h1>
          <p>
            {player
              ? `Here’s ${player.name.split(" ")[0]}’s latest update.`
              : "Your child’s football journey starts here."}
          </p>
        </div>
      </div>
      {d.records.player.length > 1 && (
        <label className="portal-child-selector">
          Your linked child
          <select
            value={player?.id ?? ""}
            onChange={(e) =>
              onNavigate("home", {
                player: e.target.value,
                report: "",
                session: "",
              })
            }
          >
            {!player && <option value="">Choose your child</option>}
            {d.records.player.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!player ? (
        <div className="portal-empty">
          <UserRound size={30} />
          <h2>No linked child available</h2>
          <p>
            The academy must verify your guardian relationship and invite your
            account. Other children’s records remain private.
          </p>
        </div>
      ) : (
        <>
          <GuardianAnnouncements workspace={w} />
          <section
            className="portal-card portal-parent-focus"
            aria-labelledby="parent-focus-title"
          >
            <Image
              src="/portal/weekly-football.png"
              width={66}
              height={112}
              alt=""
              unoptimized
            />
            <div className="portal-parent-focus-label">
              <span className="portal-round">
                <CalendarDays size={18} />
              </span>
              <div>
                <h2 id="parent-focus-title">This week’s focus</h2>
                <p>
                  {weekly
                    ? `${portalDate(weekly.content.period.startAt, d)} – ${portalDate(weekly.content.period.endAt, d)}`
                    : "Awaiting coach approval"}
                </p>
              </div>
            </div>
            <h3>
              {weekly?.snapshot?.personalFocus ||
                weekly?.snapshot?.teamFocus ||
                "Your next shared training plan"}
            </h3>
            <p>
              {weekly?.snapshot?.observe ||
                "The coach will share the approved focus and practice details here."}
            </p>
            <div className="portal-parent-focus-footer">
              <span>
                <CalendarDays size={16} />
                {weekly
                  ? `${weekly.snapshot?.sessions.length ?? 0} sessions in plan`
                  : "Weekly plan pending"}
              </span>
              {development && (
                <span className="portal-parent-plan-focus">
                  <Target size={16} />
                  <span>
                    <small>Development plan</small>
                    {development.focus}
                  </span>
                </span>
              )}
              <button
                className="portal-link"
                aria-describedby="parent-focus-title"
                onClick={() =>
                  onNavigate("development", {
                    player: player.id,
                    weekly: weekly?.id,
                  })
                }
              >
                View plan <ArrowRight size={13} />
              </button>
            </div>
          </section>
          <section
            className="portal-card portal-parent-update"
            aria-labelledby="parent-update-title"
            data-coach-update-source={coachUpdate.source}
          >
            <div className="portal-parent-update-heading">
              <span className="portal-initials">
                <UserRound size={19} />
              </span>
              <h2 id="parent-update-title">Latest coach update</h2>
              <small>
                {coachUpdate.approvedAt
                  ? portalDate(coachUpdate.approvedAt, d)
                  : (coachUpdate.period ?? "")}
              </small>
            </div>
            <p>{coachUpdate.body}</p>
            <button
              className="portal-link"
              aria-describedby="parent-update-title"
              onClick={() =>
                onNavigate(coachUpdate.destination, {
                  player: player.id,
                  report: coachUpdate.reportId,
                })
              }
            >
              View full update <ArrowRight size={13} />
            </button>
          </section>
          <button
            className="portal-card portal-parent-session"
            onClick={() =>
              onNavigate("calendar", { player: player.id, session: next?.id })
            }
          >
            <span className="portal-round blue">
              <CalendarDays size={22} />
            </span>
            <span>
              <strong>Next session</strong>
              <small>
                {next
                  ? `${portalDate(next.startAt, d)} · ${portalDate(next.startAt, d, true)}`
                  : "No upcoming confirmed session"}
              </small>
              <small>
                {next?.location ??
                  "The academy will confirm your child’s schedule."}
              </small>
            </span>
            <ArrowRight size={15} />
          </button>
          {d.academy.modules.includes("fees") && (
            <ParentFeeSummary
              workspace={w}
              player={player}
              onNavigate={onNavigate}
            />
          )}
          <div
            className="portal-parent-shortcuts"
            role="group"
            aria-label="Shortcuts for your child"
          >
            <button
              onClick={() =>
                onNavigate("reports", { player: player.id, report: report?.id })
              }
            >
              <ClipboardList size={22} />
              <span>Monthly report</span>
            </button>
            <button
              onClick={() => onNavigate("practice", { player: player.id })}
            >
              <Target size={22} />
              <span>Practise together</span>
            </button>
            <button
              onClick={() => onNavigate("messages", { player: player.id })}
            >
              <MessageSquare size={22} />
              <span>Message coach</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
export function PortalParentSchedule({
  workspace: w,
  player,
  onNavigate,
}: {
  workspace: PortalController;
  player?: WorkspacePlayer;
  onNavigate: PortalNavigate;
}) {
  const d = w.data!,
    // A player's own login: first-person wording, and no link to plans (a player's login does not open them).
    own = !!d.viewer?.playerLogin,
    sessions = d.parentSchedule?.filter((s) => s.childId === player?.id) ?? [];
  return (
    <>
      <div className="portal-page-heading">
        <div>
          <h1>Training schedule</h1>
          <p>
            {own
              ? "Your confirmed academy sessions"
              : `${player?.name ?? "Choose your linked child"} · confirmed academy sessions`}
          </p>
        </div>
      </div>
      <div className="portal-workflow">
        <CalendarLinkCard workspace={w} />
        {(d.parentClosures ?? []).length > 0 && (
          <section className="portal-card" aria-label="Closed days">
            <h2>Closed days</h2>
            <ul>
              {d.parentClosures!.map((c) => (
                <li key={c.id}>
                  <strong>
                    {c.startDate === c.endDate
                      ? displayDay(c.startDate)
                      : displayDayRange(c.startDate, c.endDate, " to ")}
                  </strong>{" "}
                  ·{" "}
                  {c.scope === "ACADEMY"
                    ? "Whole academy"
                    : (c.branchName ?? (own ? "Your branch" : "Your child’s branch"))}
                  {c.note ? ` · ${c.note}` : " · No training"}
                </li>
              ))}
            </ul>
          </section>
        )}
        {sessions.map((s) => (
          <section
            key={s.id}
            className="portal-card"
            data-session-status={s.status}
          >
            <span className="portal-status">
              {s.status.toLowerCase().replaceAll("_", " ")}
            </span>
            {s.status === "CANCELLED" && (
              <p>
                <strong>This session has been cancelled.</strong> The academy
                will confirm the next one.
              </p>
            )}
            <h2>{s.theme}</h2>
            <p>
              <CalendarDays size={16} /> {portalDate(s.startAt, d)}
            </p>
            <p>
              <Clock3 size={16} /> {portalDate(s.startAt, d, true)} –{" "}
              {portalDate(s.endAt, d, true)}
            </p>
            <p>
              {s.location} · {s.timezone}
            </p>
            {s.status !== "CANCELLED" && (
              <AddEventToCalendar
                event={{
                  uid: `${s.id}@sportozen`,
                  title: `${player?.name.split(/\s+/)[0] ?? ""} – ${s.theme}`,
                  startAt: s.startAt,
                  endAt: s.endAt,
                  location: s.location,
                }}
              />
            )}
            {s.status !== "CANCELLED" && !own && (
              <button
                className="portal-link"
                onClick={() =>
                  onNavigate("development", { player: player?.id })
                }
              >
                View approved weekly plan <ArrowRight size={14} />
              </button>
            )}
          </section>
        ))}
        {!sessions.length && (
          <div className="portal-empty">
            <CalendarDays size={30} />
            <h2>No confirmed sessions</h2>
            <p>
              {own
                ? "The academy will confirm your next session."
                : "The academy will confirm the next session for this child."}
            </p>
          </div>
        )}
        {player && (
          <section className="portal-card" aria-label="Attendance">
            <h2>Attendance</h2>
            <PlayerAttendanceHistory
              workspace={w}
              playerId={player.id}
              parent
            />
          </section>
        )}
      </div>
    </>
  );
}
