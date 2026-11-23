/**
 * The one environment notice. It is shown in every environment except one that is explicitly
 * declared production, and it says the same short thing wherever it appears.
 *
 * Production is an explicit choice: SPORTOZEN_ENVIRONMENT=production (case and surrounding
 * spaces ignored). Nothing else is read: the address of the site (BETTER_AUTH_URL) is not used to
 * guess an environment.
 *
 * Safe behaviour for anything else: if the variable is missing, empty, misspelt ("prod",
 * "live") or holds an unknown value, the notice is SHOWN. A wrongly shown notice is a visible,
 * harmless mistake; a wrongly hidden one could let real customer information be entered into a
 * pilot, so the uncertain cases fail towards showing it.
 *
 * Wording is the owner's: it replaces the engineering note that used to sit under the sign-in
 * form and does not make promises about what is or is not switched on.
 */
export const environmentNoticeText =
  "Pilot environment. Please do not enter real customer information yet.";

export function isProductionEnvironment(
  env: Record<string, string | undefined> = process.env,
) {
  return (env.SPORTOZEN_ENVIRONMENT ?? "").trim().toLowerCase() === "production";
}

/** The notice for this environment, or null only when production is declared explicitly. */
export function environmentNotice(
  env: Record<string, string | undefined> = process.env,
) {
  return isProductionEnvironment(env) ? null : environmentNoticeText;
}
