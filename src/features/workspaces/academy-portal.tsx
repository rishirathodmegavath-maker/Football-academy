"use client";
import { useEffect, useState } from "react";
import { clearAcademyStore } from "@/lib/academy-store";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/hooks/use-workspace";
import { useReportList } from "@/hooks/use-reports";
import {
  usePlayerMessages,
  usePlayerWeeklyPlans,
} from "@/hooks/use-player-records";
import type { WorkspaceBootstrap } from "@/domain/home-summary";
import { confirmUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { PortalShell } from "./portal-shell";
import { PortalHome } from "./portal-home";
import { PortalParentHome, PortalParentSchedule } from "./portal-parent-home";
import { GuardianAnnouncements } from "./guardian-announcements";
import { PortalScreenBoundary } from "./portal-screen-boundary";
import { PortalLoading } from "./portal-loading";
import { PlayerOwnHome } from "./player-home";
import {
  SelfPlayerDetails,
  SelfPlayerWaiting,
  useSelfPlayerState,
} from "./player-link";
import { AcademyApproval } from "./academy-approval";
// Home and the shell are in the first download; every other screen is its own
// chunk (see portal-lazy.tsx).
import {
  PortalPlayers,
  PortalCalendar,
  PortalTraining,
  PortalReports,
  PortalFees,
  PortalSettings,
  ParentPlans,
  PlayerPlanEditor,
  WeeklyPlans,
  WorkspaceMessages,
  DeliveryPanel,
  BatchAnnouncements,
  Communications,
  ParentPractice,
  PortalTrialParentSummary,
  usePrefetchPortalScreens,
  usePreloadPortalScreen,
} from "./portal-lazy";
import type { PortalSection, PortalNavigate } from "./portal-types";
import {
  canUseFees,
  homeLabelFor,
  homeSectionFor,
  sectionAllowed,
} from "./portal-access";
import { portalSourceAvailable } from "@/services/portal-source-selection";
import { playerBatch } from "@/services/portal-records";
import "./portal.css";
import "./portal-home.css";
import "./portal-players.css";
import "./portal-reports.css";
import "./portal-parent-home.css";

const sections: PortalSection[] = [
  "home",
  "players",
  "calendar",
  "training",
  "reports",
  "fees",
  "settings",
  "messages",
  "development",
  "practice",
];
function OperationalPortal({
  academyId,
  initialBootstrap,
}: {
  academyId: string;
  /** What the server page already authorised for this viewer. */
  initialBootstrap?: WorkspaceBootstrap;
}) {
  const router = useRouter(),
    params = useSearchParams();
  // The screen named by the URL decides how much of the academy to load (see
  // payloadFor): Home needs none of it, Fees, Settings and Calendar a few
  // record kinds, the rest all of it. A deep link to a report, weekly plan or
  // session opens that screen.
  const requested = params.get("section"),
    screen = sections.includes(requested as PortalSection)
      ? requested!
      : params.has("report")
        ? "reports"
        : params.has("weekly")
          ? "development"
          : params.has("session")
            ? "training"
            : "home";
  // The Reports screen lists reports from the report list and detail reads;
  // only its editor (`prepare`) needs the whole academy payload.
  const listedReports = screen === "reports" && !params.get("prepare");
  const w = useWorkspace(academyId, {
    screen: screen === "reports" && !listedReports ? "reports-editor" : screen,
    initialBootstrap,
  });
  usePreloadPortalScreen(screen);
  usePrefetchPortalScreens(w.shell?.membership.role);
  // The report list serves the Reports screen and, with the saved-source
  // check, the monthly review editor (which reads the same entry).
  const reportList = useReportList(w, screen === "reports", {
    review: Boolean(params.get("prepare")),
  });
  // Messages and Development read the selected player's records on their own.
  // When the URL names the player those reads start now, alongside the
  // academy payload, instead of after it (the screens share the same store
  // entries, so nothing is requested twice). Deep links to one report
  // (Messages) or one weekly plan (Development) are checked against the same
  // reads, once loaded.
  const linkedPlayer = params.get("player") ?? "",
    linkedWeekly = screen === "development" ? (params.get("weekly") ?? "") : "";
  const messagesRead =
    screen === "messages" &&
    Boolean(linkedPlayer) &&
    w.shell?.membership.role !== "SUPPORT";
  const linkedMessages = usePlayerMessages(w, linkedPlayer, messagesRead),
    linkedWeeklyPlans = usePlayerWeeklyPlans(
      w,
      linkedPlayer,
      Boolean(linkedWeekly) ||
        (screen === "development" && Boolean(linkedPlayer)),
    );
  // Whether the portal has already shown its shell. The first paint of a screen
  // that must wait for the academy payload is the plain loading page: drawing
  // the whole shell first costs a second, larger layout (measured: +17 ms of
  // layout, +21 ms to the Parent Home). Once the shell has been shown, moving
  // to another screen keeps it on screen instead of blanking the page.
  const [shellShown, setShellShown] = useState(false);
  // The store lives only while the portal does: leaving the academy, signing
  // out, or the server replacing the portal with a refusal page ends it.
  const portalStore = w.store;
  useEffect(() => () => clearAcademyStore(portalStore), [portalStore]);
  const [practiceFeedback, setPracticeFeedback] = useState<{
    academyId: string;
    userId: string;
    playerId: string;
    body: string;
  } | null>(null);
  const onNavigate: PortalNavigate = (section, context = {}) => {
    const next = new URLSearchParams(params.toString());
    next.set("section", section);
    if (section !== "reports") {
      next.delete("report");
      next.delete("prepare");
    }
    if (section !== "development") next.delete("weekly");
    if (section !== "settings") next.delete("tab");
    if (section !== "messages") next.delete("sourceReport");
    if (section !== "players" && section !== "training") next.delete("create");
    for (const [key, value] of Object.entries(context))
      if (value) next.set(key, value);
      else next.delete(key);
    router.push(
      `/workspace/${encodeURIComponent(academyId)}?${next.toString()}`,
      { scroll: false },
    );
  };
  const shell = w.shell;
  // A member who used a player link and has not yet filled in their own details (the server holds the fact).
  const selfState = useSelfPlayerState(academyId, shell?.membership.role);
  if (!shell)
    return (
      <main className="secure-page">
        <h1>Sportozen Academy</h1>
        {w.error ? (
          <div role="alert">
            <p>{w.error}</p>
            <button className="button secondary" onClick={() => w.retry()}>
              Retry workspace
            </button>
          </div>
        ) : (
          <PortalLoading label="Loading your academy…" />
        )}
      </main>
    );
  const parent = shell.membership.role === "PARENT",
    support = shell.membership.role === "SUPPORT";
  if (parent && (selfState.state === "details" || selfState.state === "waiting"))
    return (
      <PortalShell data={shell} section="home" onNavigate={onNavigate} limited>
        {selfState.state === "details" ? (
          <SelfPlayerDetails
            academyId={academyId}
            academyName={shell.academy.name}
            timezone={shell.academy.timezone}
            onDone={() => selfState.set("waiting")}
          />
        ) : (
          <SelfPlayerWaiting academyName={shell.academy.name} />
        )}
      </PortalShell>
    );
  const sectionParam = params.get("section"),
    section: PortalSection = sections.includes(sectionParam as PortalSection)
      ? (sectionParam as PortalSection)
      : params.has("report")
        ? "reports"
        : params.has("weekly")
          ? "development"
          : params.has("session")
            ? "training"
            : support
              ? "reports"
              : "home";
  if (section === "home" && !parent && !support) {
    if (!shellShown) setShellShown(true);
    return (
      <PortalShell data={shell} section="home" onNavigate={onNavigate}>
        {w.error && (
          <div className="notice amber" role="alert">
            {w.error}
          </div>
        )}
        <PortalHome workspace={w} onNavigate={onNavigate} />
      </PortalShell>
    );
  }
  const d = w.data;
  if (!d) {
    const waiting = w.error ? (
      <div className="notice amber" role="alert">
        <p>{w.error}</p>
        <button className="button secondary" onClick={() => w.retry()}>
          Retry workspace
        </button>
      </div>
    ) : (
      <PortalLoading label="Loading your academy…" />
    );
    return shellShown ? (
      <PortalShell data={shell} section={section} onNavigate={onNavigate}>
        {waiting}
      </PortalShell>
    ) : (
      <main className="secure-page">
        <h1>Sportozen Academy</h1>
        {waiting}
      </main>
    );
  }
  if (!shellShown) setShellShown(true);
  const selected = params.get("player") ?? "",
    player = selected
      ? d.records.player.find((p) => p.id === selected)
      : parent || d.records.player.length === 1
        ? d.records.player[0]
        : undefined;
  const sessionId = params.get("session") ?? "";
  const feedback =
    parent &&
    player &&
    practiceFeedback?.academyId === academyId &&
    practiceFeedback.userId === d.membership.userId &&
    practiceFeedback.playerId === player.id
      ? practiceFeedback.body
      : "";
  const reportId = section === "reports" ? (params.get("report") ?? "") : "",
    weeklyId = section === "development" ? (params.get("weekly") ?? "") : "",
    messageReportId =
      section === "messages" ? (params.get("sourceReport") ?? "") : "";
  // In list mode the report is looked up among the listed reports (and only
  // once they have loaded, so a slow list never reads as "unavailable").
  // Parents are not offered the report list: their payload carries their
  // approved reports and is checked directly.
  const reportUnavailable = !reportId
    ? false
    : !parent
      ? reportList.data
        ? !portalSourceAvailable(
            {
              academy: d.academy,
              membership: d.membership,
              records: {
                player: d.records.player,
                weekly: [],
                report: reportList.data,
              },
            },
            selected,
            reportId,
            "MONTHLY",
          )
        : false
      : !portalSourceAvailable(d, selected, reportId, "MONTHLY");
  const sourceUnavailable =
    reportUnavailable ||
    // Weekly plans and message sources are looked up among the player's own
    // focused reads, and only once those have loaded.
    (weeklyId &&
      (!selected ||
        (linkedWeeklyPlans.data
          ? !portalSourceAvailable(
              {
                academy: d.academy,
                membership: d.membership,
                records: {
                  player: d.records.player,
                  weekly: linkedWeeklyPlans.data,
                  report: [],
                },
              },
              selected,
              weeklyId,
              "WEEKLY",
            )
          : false))) ||
    (messageReportId &&
      (!selected ||
        !d.records.player.some(
          (p) => p.id === selected && p.sportIds.includes("football"),
        ) ||
        (linkedMessages.data
          ? !linkedMessages.data.reports.some(
              (report) => report.id === messageReportId,
            )
          : false)));
  const role = d.membership.role;
  const canFinance = canUseFees(role, d.academy.modules);
  // The navigation lists only what the role can open; a typed address for anything else gets one short message here.
  // The server authorises every request on its own, so this is presentation, never the permission check.
  const playerLogin = !!d.viewer?.playerLogin;
  const allowed = sectionAllowed(role, section, d.academy.modules, playerLogin);
  const playerSelect = (
    <label className="portal-context-selector">
      {parent ? "Your linked child" : "Player"}
      <select
        aria-label={parent ? "Your linked child" : "Player"}
        value={player?.id ?? ""}
        onChange={(e) => {
          if (confirmUnsavedChanges())
            onNavigate(section, {
              player: e.target.value,
              report: "",
              weekly: "",
              sourceReport: "",
            });
        }}
      >
        <option value="">Choose an authorised player</option>
        {d.records.player.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {playerBatch(d, p)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <PortalShell data={d} section={section} onNavigate={onNavigate}>
      {w.error && (
        <div className="notice amber" role="alert">
          {w.error}
        </div>
      )}
      <PortalScreenBoundary key={section}>
        {!allowed ? (
          <div className="portal-empty">
            <h1>This section is unavailable for your role</h1>
            <p>
              Your academy membership controls access to private records and
              actions. Ask your academy owner if you need it.
            </p>
            <button
              className="button primary"
              onClick={() => onNavigate(homeSectionFor(role))}
            >
              Go to {homeLabelFor(role)}
            </button>
          </div>
        ) : sourceUnavailable ? (
          <div className="portal-empty" role="alert">
            <h1>
              {weeklyId ? "Weekly plan unavailable" : "Report unavailable"}
            </h1>
            <p>
              This source is not available for the selected player in your
              current academy and role. No other source has been selected.
            </p>
            <button
              className="button secondary"
              onClick={() =>
                onNavigate(messageReportId ? "reports" : section, {
                  report: "",
                  weekly: "",
                  sourceReport: "",
                })
              }
            >
              Return to {weeklyId ? "development plans" : "reports"}
            </button>
          </div>
        ) : (
          <>
            {section === "home" && parent && playerLogin && (
              <PlayerOwnHome
                workspace={w}
                player={player}
                onNavigate={onNavigate}
              />
            )}
            {section === "home" && parent && !playerLogin && (
              <PortalParentHome
                workspace={w}
                player={player}
                onNavigate={onNavigate}
              />
            )}
            {section === "players" && (
              <PortalPlayers
                key={`${params.get("q") ?? ""}:${params.get("create") ?? ""}`}
                workspace={w}
                playerId={selected}
                onNavigate={onNavigate}
                query={params.get("q") ?? ""}
                create={params.get("create") === "player"}
              />
            )}
            {section === "calendar" &&
              (parent ? (
                <PortalParentSchedule
                  workspace={w}
                  player={player}
                  onNavigate={onNavigate}
                />
              ) : (
                <PortalCalendar
                  key={academyId}
                  workspace={w}
                  sessionId={sessionId}
                  onNavigate={onNavigate}
                />
              ))}
            {section === "training" && !parent && !support && (
              <PortalTraining
                key={`${academyId}:${params.get("create") ?? ""}`}
                workspace={w}
                sessionId={sessionId}
                onNavigate={onNavigate}
              />
            )}
            {section === "reports" &&
              (parent ? (
                <>
                  <div className="portal-page-heading">
                    <div>
                      <h1>Progress & reports</h1>
                      <p>Coach-approved reports for your linked child.</p>
                    </div>
                  </div>
                  {playerSelect}
                  {player ? (
                    <div className="portal-workflow">
                      <ParentPlans
                        key={player.id}
                        workspace={w}
                        player={player}
                        sportId="football"
                        reportsOnly
                        reportId={reportId}
                      />
                    </div>
                  ) : (
                    <p>
                      Select your linked child to view their private approved
                      reports.
                    </p>
                  )}
                </>
              ) : (
                <PortalReports
                  workspace={w}
                  playerId={selected}
                  reportId={reportId}
                  onNavigate={onNavigate}
                  prepare={params.get("prepare") === "monthly"}
                />
              ))}
            {section === "fees" && (
              <PortalFees
                workspace={w}
                playerId={selected || player?.id}
                onPlayer={(id) => onNavigate("fees", { player: id })}
                onMessageParent={(id) => onNavigate("messages", { player: id })}
                onViewPlayer={(id) => onNavigate("players", { player: id })}
              />
            )}
            {section === "settings" && (
              <>
                {parent && (
                  <section className="portal-card portal-parent-more">
                    <h2>More</h2>
                    {playerSelect}
                    <div className="portal-parent-more-links">
                      <button
                        className="button secondary"
                        data-leave-editor
                        onClick={() =>
                          onNavigate("calendar", { player: player?.id })
                        }
                      >
                        Training schedule
                      </button>
                      <button
                        className="button secondary"
                        data-leave-editor
                        onClick={() =>
                          onNavigate("development", { player: player?.id })
                        }
                      >
                        Development plan
                      </button>
                      {canFinance && (
                        <button
                          className="button secondary"
                          data-leave-editor
                          onClick={() =>
                            onNavigate("fees", { player: player?.id })
                          }
                        >
                          Fees & Receipts
                        </button>
                      )}
                      <button
                        className="button secondary"
                        data-leave-editor
                        onClick={() =>
                          onNavigate("practice", { player: player?.id })
                        }
                      >
                        Practise together
                      </button>
                    </div>
                  </section>
                )}
                <PortalSettings
                  key={`${academyId}:${params.get("tab") ?? "academy"}`}
                  workspace={w}
                  playerId={player?.id}
                  requestedTab={params.get("tab") ?? "academy"}
                />
              </>
            )}
            {section === "development" && (
              <>
                <div className="portal-page-heading">
                  <div>
                    <h1>
                      {parent ? "Development plan" : "Player development"}
                    </h1>
                    <p>Shared batch training with optional individual focus.</p>
                  </div>
                </div>
                {playerSelect}
                {parent && player && (
                  <PortalTrialParentSummary
                    key={player.id}
                    workspace={w}
                    player={player}
                  />
                )}
                {player ? (
                  <div className="portal-workflow">
                    {weeklyId ? (
                      <WeeklyPlans
                        workspace={w}
                        playerId={player.id}
                        sourceId={weeklyId}
                      />
                    ) : parent || support ? (
                      <>
                        <ParentPlans
                          key={player.id}
                          workspace={w}
                          player={player}
                          sportId="football"
                        />
                        <WeeklyPlans workspace={w} playerId={player.id} />
                      </>
                    ) : (
                      <PlayerPlanEditor
                        key={player.id}
                        workspace={w}
                        player={player}
                        sportId="football"
                      />
                    )}
                  </div>
                ) : (
                  <p>
                    Choose an authorised player. No other child has been
                    selected.
                  </p>
                )}
              </>
            )}
            {section === "messages" && !support && parent && (
              <>
                <div className="portal-page-heading">
                  <div>
                    <h1>{parent ? "Message coach" : "Messages"}</h1>
                    <p>Private conversations within {d.academy.name}.</p>
                  </div>
                </div>
                {parent && <GuardianAnnouncements workspace={w} />}
                {playerSelect}
                {player ? (
                  <div className="portal-workflow">
                    <WorkspaceMessages
                      key={`${player.id}:${messageReportId}`}
                      workspace={w}
                      player={player}
                      sportId="football"
                      initialReportId={messageReportId}
                      initialFeedback={feedback}
                      onFeedbackSent={() =>
                        setPracticeFeedback((current) =>
                          current?.academyId === academyId &&
                          current.userId === d.membership.userId &&
                          current.playerId === player.id &&
                          current.body === feedback
                            ? null
                            : current,
                        )
                      }
                    />
                    {!parent && (
                      <details>
                        <summary>Delivery and approval details</summary>
                        <DeliveryPanel workspace={w} playerId={player.id} />
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="portal-empty">
                    <h2>Choose a player to open their private conversation</h2>
                    <p>
                      Messages are scoped to the player and verified guardian
                      relationship.
                    </p>
                  </div>
                )}
              </>
            )}
            {section === "messages" && !support && !parent && (
              <>
                <div className="portal-page-heading">
                  <div>
                    <h1>Communications</h1>
                    <p>
                      Announcements, private conversations and templates for{" "}
                      {d.academy.name}.
                    </p>
                  </div>
                  <BatchAnnouncements workspace={w} />
                </div>
                <Communications
                  workspace={w}
                  // Only a link that names a player (for example from a report or a parent's question) opens the conversations;
                  // a player picked automatically because there is only one does not.
                  initialTab={
                    params.get("player")
                      ? "Private conversations"
                      : "Announcements"
                  }
                  conversations={
                    <>
                {playerSelect}
                {player ? (
                  <>
                    <WorkspaceMessages
                      key={`${player.id}:${messageReportId}`}
                      workspace={w}
                      player={player}
                      sportId="football"
                      initialReportId={messageReportId}
                      initialFeedback={feedback}
                      onFeedbackSent={() =>
                        setPracticeFeedback((current) =>
                          current?.academyId === academyId &&
                          current.userId === d.membership.userId &&
                          current.playerId === player.id &&
                          current.body === feedback
                            ? null
                            : current,
                        )
                      }
                    />
                    {!parent && (
                      <details>
                        <summary>Delivery and approval details</summary>
                        <DeliveryPanel workspace={w} playerId={player.id} />
                      </details>
                    )}
                  </>
                ) : (
                  <div className="portal-empty">
                    <h2>Choose a player to open their private conversation</h2>
                    <p>
                      Messages are scoped to the player and verified guardian
                      relationship.
                    </p>
                  </div>
                )}
                    </>
                  }
                />
              </>
            )}
            {section === "practice" && parent && (
              <>
                <div className="portal-page-heading">
                  <div>
                    <h1>Practise together</h1>
                    <p>Optional parent-supported practice.</p>
                  </div>
                </div>
                {playerSelect}
                {player && (
                  <ParentPractice
                    key={player.id}
                    workspace={w}
                    player={player}
                    onHelp={(body) => {
                      setPracticeFeedback({
                        academyId,
                        userId: d.membership.userId,
                        playerId: player.id,
                        body,
                      });
                      onNavigate("messages", { player: player.id });
                    }}
                  />
                )}
              </>
            )}
          </>
        )}
      </PortalScreenBoundary>
    </PortalShell>
  );
}

/**
 * The approval gate of the screen. Only an approved (ACTIVE) academy gets the
 * portal; one that is still being set up, waiting for a decision or not
 * approved gets the approval page, which never requests operational data. The
 * server enforces the same rule on every API request.
 */
export function AcademyPortal(props: {
  academyId: string;
  initialBootstrap?: WorkspaceBootstrap;
}) {
  const lifecycle = props.initialBootstrap?.lifecycle;
  if (props.initialBootstrap && lifecycle && lifecycle.state !== "ACTIVE")
    return (
      <AcademyApproval
        academyId={props.academyId}
        bootstrap={props.initialBootstrap}
      />
    );
  return <OperationalPortal {...props} />;
}
