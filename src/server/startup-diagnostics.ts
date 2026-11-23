import "server-only";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { cspMode } from "@/config/security-policy";
import { database } from "./database";
import { emailConfig } from "./email/config";
import { mfaPolicy } from "./mfa-policy";
import { readiness } from "./readiness";
import { sessionPolicy } from "./account-security";
import { errorFields, log } from "./log";

/**
 * One line when the process starts, saying which release is running and how it
 * is configured, so "what is live and with which settings" is answered from the
 * log. Values are release names, enumerations, flags and numbers: never a
 * secret, a path, an address or a URL. A configuration that cannot be read, or
 * a database that cannot be opened, is logged as an error instead of crashing
 * the process, because /api/ready reports it and the release script rolls back.
 */
export function logStartup() {
  let release = "unknown";
  try {
    // Releases are directories under .../releases/<id> behind a "current" symlink.
    release = basename(realpathSync(process.cwd()));
  } catch {
    // keep "unknown"
  }
  const settings: Record<string, string | number | boolean> = {
    release,
    node: process.version,
    pid: process.pid,
    environment: process.env.NODE_ENV ?? "unknown",
  };
  try {
    const email = emailConfig(),
      session = sessionPolicy();
    Object.assign(settings, {
      csp: cspMode(),
      mfa: mfaPolicy(),
      emailTransport: email.transport,
      emailVerification: email.verification,
      passwordRecovery: email.recovery,
      sessionMaxHours: session.absoluteSeconds / 3600,
      sessionIdleMinutes: session.updateAge ? session.expiresIn / 60 : 0,
      trustedProxiesConfigured: Boolean(process.env.SPORTOZEN_TRUSTED_PROXIES),
      httpsDeployment: (process.env.BETTER_AUTH_URL ?? "").startsWith(
        "https://",
      ),
    });
  } catch (error) {
    log("error", "app.configuration_invalid", errorFields(error));
  }
  try {
    database();
    settings.ready = readiness().ready;
  } catch (error) {
    settings.ready = false;
    log("error", "app.database_unavailable", errorFields(error));
  }
  log("info", "app.started", settings);
}
