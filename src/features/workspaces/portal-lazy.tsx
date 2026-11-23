"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { PortalLoading } from "./portal-loading";

/**
 * The portal's screens other than Home, loaded as separate chunks. Home (and
 * the shell around it) is what almost every visit draws first; the fees,
 * training, reports, settings, calendar and messaging screens are about 90 % of
 * the application's code and pull in form validation (zod) that Home does not
 * need. Measured on a slow phone connection that code was most of the time to
 * the first card (docs/PHASE7_REPORT.md). A screen's chunk is requested when
 * the screen is opened, and in the background once the page is ready
 * (`usePrefetchPortalScreens`), so moving around the portal does not wait.
 */
const loaders = {
  players: () => import("./portal-players"),
  calendar: () => import("./portal-calendar"),
  training: () => import("./portal-training"),
  reports: () => import("./portal-reports"),
  fees: () => import("./portal-fees"),
  settings: () => import("./portal-settings"),
  plans: () => import("./plan-and-report"),
  weekly: () => import("./period-plans"),
  messages: () => import("./messages"),
  deliveries: () => import("./communication-controls"),
  announcements: () => import("./batch-announcements"),
  communications: () => import("./communications"),
  practice: () => import("./practice"),
  trials: () => import("./portal-trials"),
};
const Loading = () => <PortalLoading label="Loading this screen…" />;

export const PortalPlayers = dynamic(
  () => loaders.players().then((m) => m.PortalPlayers),
  { loading: Loading },
);
export const PortalCalendar = dynamic(
  () => loaders.calendar().then((m) => m.PortalCalendar),
  { loading: Loading },
);
export const PortalTraining = dynamic(
  () => loaders.training().then((m) => m.PortalTraining),
  { loading: Loading },
);
export const PortalReports = dynamic(
  () => loaders.reports().then((m) => m.PortalReports),
  { loading: Loading },
);
export const PortalFees = dynamic(
  () => loaders.fees().then((m) => m.PortalFees),
  { loading: Loading },
);
export const PortalSettings = dynamic(
  () => loaders.settings().then((m) => m.PortalSettings),
  { loading: Loading },
);
export const ParentPlans = dynamic(
  () => loaders.plans().then((m) => m.ParentPlans),
  { loading: Loading },
);
export const PlayerPlanEditor = dynamic(
  () => loaders.plans().then((m) => m.PlayerPlanEditor),
  { loading: Loading },
);
export const WeeklyPlans = dynamic(
  () => loaders.weekly().then((m) => m.WeeklyPlans),
  { loading: Loading },
);
export const WorkspaceMessages = dynamic(
  () => loaders.messages().then((m) => m.WorkspaceMessages),
  { loading: Loading },
);
export const DeliveryPanel = dynamic(
  () => loaders.deliveries().then((m) => m.DeliveryPanel),
  { loading: Loading },
);
export const Communications = dynamic(
  () => loaders.communications().then((m) => m.Communications),
  { loading: Loading },
);
export const BatchAnnouncements = dynamic(
  () => loaders.announcements().then((m) => m.BatchAnnouncements),
  { loading: Loading },
);
export const ParentPractice = dynamic(
  () => loaders.practice().then((m) => m.ParentPractice),
  { loading: Loading },
);
export const PortalTrialParentSummary = dynamic(
  () => loaders.trials().then((m) => m.PortalTrialParentSummary),
  { loading: Loading },
);

const SCREEN_CODE: Record<string, (keyof typeof loaders)[]> = {
  players: ["players"],
  calendar: ["calendar"],
  training: ["training"],
  reports: ["reports"],
  fees: ["fees"],
  settings: ["settings", "deliveries"],
  messages: ["messages", "announcements", "deliveries"],
  development: ["plans", "weekly"],
  practice: ["practice"],
};
/**
 * Starts loading the code of the screen the address names as soon as the portal
 * mounts, alongside the data request, instead of after the data arrives. A
 * failure is ignored: the screen loads when it is drawn.
 */
export function usePreloadPortalScreen(screen: string) {
  useEffect(() => {
    for (const name of SCREEN_CODE[screen] ?? [])
      void loaders[name]().catch(() => undefined);
  }, [screen]);
}
// The screens in the navigation, for each kind of member. Sub-screens (plans,
// practice, announcements, delivery details) load when they are opened.
const FOR_PARENT: (keyof typeof loaders)[] = [
  "reports",
  "messages",
  "calendar",
  "fees",
];
const FOR_STAFF: (keyof typeof loaders)[] = [
  "players",
  "calendar",
  "training",
  "reports",
  "fees",
  "messages",
  "settings",
];
/**
 * Fetches the other screens' code in the background, one chunk per idle moment,
 * starting a few seconds after the page finished loading, so the first visit to
 * a screen is as quick as the following ones. It never competes with the first
 * draw, and is skipped when the browser reports data saving or a very slow link.
 */
export function usePrefetchPortalScreens(role: string | undefined) {
  useEffect(() => {
    if (!role || role === "SUPPORT") return;
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (
      connection?.saveData ||
      ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")
    )
      return;
    const queue = [...(role === "PARENT" ? FOR_PARENT : FOR_STAFF)];
    let timer: ReturnType<typeof setTimeout> | undefined,
      cancelled = false;
    const idle = (fn: () => void) =>
      "requestIdleCallback" in window
        ? window.requestIdleCallback(fn, { timeout: 4000 })
        : setTimeout(fn, 500);
    const next = () => {
      if (cancelled) return;
      const name = queue.shift();
      if (!name) return;
      // A failed prefetch is not an error: the screen loads when it is opened.
      void loaders[name]()
        .catch(() => undefined)
        .finally(() => idle(next));
    };
    const start = () => {
      timer = setTimeout(() => idle(next), 3000);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("load", start);
    };
  }, [role]);
}
