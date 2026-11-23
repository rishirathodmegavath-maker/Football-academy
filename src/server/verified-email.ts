import "server-only";
import { WorkspaceError } from "./auth";
import { emailConfig } from "./email";

/**
 * When verification is required, actions that hand out access or create
 * tenants need an address the person has proved they own. Sign-in already
 * refuses unverified accounts; this is the second check, close to the action,
 * so it still holds if a session pre-dates the switch.
 */
export function requireVerifiedEmail(user: { emailVerified?: boolean }) {
  if (emailConfig().verification === "required" && user.emailVerified !== true)
    throw new WorkspaceError(
      403,
      "Verify your email address first. Check your inbox for the confirmation link.",
    );
}
