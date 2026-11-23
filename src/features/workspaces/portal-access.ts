import type { AcademyRole } from "@/domain/workspace";
import type { PortalSection } from "./portal-types";

/**
 * Which sections of the academy portal a role is offered, and in what order.
 *
 * This decides what the navigation SHOWS and what the portal screen WILL OPEN. It is not the permission check: every
 * record request is authorised again on the server (src/server/workspace-access.ts), and a section hidden here is still
 * refused there. tests/unit/portal-access.test.ts pins both the lists below and the refusals the server must keep making.
 *
 * Wave 2 (navigation): one list per role instead of the same rule written out in the shell and in the portal.
 *  - Staff (owner, admin, coach): Overview, Players, Calendar, Training, Reports, Fees, Communications, Settings. The URL
 *    value of Overview is still `?section=home`, so every existing link keeps working.
 *  - Fees is offered only to a role that can use it (owner and admin, with the fees module on). A coach is not shown a
 *    disabled item; a typed address gets the same short message as every other section the role cannot open.
 *  - Support: Players, Reports, Settings.
 *  - Family (parent): Home, Progress, Messages, More. "More" stays for the family; staff say Settings.
 *  - A player's own login (a confirmed player who joined with a player link): Home, Schedule, More. No fees, no private messages,
 *    no reports. The server refuses fees and private messages for that account on its own; reports are hidden here only.
 */
export type NavEntry = { key: PortalSection; label: string };

/** The module that must be switched on for the fees section to exist at all. */
export function canUseFees(role: AcademyRole, modules: readonly string[]) {
  return (
    (role === "OWNER" || role === "ADMIN" || role === "PARENT") &&
    modules.includes("fees")
  );
}

/** Whether this role may open the section in the portal (the server still decides about any data). */
export function sectionAllowed(
  role: AcademyRole,
  section: PortalSection,
  modules: readonly string[],
  playerLogin = false,
) {
  // A confirmed player's own login: their home, their schedule and their account. No fees, no parent messages or reports.
  if (role === "PARENT" && playerLogin)
    return ["home", "calendar", "settings"].includes(section);
  if (role === "SUPPORT")
    return ["reports", "players", "development", "settings"].includes(section);
  if (section === "fees") return canUseFees(role, modules);
  if (role === "PARENT") return !["players", "training"].includes(section);
  return section !== "practice";
}

const STAFF: readonly NavEntry[] = [
  { key: "home", label: "Overview" },
  { key: "players", label: "Players" },
  { key: "calendar", label: "Calendar" },
  { key: "training", label: "Training" },
  { key: "reports", label: "Reports" },
  { key: "fees", label: "Fees" },
  { key: "messages", label: "Communications" },
  { key: "settings", label: "Settings" },
];

/** The navigation items for a role, in order. Items the role cannot open are not listed. */
export function navigationFor(
  role: AcademyRole,
  modules: readonly string[],
  playerLogin = false,
): NavEntry[] {
  if (role === "PARENT" && playerLogin)
    return [
      { key: "home", label: "Home" },
      { key: "calendar", label: "Schedule" },
      { key: "settings", label: "More" },
    ];
  if (role === "PARENT")
    return [
      { key: "home", label: "Home" },
      { key: "reports", label: "Progress" },
      { key: "messages", label: "Messages" },
      { key: "settings", label: "More" },
    ];
  if (role === "SUPPORT")
    return [
      { key: "players", label: "Players" },
      { key: "reports", label: "Reports" },
      { key: "settings", label: "Settings" },
    ];
  return STAFF.filter(
    ({ key }) => key !== "fees" || canUseFees(role, modules),
  ).map((entry) => ({ ...entry }));
}

/** The section a role lands on when none is named, and the one "Go back" leads to. */
export function homeSectionFor(role: AcademyRole): PortalSection {
  return role === "SUPPORT" ? "reports" : "home";
}

/** The name of that landing section as the navigation shows it. */
export function homeLabelFor(role: AcademyRole) {
  return (
    navigationFor(role, []).find((entry) => entry.key === homeSectionFor(role))
      ?.label ?? "Home"
  );
}
