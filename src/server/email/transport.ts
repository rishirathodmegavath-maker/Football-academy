import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EmailConfig } from "./config";
import { postmarkProvider } from "./postmark";
import {
  EmailSendError,
  type EmailProvider,
  type EmailTransport,
  type OutgoingEmail,
} from "./types";

// The contract lives in types.ts and the Postmark adapter in postmark.ts; this
// file holds the two local transports and the registry that maps the value of
// SPORTOZEN_EMAIL_TRANSPORT to a provider. Re-exported so existing imports work.
export { EmailSendError } from "./types";
export type {
  DeliveryEvent,
  DeliveryKind,
  EmailProvider,
  EmailTransport,
  OutgoingEmail,
  ProviderEnv,
  SendResult,
  WebhookAdapter,
} from "./types";
export { postmarkTransport } from "./postmark";

/**
 * Test transport: keeps messages in memory and can be scripted to fail.
 * Production never uses it (see emailConfig).
 */
export const captured: OutgoingEmail[] = [];
type Outcome = "ok" | "transient" | "permanent";
const script: Outcome[] = [];
export function scriptCapture(outcomes: Outcome[]) {
  script.splice(0, script.length, ...outcomes);
}
export function resetCapture() {
  captured.splice(0, captured.length);
  script.splice(0, script.length);
}
const capture: EmailTransport = {
  name: "capture",
  async send(email) {
    const outcome = script.shift() ?? "ok";
    if (outcome === "transient")
      throw new EmailSendError("simulated outage", false, "UNAVAILABLE");
    if (outcome === "permanent")
      throw new EmailSendError("simulated rejection", true, "REJECTED");
    captured.push(email);
    return { providerMessageId: `capture-${captured.length}` };
  },
};

/**
 * Local development and browser tests: each message is written as a JSON file
 * (recipient, subject, text) so a developer can open the link. The files hold
 * live links, so emailConfig refuses this transport unless the deployment is
 * local (a loopback BETTER_AUTH_URL), which no real deployment can be.
 */
export function previewDirectory(
  env: Record<string, string | undefined> = process.env,
) {
  return resolve(env.SPORTOZEN_EMAIL_PREVIEW_DIR || ".local/mail-preview");
}
const filePreview: EmailTransport = {
  name: "file",
  async send(email) {
    const dir = previewDirectory();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `${Date.now()}-${email.id}.json`),
      JSON.stringify(
        {
          id: email.id,
          to: email.to,
          subject: email.subject,
          text: email.text,
        },
        null,
        2,
      ),
    );
    return { providerMessageId: `file-${email.id}` };
  },
};

// ------------------------------------------------------------------ registry
/**
 * To add a provider: write its transport (map its responses onto
 * EmailSendError: permanent for 4xx other than 429, transient for network
 * errors, 429 and 5xx) and, if it reports delivery, its webhook adapter, in its
 * own file like postmark.ts, and register it here. If it is a real provider also
 * add its name to EMAIL_TRANSPORTS in scripts/lib/preflight.mjs (a test keeps
 * the two lists equal). Nothing else in the application changes. Only add a
 * provider whose official API contract has been checked.
 */
const providers = new Map<string, EmailProvider>();
export function registerEmailProvider(provider: EmailProvider) {
  if (
    !/^[a-z][a-z0-9-]{1,30}$/.test(provider.name) ||
    provider.name === "disabled"
  )
    throw new Error(`"${provider.name}" is not a valid provider name.`);
  providers.set(provider.name, provider);
}
export function unregisterEmailProvider(name: string) {
  providers.delete(name);
}
export function emailProvider(name: string) {
  return providers.get(name);
}
export function emailProviderNames() {
  return [...providers.keys()];
}

registerEmailProvider({
  name: "capture",
  kind: "test",
  requiredEnv: [],
  create: () => capture,
});
registerEmailProvider({
  name: "file",
  kind: "local",
  requiredEnv: [],
  create: () => filePreview,
});
registerEmailProvider(postmarkProvider);

/** The transport for the configured provider, or null while mail is disabled. */
export function createTransport(
  config: EmailConfig,
  env: Record<string, string | undefined> = process.env,
): EmailTransport | null {
  return emailProvider(config.transport)?.create(env) ?? null;
}
