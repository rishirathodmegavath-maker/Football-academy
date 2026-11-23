import type { AcademyRole } from "@/domain/workspace";

export const roleLabels: Record<AcademyRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  COACH: "Coach",
  PARENT: "Parent",
  SUPPORT: "Support",
};

/** Up to three initials of the academy name, shown when no logo has been uploaded. */
export function academyMonogram(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "SA"
  );
}

/** How an invitation names the role, in a sentence ("as a coach"). A player who
 * signs in for themselves is shown as a player, not as a parent. */
export const invitationRoleWords: Record<string, string> = {
  COACH: "a coach",
  PARENT: "a parent or guardian",
  PLAYER: "a player",
};
