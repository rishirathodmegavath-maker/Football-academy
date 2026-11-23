import "server-only";
import type { AcademyRole } from "@/domain/workspace";
import { WorkspaceError } from "./auth";
import { database } from "./database";
import { securityEvent } from "./security-events";

/**
 * Who must use two-step verification (an authenticator-app code or a recovery
 * code at sign-in).
 *
 *   off    nobody is forced; anyone may turn it on (default: no behaviour change)
 *   staff  platform administrators and every academy role except PARENT, and
 *          anyone creating an academy (they become its OWNER)
 *   all    everyone with an academy role or a platform role
 *
 * The policy is an OWNER DECISION (assessment D7), so it is configuration, not
 * code. It is enforced where access is decided (workspace-access `access()`,
 * `platformAccess`, academy creation), not by the screens.
 */
export type MfaPolicy = "off" | "staff" | "all";
export function mfaPolicy(
  env: Record<string, string | undefined> = process.env,
): MfaPolicy {
  const value = (env.SPORTOZEN_MFA ?? "off").trim().toLowerCase();
  if (value !== "off" && value !== "staff" && value !== "all")
    throw new Error("SPORTOZEN_MFA must be off, staff or all.");
  return value;
}
type Scope = AcademyRole | "PLATFORM" | "CREATE_ACADEMY";
export function mfaRequiredFor(scope: Scope, policy = mfaPolicy()) {
  if (policy === "off") return false;
  if (policy === "all") return true;
  return scope !== "PARENT";
}
export const MFA_REQUIRED_MESSAGE =
  "Two-step verification is required for your role. Turn it on under Account security, then sign in again.";
/** Throws 403 MFA_REQUIRED when the policy needs it and the account lacks it. */
export function requireMfa(
  user: { id: string; twoFactorEnabled?: boolean | null },
  scope: Scope,
  academyId?: string,
) {
  if (!mfaRequiredFor(scope) || user.twoFactorEnabled === true) return;
  securityEvent("access.mfa_required", {
    userId: user.id,
    academyId,
    role: scope,
  });
  throw new WorkspaceError(403, MFA_REQUIRED_MESSAGE, {}, "MFA_REQUIRED");
}
/** What the account screen needs: is it on, and does a role of this person need it. */
export function mfaStatus(user: {
  id: string;
  twoFactorEnabled?: boolean | null;
}) {
  const roles = database()
    .prepare(
      "SELECT DISTINCT role FROM academy_memberships WHERE userId=? AND active=1",
    )
    .all(user.id)
    .map((row) => String(row.role) as AcademyRole);
  if (
    database()
      .prepare("SELECT 1 FROM platform_administrators WHERE userId=?")
      .get(user.id)
  )
    roles.push("OWNER");
  return {
    policy: mfaPolicy(),
    enabled: user.twoFactorEnabled === true,
    required: roles.some((role) => mfaRequiredFor(role)),
  };
}
