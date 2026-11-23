// Production preflight checks. Pure functions over an environment object so
// they can be unit tested; scripts/preflight.mjs is the command line wrapper.
// A check never returns a secret value, only whether it is acceptable.
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";

export const NODE_MIN = [24, 13, 0];
/** Variables that change the build output or expose demonstration routes. */
export const QA_FLAGS = [
  "SPORTOZEN_QA_BUILD",
  "SPORTOZEN_GALLERY_QA",
  "SPORTOZEN_FINAL_QA",
  "SPORTOZEN_HOME_UI_QA",
  "SPORTOZEN_REPORTS_QA",
  "SPORTOZEN_PLAYER_FORM_QA",
];
export const EMAIL_TRANSPORTS = ["disabled", "postmark"]; // "capture" and "file" are for tests and local use and are never valid for a deployment
const pass = (name, message) => ({ level: "PASS", name, message });
const warn = (name, message) => ({ level: "WARN", name, message });
const fail = (name, message) => ({ level: "FAIL", name, message });

/** Response headers that must be baked into the build by next.config.ts. */
export const BAKED_HEADERS = [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Cross-Origin-Resource-Policy",
];
export function parseNodeVersion(version) {
  return version.replace(/^v/, "").split(".").map(Number);
}
function nodeAcceptable([major, minor, patch]) {
  if (major !== NODE_MIN[0]) return false; // 24.x only: node:sqlite is version sensitive
  if (minor !== NODE_MIN[1]) return minor > NODE_MIN[1];
  return patch >= NODE_MIN[2];
}
export function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
/** A comma separated list of IPs or CIDR ranges. Returns the invalid entries. */
export function invalidProxyEntries(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const [address, prefix, extra] = entry.split("/");
      const version = isIP(address);
      if (!version || extra !== undefined) return true;
      if (prefix === undefined) return false;
      return (
        !/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)
      );
    });
}

function checkNode(version) {
  const parsed = parseNodeVersion(version);
  return nodeAcceptable(parsed)
    ? pass("node", `Node ${version} is within >=24.13.0 <25`)
    : fail(
        "node",
        `Node ${version} is outside >=24.13.0 <25 (node:sqlite is version sensitive)`,
      );
}
function checkUrl(env) {
  const raw = env.BETTER_AUTH_URL;
  if (!raw) return fail("BETTER_AUTH_URL", "is not set");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("BETTER_AUTH_URL", "is not a valid URL");
  }
  if (url.protocol !== "https:")
    return fail("BETTER_AUTH_URL", "must use https");
  if (url.pathname !== "/" || url.search || url.hash || url.username)
    return fail(
      "BETTER_AUTH_URL",
      "must be a bare origin such as https://host (no path, query or credentials)",
    );
  const host = url.hostname;
  if (
    host === "localhost" ||
    host.startsWith("127.") ||
    host === "[::1]" ||
    isIP(host.replace(/^\[|\]$/g, ""))
  )
    return fail(
      "BETTER_AUTH_URL",
      "must be a public domain name, not localhost or an IP address",
    );
  if (
    /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|org|net)$/.test(
      host,
    )
  )
    return fail(
      "BETTER_AUTH_URL",
      "is a placeholder domain; the owner has not yet approved a real one",
    );
  return pass("BETTER_AUTH_URL", `origin ${url.origin}`);
}
function checkSecret(env) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return fail("BETTER_AUTH_SECRET", "is not set");
  if (secret.length < 32)
    return fail("BETTER_AUTH_SECRET", "must be at least 32 characters");
  if (/change.?me|placeholder|example|your.?secret|^(.)\1+$/i.test(secret))
    return fail("BETTER_AUTH_SECRET", "looks like a placeholder");
  return pass(
    "BETTER_AUTH_SECRET",
    `set (${secret.length} characters, value not shown)`,
  );
}
function modeOf(path) {
  return statSync(path).mode & 0o777;
}
function checkStorage(env, cwd, platform) {
  const raw = env.SPORTOZEN_DATABASE_PATH;
  if (!raw)
    return fail(
      "SPORTOZEN_DATABASE_PATH",
      "is not set; the default is a relative path inside the release directory",
    );
  if (!isAbsolute(raw))
    return fail(
      "SPORTOZEN_DATABASE_PATH",
      "must be an absolute path on persistent storage",
    );
  if (isInside(cwd, raw))
    return fail(
      "SPORTOZEN_DATABASE_PATH",
      "is inside the application directory and would be replaced by a deployment",
    );
  const directory = resolve(raw, "..");
  if (!existsSync(directory))
    return fail("SPORTOZEN_DATABASE_PATH", "parent directory does not exist");
  try {
    accessSync(directory, constants.R_OK | constants.W_OK);
  } catch {
    return fail(
      "SPORTOZEN_DATABASE_PATH",
      "parent directory is not readable and writable by this user",
    );
  }
  const problems = [];
  if (platform !== "win32") {
    const directoryMode = modeOf(directory);
    if (directoryMode & 0o007)
      problems.push(
        `directory mode ${directoryMode.toString(8)} is accessible to everyone`,
      );
    if (existsSync(raw)) {
      const fileMode = modeOf(raw);
      if (fileMode & 0o007)
        problems.push(
          `database mode ${fileMode.toString(8)} is readable by everyone`,
        );
    }
  }
  if (problems.length)
    return fail("SPORTOZEN_DATABASE_PATH", problems.join("; "));
  return pass(
    "SPORTOZEN_DATABASE_PATH",
    `${directory} is absolute, outside the app directory, writable and private`,
  );
}
function checkQaFlags(env) {
  const set = QA_FLAGS.filter((name) => env[name] === "1");
  return set.length
    ? fail("QA flags", `${set.join(", ")} must not be set for production`)
    : pass("QA flags", "no QA flag is set");
}
/** The build loads the authentication module (it refuses an HTTPS origin without
 * a secret) and opens a database, so both must be set; neither value is
 * embedded in the output, so throw-away values are right. */
function checkBuildSecretsAndStorage(env, cwd) {
  const out = [];
  out.push(
    env.BETTER_AUTH_SECRET
      ? pass(
          "build secret",
          "set (any throw-away value is enough; the real secret is read at runtime)",
        )
      : fail(
          "BETTER_AUTH_SECRET",
          "must be set for the build; use a throw-away value, not the real secret",
        ),
  );
  const path = env.SPORTOZEN_DATABASE_PATH;
  out.push(
    !path || !isAbsolute(path) || isInside(cwd, path)
      ? fail(
          "SPORTOZEN_DATABASE_PATH",
          "set it to a throw-away absolute path outside the build directory, or the build leaves a database behind",
        )
      : pass(
          "build database path",
          "throw-away path outside the build directory",
        ),
  );
  return out;
}
function checkLimits(env) {
  const value = env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE;
  if (value === undefined || value === "")
    return pass("write limit", "default");
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100000
    ? pass("write limit", `${value} a minute`)
    : fail(
        "SPORTOZEN_WRITE_LIMIT_PER_MINUTE",
        "must be an integer from 1 to 100000",
      );
}
function checkProxy(env) {
  const out = [];
  const proxies = env.SPORTOZEN_TRUSTED_PROXIES;
  if (proxies === undefined || proxies === "")
    out.push(
      pass(
        "trusted proxies",
        "none configured: only a single-valued forwarded header is trusted",
      ),
    );
  else {
    const bad = invalidProxyEntries(proxies);
    out.push(
      bad.length
        ? fail(
            "SPORTOZEN_TRUSTED_PROXIES",
            `${bad.length} invalid entr${bad.length === 1 ? "y" : "ies"}; use IPs or CIDR ranges`,
          )
        : pass("trusted proxies", "valid"),
    );
  }
  const header = env.SPORTOZEN_CLIENT_IP_HEADER;
  if (header && !/^[a-z0-9-]+$/i.test(header))
    out.push(
      fail("SPORTOZEN_CLIENT_IP_HEADER", "must be a single header name"),
    );
  return out;
}
function checkEmail(env) {
  const out = [];
  const transport = env.SPORTOZEN_EMAIL_TRANSPORT || "disabled";
  const verification = env.SPORTOZEN_EMAIL_VERIFICATION || "off";
  const recovery = env.SPORTOZEN_PASSWORD_RECOVERY || "off";
  if (!EMAIL_TRANSPORTS.includes(transport))
    out.push(
      fail(
        "SPORTOZEN_EMAIL_TRANSPORT",
        `"${transport}" is not valid for a deployment (use "disabled" or "postmark"; "capture" and "file" are for tests and local use)`,
      ),
    );
  if (!["off", "required"].includes(verification))
    out.push(
      fail("SPORTOZEN_EMAIL_VERIFICATION", 'must be "off" or "required"'),
    );
  if (!["off", "on"].includes(recovery))
    out.push(fail("SPORTOZEN_PASSWORD_RECOVERY", 'must be "off" or "on"'));
  if (
    transport === "disabled" &&
    (verification === "required" || recovery === "on")
  )
    out.push(
      fail(
        "email",
        "verification or recovery is enabled but no email transport is configured; users would be locked out",
      ),
    );
  if (transport === "postmark") {
    if (!(env.SPORTOZEN_POSTMARK_TOKEN || "").trim())
      out.push(
        fail("SPORTOZEN_POSTMARK_TOKEN", "is not set (the Postmark Server API token)"),
      );
    if (!/@[^\s@]+\.[^\s@]+/.test(env.SPORTOZEN_EMAIL_FROM || ""))
      out.push(
        fail(
          "SPORTOZEN_EMAIL_FROM",
          "must be a sender address on a domain verified with the provider",
        ),
      );
    if (
      !env.SPORTOZEN_POSTMARK_WEBHOOK_USER ||
      (env.SPORTOZEN_POSTMARK_WEBHOOK_PASSWORD || "").length < 16
    )
      out.push(
        warn(
          "email bounces",
          "webhook credentials are not set: bounces and complaints will not be recorded",
        ),
      );
  }
  if (!out.some((o) => o.level === "FAIL"))
    out.push(
      transport === "disabled"
        ? warn(
            "email",
            "no email transport: verification, recovery and invitation delivery are off (owner decision pending)",
          )
        : pass("email", `transport ${transport}`),
    );
  return out;
}
function checkAccounts(env) {
  const out = [];
  const mfa = (env.SPORTOZEN_MFA || "off").trim().toLowerCase();
  if (!["off", "staff", "all"].includes(mfa))
    out.push(fail("SPORTOZEN_MFA", 'must be "off", "staff" or "all"'));
  else
    out.push(
      mfa === "off"
        ? warn(
            "two-step verification",
            "not required of anyone (owner decision pending); staff and platform administrators can still enrol",
          )
        : pass("two-step verification", `required for ${mfa}`),
    );
  const number = (name, min, max) => {
    const raw = (env[name] ?? "").trim();
    if (raw === "") return undefined;
    return /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max
      ? Number(raw)
      : null;
  };
  const maxHours = number("SPORTOZEN_SESSION_MAX_HOURS", 1, 72);
  const idle = number("SPORTOZEN_SESSION_IDLE_MINUTES", 5, 72 * 60);
  if (maxHours === null)
    out.push(
      fail(
        "SPORTOZEN_SESSION_MAX_HOURS",
        "must be a whole number from 1 to 72",
      ),
    );
  if (idle === null)
    out.push(
      fail(
        "SPORTOZEN_SESSION_IDLE_MINUTES",
        "must be a whole number from 5 upwards",
      ),
    );
  else if (
    idle !== undefined &&
    maxHours !== null &&
    idle > (maxHours ?? 8) * 60
  )
    out.push(
      fail(
        "SPORTOZEN_SESSION_IDLE_MINUTES",
        "cannot be longer than the absolute session limit",
      ),
    );
  const attempts = number("SPORTOZEN_SIGNIN_FAILURE_LIMIT", 1, 100000);
  if (attempts === null)
    out.push(
      fail(
        "SPORTOZEN_SIGNIN_FAILURE_LIMIT",
        "must be a whole number from 1 to 100000",
      ),
    );
  return out;
}
function checkBrowserPolicy(env) {
  const mode = (env.SPORTOZEN_CSP || "enforce").trim().toLowerCase();
  if (!["enforce", "report-only", "off"].includes(mode))
    return [fail("SPORTOZEN_CSP", 'must be "enforce", "report-only" or "off"')];
  return [
    mode === "enforce"
      ? pass("content security policy", "enforced")
      : warn(
          "content security policy",
          `${mode}: pages are not protected against injected scripts; use "enforce" in production`,
        ),
  ];
}
function checkMonitoring(env) {
  const out = [];
  const command = env.SPORTOZEN_ALERT_COMMAND,
    webhook = env.SPORTOZEN_ALERT_WEBHOOK_URL;
  let configured = false;
  if (command) {
    try {
      const parsed = JSON.parse(command);
      if (
        !Array.isArray(parsed) ||
        !parsed.length ||
        !parsed.every((part) => typeof part === "string")
      )
        throw new Error("shape");
      configured = true;
    } catch {
      out.push(
        warn(
          "SPORTOZEN_ALERT_COMMAND",
          "must be a JSON array of strings in single quotes; alerts will not be sent until fixed",
        ),
      );
    }
  }
  if (webhook) {
    try {
      const url = new URL(webhook);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
        url.hostname,
      );
      if (url.protocol === "https:" || (url.protocol === "http:" && loopback))
        configured = true;
      else
        out.push(
          warn(
            "SPORTOZEN_ALERT_WEBHOOK_URL",
            "must be an https:// address; alerts will not be sent until fixed",
          ),
        );
    } catch {
      out.push(
        warn(
          "SPORTOZEN_ALERT_WEBHOOK_URL",
          "is not a valid URL; alerts will not be sent until fixed",
        ),
      );
    }
  }
  const level = (env.SPORTOZEN_LOG_LEVEL || "info").trim().toLowerCase();
  if (!["info", "warn", "error"].includes(level))
    out.push(
      warn(
        "SPORTOZEN_LOG_LEVEL",
        'must be "info", "warn" or "error"; "info" is used',
      ),
    );
  if (!out.length)
    out.push(
      configured
        ? pass("alerts", "a destination is configured")
        : warn(
            "alerts",
            "no alert destination: failures are logged but nobody is told (owner decision on monitoring pending)",
          ),
    );
  return out;
}
function checkBackups(env, cwd) {
  const out = [];
  const directory = env.SPORTOZEN_BACKUP_DIR;
  if (!directory)
    out.push(
      warn(
        "backups",
        "SPORTOZEN_BACKUP_DIR is not set; no automated backup will run",
      ),
    );
  else if (!isAbsolute(directory))
    out.push(fail("SPORTOZEN_BACKUP_DIR", "must be absolute"));
  else if (isInside(cwd, directory))
    out.push(
      fail("SPORTOZEN_BACKUP_DIR", "must be outside the application directory"),
    );
  else if (
    env.SPORTOZEN_DATABASE_PATH &&
    isInside(resolve(env.SPORTOZEN_DATABASE_PATH, ".."), directory)
  )
    out.push(
      fail("SPORTOZEN_BACKUP_DIR", "must not be inside the database directory"),
    );
  else
    out.push(
      pass(
        "SPORTOZEN_BACKUP_DIR",
        "absolute and outside the application and database directories",
      ),
    );
  if (
    directory &&
    !env.SPORTOZEN_BACKUP_TARGET_DIR &&
    !env.SPORTOZEN_BACKUP_TARGET_COMMAND
  )
    out.push(
      warn(
        "backups",
        "no off-server target configured (SPORTOZEN_BACKUP_TARGET_DIR or SPORTOZEN_BACKUP_TARGET_COMMAND)",
      ),
    );
  if (
    directory &&
    !env.SPORTOZEN_BACKUP_ENCRYPTION_KEY &&
    env.SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED !== "1"
  )
    out.push(
      warn(
        "backups",
        "no SPORTOZEN_BACKUP_ENCRYPTION_KEY; backups of children's data would be refused unencrypted",
      ),
    );
  if (!env.SPORTOZEN_BACKUP_RPO_MINUTES || !env.SPORTOZEN_BACKUP_RTO_MINUTES)
    out.push(
      warn(
        "recovery objectives",
        "RPO/RTO are not set; they are pending owner approval",
      ),
    );
  return out;
}
/** Reads the header list Next.js baked into the build. */
function checkArtifact(cwd) {
  const file = join(cwd, ".next", "routes-manifest.json");
  if (!existsSync(file))
    return [fail("build artifact", `${file} not found; run pnpm build first`)];
  const out = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [fail("build artifact", "routes-manifest.json is not valid JSON")];
  }
  const keys = new Set(
    (manifest.headers ?? []).flatMap((rule) => rule.headers.map((h) => h.key)),
  );
  // Headers fixed at build time (next.config.ts). The Content-Security-Policy and
  // X-Request-Id are NOT here: src/proxy.ts sets them per request.
  for (const key of BAKED_HEADERS)
    out.push(
      keys.has(key)
        ? pass(`header ${key}`, "baked into the build")
        : fail(
            `header ${key}`,
            "missing from the build; build with the production BETTER_AUTH_URL (https)",
          ),
    );
  out.push(
    existsSync(join(cwd, ".next", "BUILD_ID"))
      ? pass("BUILD_ID", "present")
      : fail("BUILD_ID", "missing; the build is incomplete"),
  );
  return out;
}

/**
 * mode "start": everything the running service needs.
 * mode "build": what must be true when `next build` runs (HTTPS origin so HSTS is baked in).
 * mode "artifact": start checks plus the finished build output.
 */
export function runChecks({ env, cwd, nodeVersion, platform, mode = "start" }) {
  const results = [checkNode(nodeVersion), checkQaFlags(env), checkUrl(env)];
  if (mode === "build")
    return [...results, ...checkBuildSecretsAndStorage(env, cwd)];
  results.push(
    checkSecret(env),
    checkStorage(env, cwd, platform),
    checkLimits(env),
    ...checkProxy(env),
    ...checkEmail(env),
    ...checkAccounts(env),
    ...checkBrowserPolicy(env),
    ...checkMonitoring(env),
    ...checkBackups(env, cwd),
  );
  if (mode === "artifact") results.push(...checkArtifact(cwd));
  return results;
}
export const failed = (results) => results.filter((r) => r.level === "FAIL");
