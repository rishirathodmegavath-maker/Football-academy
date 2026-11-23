import { isLocalDeployment, publicOrigin } from "../app-origin";
import { emailProvider, emailProviderNames } from "./transport";

/** "disabled", or the name of a registered provider (transport.ts). */
export type EmailTransportName = string;
export type EmailConfig = {
  transport: EmailTransportName;
  /** Sender address; empty while no transport is configured. */
  from: string;
  /** "required": an unverified address cannot sign in, create an academy or accept an invitation. */
  verification: "off" | "required";
  /** Password recovery by e-mail. */
  recovery: boolean;
  /** Public origin used to build links; never taken from a request. */
  origin: string;
  /** True when messages can actually be sent. */
  enabled: boolean;
};
const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const NAMED = /^[^<>\r\n]*<([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)>$/;

/**
 * Reads the e-mail settings. Transports: "disabled" (the default: no mail,
 * every flow keeps working as before), "capture" (in-memory, tests; refused in
 * production), "file" (writes each message to a local folder so a developer
 * can open the link; refused unless BETTER_AUTH_URL is a loopback address) and
 * "postmark" (a real provider; needs SPORTOZEN_POSTMARK_TOKEN and a sender on
 * a domain verified with the provider). Provider adapters live in transport.ts.
 *
 * Throws, never degrades silently: turning on verification or recovery with no
 * way to deliver mail would lock people out of their accounts.
 */
export function emailConfig(
  env: Record<string, string | undefined> = process.env,
): EmailConfig {
  // Local development only (`next dev` on a localhost address): mail is written
  // to a local folder and "Forgot your password?" works with no setting. Never
  // applies to a build, `next start` or a real deployment; set the variables
  // (for example SPORTOZEN_EMAIL_TRANSPORT=disabled) to turn it off.
  const developing = env.NODE_ENV === "development" && isLocalDeployment(env);
  const transport = (env.SPORTOZEN_EMAIL_TRANSPORT ||
    (developing ? "file" : "disabled")) as string;
  const provider = transport === "disabled" ? undefined : emailProvider(transport);
  if (transport !== "disabled" && !provider)
    throw new Error(
      `SPORTOZEN_EMAIL_TRANSPORT "${transport}" is not available; use one of ${["disabled", ...emailProviderNames()].join(", ")}.`,
    );
  if (provider?.kind === "test" && env.NODE_ENV === "production")
    throw new Error(
      `SPORTOZEN_EMAIL_TRANSPORT=${transport} is for tests and is refused in production.`,
    );
  if (provider?.kind === "local" && !isLocalDeployment(env))
    throw new Error(
      `SPORTOZEN_EMAIL_TRANSPORT=${transport} stores live links on disk and is only allowed when BETTER_AUTH_URL is a localhost address.`,
    );
  for (const variable of provider?.requiredEnv ?? [])
    if (!env[variable.name]?.trim())
      throw new Error(
        `SPORTOZEN_EMAIL_TRANSPORT=${transport} needs ${variable.name} (${variable.description}).`,
      );
  const verificationValue = env.SPORTOZEN_EMAIL_VERIFICATION || "off";
  if (verificationValue !== "off" && verificationValue !== "required")
    throw new Error(
      'SPORTOZEN_EMAIL_VERIFICATION must be "off" or "required".',
    );
  const recoveryValue =
    env.SPORTOZEN_PASSWORD_RECOVERY ||
    (developing && transport === "file" ? "on" : "off");
  if (recoveryValue !== "off" && recoveryValue !== "on")
    throw new Error('SPORTOZEN_PASSWORD_RECOVERY must be "off" or "on".');
  const from = (
    env.SPORTOZEN_EMAIL_FROM ||
    (developing && transport === "file"
      ? "Sportozen Academy <notifications@localhost.test>"
      : "")
  ).trim();
  if (transport === "disabled") {
    if (verificationValue === "required" || recoveryValue === "on")
      throw new Error(
        "Email verification or password recovery is enabled but no email transport is configured; users would be locked out.",
      );
    return {
      transport,
      from: "",
      verification: "off",
      recovery: false,
      origin: publicOrigin(env),
      enabled: false,
    };
  }
  if (!ADDRESS.test(from) && !NAMED.test(from))
    throw new Error(
      "SPORTOZEN_EMAIL_FROM must be a sender address such as notifications@your-domain.",
    );
  return {
    transport,
    from,
    verification: verificationValue,
    recovery: recoveryValue === "on",
    origin: publicOrigin(env),
    enabled: true,
  };
}
