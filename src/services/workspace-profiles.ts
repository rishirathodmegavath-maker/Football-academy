import type { AcademyRole, WorkspaceKind } from "@/domain/workspace";

const staff: AcademyRole[] = ["OWNER", "ADMIN", "COACH"];
/** Record kinds each reduced screen reads (checked against the screens' source:
 * a kind a screen reads but is not listed here would appear empty). Screens
 * not listed here, and every other role, load the whole payload. */
const kindsByScreen: Record<
  string,
  { roles: AcademyRole[]; kinds: WorkspaceKind[] }
> = {
  fees: { roles: [...staff, "PARENT"], kinds: ["player", "squad"] },
  settings: {
    roles: staff,
    kinds: ["branch", "player", "program", "squad", "venue"],
  },
  // Players: the directory, batches and current plans; approved-report history
  // comes from the report list and the next session from a per-player read.
  players: { roles: staff, kinds: ["player", "squad", "plan", "enquiry"] },
  // List mode of the Reports screen: players and batches only; the reports
  // themselves come from the report list and detail reads.
  reports: { roles: [...staff, "SUPPORT"], kinds: ["player", "squad"] },
  // The monthly review editor needs the same: its queue is the report list,
  // the open report comes with the training records behind it, and the
  // player's other recorded reports are read per player.
  "reports-editor": { roles: staff, kinds: ["player", "squad"] },
  // Messages: the player and batch pickers. Each player's plans, updates,
  // conversations and approved-report content come from focused reads.
  messages: { roles: [...staff, "PARENT"], kinds: ["player", "squad"] },
  // Development: the picker, the plan editor's plans and drills. Weekly plans
  // come from a per-player read and the trial summary from its own.
  development: {
    roles: [...staff, "PARENT", "SUPPORT"],
    kinds: ["drill", "plan", "player", "squad"],
  },
  // Training: the Calendar's kinds plus the weekly plans its Session Plans tab
  // lists. It reads no reports (the monthly report workflow is in Reports).
  // Attendance and evidence are read for the open session only.
  training: {
    roles: staff,
    kinds: [
      "branch",
      "drill",
      "plan",
      "player",
      "series",
      "session",
      "squad",
      "venue",
      "weekly",
      "closure",
    ],
  },
  calendar: {
    roles: staff,
    kinds: [
      "branch",
      "drill",
      "plan",
      "player",
      "series",
      "session",
      "squad",
      "venue",
      "closure",
    ],
  },
};

/** What the academy payload must contain for a screen and role.
 *  "none": nothing (Home is served by the Home summary);
 *  an array: only those record kinds;
 *  "all": the whole payload. */
export function payloadFor(
  screen: string,
  role: AcademyRole,
): "none" | "all" | WorkspaceKind[] {
  if (screen === "home" && staff.includes(role)) return "none";
  const reduced = kindsByScreen[screen];
  return reduced?.roles.includes(role) ? reduced.kinds : "all";
}
