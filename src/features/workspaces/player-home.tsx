"use client";
import { ArrowRight, CalendarDays } from "lucide-react";
import type { WorkspacePlayer } from "@/domain/workspace";
import { portalDate } from "@/services/portal-records";
import { GuardianAnnouncements } from "./guardian-announcements";
import type { PortalController, PortalNavigate } from "./portal-types";
import "./portal-calendar.css";

/**
 * The home screen of a confirmed player's own login (a player who joined with a player link). It shows the academy's
 * announcements and the next session, in the player's own words. Fees, private messages to staff and reports are not offered
 * here; the server refuses fees and private messages for this account on its own (see player-link-service.ts).
 */
export function PlayerOwnHome({
  workspace: w,
  player,
  onNavigate,
}: {
  workspace: PortalController;
  player?: WorkspacePlayer;
  onNavigate: PortalNavigate;
}) {
  const d = w.data!,
    first = d.viewer?.name?.split(" ")[0] ?? "there",
    next = player
      ? d.parentSchedule?.find(
          (s) =>
            s.childId === player.id &&
            s.status !== "CANCELLED" &&
            s.endAt >= new Date().toISOString(),
        )
      : undefined;
  return (
    <div className="portal-parent-home">
      <div className="portal-page-heading">
        <div>
          <h1>Hi {first}</h1>
          <p>Welcome to {d.academy.name}.</p>
        </div>
      </div>
      <GuardianAnnouncements workspace={w} />
      <button
        className="portal-card portal-parent-session"
        onClick={() =>
          onNavigate("calendar", { player: player?.id, session: next?.id })
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
          <small>{next?.location ?? "The academy will confirm your schedule."}</small>
        </span>
        <ArrowRight size={15} />
      </button>
    </div>
  );
}
