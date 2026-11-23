// Operational checks and alert delivery (WP8). Provider-neutral: the checks read
// the application, its database and files on this server; alerts leave through
// a command or an HTTPS webhook that the OWNER chooses (nothing is bundled and
// nothing is sent unless one is configured). No secrets, addresses or record
// contents are read into a result: results hold names, numbers and short fixed
// phrases, and anything free-form passes through redact() first.
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:tls";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Same rules as src/server/redact.ts (a test keeps them identical). */
// ISO dates and times are kept as they are (otherwise "2026-11-02" reads as a long number).
const ISO_STAMP = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;
export function redact(value, max = 300) {
  const stamps = [];
  const hidden = String(value).replace(
    ISO_STAMP,
    (m) => `\u0000${stamps.push(m) - 1}\u0000`,
  );
  return hidden
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, "[email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .replace(/\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => stamps[Number(i)])
    .slice(0, max);
}

export const THRESHOLDS = {
  diskWarnFreePercent: 20,
  diskCriticalFreePercent: 10,
  walWarnBytes: 64 * 1024 * 1024,
  walCriticalBytes: 512 * 1024 * 1024,
  lockWarnMs: 300,
  // The worker writes a heartbeat before and after every pass; a pass can take
  // a while when a provider times out, so the limit is generous.
  workerStaleSeconds: 180,
  outboxStuckMinutes: 30,
  abusePausedAccounts: 3,
  certWarnDays: 21,
  certCriticalDays: 7,
  deepCheckStaleDays: 8,
  repeatCriticalMs: 60 * 60 * 1000,
  repeatWarningMs: 24 * 60 * 60 * 1000,
  // A problem must be seen on this many consecutive passes before anyone is told.
  confirmPasses: 2,
  maxAlertsPerRun: 3,
  // No new alert is started after this long into delivery. With the hard
  // per-destination limits below (20 s command + 8 s webhook = 28 s) and about
  // 24 s of checks, a run ends within about 97 s of the unit's TimeoutStartSec=120.
  alertBudgetMs: 45_000,
};
/** Hard limits on one alert destination (a hung destination must never hold the run). */
export const COMMAND_TIMEOUT_MS = 20_000;
export const WEBHOOK_TIMEOUT_MS = 8_000;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000; // src/server/account-security.ts

export function loadOpsConfig(env = process.env) {
  const databasePath = env.SPORTOZEN_DATABASE_PATH
    ? resolve(env.SPORTOZEN_DATABASE_PATH)
    : resolve(".local/workspaces.sqlite");
  const dataDir = dirname(databasePath);
  let command = null;
  if (env.SPORTOZEN_ALERT_COMMAND) {
    let parsed;
    try {
      parsed = JSON.parse(env.SPORTOZEN_ALERT_COMMAND);
    } catch {
      throw new Error(
        "SPORTOZEN_ALERT_COMMAND must be a JSON array of strings (wrap the value in single quotes in the environment file).",
      );
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.length ||
      !parsed.every((p) => typeof p === "string")
    )
      throw new Error(
        "SPORTOZEN_ALERT_COMMAND must be a JSON array of strings.",
      );
    command = parsed;
  }
  // Optional shorter limit for the alert command, 1-20 seconds (default 20).
  let commandTimeoutMs = COMMAND_TIMEOUT_MS;
  if (env.SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS) {
    const seconds = Number(env.SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 20)
      throw new Error(
        "SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS must be a whole number from 1 to 20.",
      );
    commandTimeoutMs = seconds * 1000;
  }
  const webhook = env.SPORTOZEN_ALERT_WEBHOOK_URL || null;
  if (webhook) {
    const url = new URL(webhook);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new Error(
        "SPORTOZEN_ALERT_WEBHOOK_URL must be an https:// address.",
      );
  }
  return {
    databasePath,
    dataDir,
    readyUrl: env.SPORTOZEN_OPS_READY_URL || "http://127.0.0.1:3000/api/ready",
    // "true": a missing or stale worker heartbeat is critical. "false": never
    // checked. Default "auto": checked once the worker has run at least once.
    expectWorker: (env.SPORTOZEN_OPS_EXPECT_WORKER || "auto").toLowerCase(),
    stateDir: env.SPORTOZEN_OPS_STATE_DIR
      ? resolve(env.SPORTOZEN_OPS_STATE_DIR)
      : join(dataDir, "ops"),
    deployLog: env.SPORTOZEN_DEPLOY_LOG || "/srv/sportozen/deployments.log",
    backupDir: env.SPORTOZEN_BACKUP_DIR || null,
    certHost: env.SPORTOZEN_OPS_CERT_HOST || null,
    signInLimit:
      Number(env.SPORTOZEN_SIGNIN_FAILURE_LIMIT) > 0
        ? Number(env.SPORTOZEN_SIGNIN_FAILURE_LIMIT)
        : 10,
    emailEnabled: (env.SPORTOZEN_EMAIL_TRANSPORT || "disabled") !== "disabled",
    alertCommand: command,
    alertCommandTimeoutMs: commandTimeoutMs,
    alertWebhook: webhook,
    serverName: env.SPORTOZEN_SERVER_NAME || hostname(),
  };
}

const result = (name, level, detail, hint) => ({
  name,
  level,
  detail: redact(detail),
  hint,
});
const OK = "ok",
  WARN = "warning",
  CRITICAL = "critical",
  SKIP = "skipped";

async function checkApp(config, fetchImpl) {
  const hint = "docs/OPERATIONS.md#application-unavailable";
  try {
    const response = await fetchImpl(config.readyUrl, {
      signal: AbortSignal.timeout(3000),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    if (response.status === 200 && body?.ready === true)
      return result("app", OK, "ready", hint);
    const failing = Object.entries(body?.checks ?? {})
      .filter(([, v]) => v !== "ok")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return result(
      "app",
      CRITICAL,
      `answered ${response.status}${failing ? `: ${failing}` : ""}`,
      hint,
    );
  } catch {
    return result("app", CRITICAL, "no response from the application", hint);
  }
}
function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}
function checkDatabase(config, deep, fileSize) {
  const hint = "docs/OPERATIONS.md#database-unavailable-or-locked";
  if (!existsSync(config.databasePath))
    return [result("database", CRITICAL, "database file not found", hint)];
  const out = [];
  let reader;
  try {
    reader = openReadOnly(config.databasePath);
    reader.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    if (deep) {
      const started = Date.now();
      const quick = reader
        .prepare("PRAGMA quick_check")
        .all()
        .map((r) => Object.values(r)[0]);
      const foreign = reader.prepare("PRAGMA foreign_key_check").all().length;
      const problems = quick.filter((v) => v !== "ok").length + foreign;
      out.push(
        problems
          ? result(
              "database-integrity",
              CRITICAL,
              `${problems} integrity problem(s) found by quick_check/foreign_key_check`,
              hint,
            )
          : result(
              "database-integrity",
              OK,
              `quick_check and foreign_key_check passed in ${Date.now() - started} ms`,
              hint,
            ),
      );
    }
    out.push(result("database", OK, "readable", hint));
  } catch (error) {
    out.push(
      result(
        "database",
        CRITICAL,
        `cannot be read: ${error.code ?? error.errcode ?? error.name}`,
        hint,
      ),
    );
  } finally {
    try {
      reader?.close();
    } catch {
      /* ignore */
    }
  }
  // Write-lock probe: can a writer get in promptly? (rolled back at once, nothing written)
  let writer;
  try {
    writer = new DatabaseSync(config.databasePath);
    writer.exec("PRAGMA busy_timeout=1000");
    const started = process.hrtime.bigint();
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("ROLLBACK");
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    out.push(
      ms >= THRESHOLDS.lockWarnMs
        ? result(
            "database-lock",
            WARN,
            `a writer waited ${ms} ms for the lock`,
            hint,
          )
        : result("database-lock", OK, `write lock acquired in ${ms} ms`, hint),
    );
  } catch (error) {
    out.push(
      result(
        "database-lock",
        CRITICAL,
        `write lock not obtained within 1 s (${error.code ?? error.errcode ?? error.name})`,
        hint,
      ),
    );
  } finally {
    try {
      writer?.close();
    } catch {
      /* ignore */
    }
  }
  try {
    const wal = fileSize(`${config.databasePath}-wal`);
    out.push(
      wal >= THRESHOLDS.walCriticalBytes
        ? result(
            "database-wal",
            CRITICAL,
            `write-ahead log is ${Math.round(wal / 1048576)} MB (checkpoints are not completing)`,
            hint,
          )
        : wal >= THRESHOLDS.walWarnBytes
          ? result(
              "database-wal",
              WARN,
              `write-ahead log is ${Math.round(wal / 1048576)} MB`,
              hint,
            )
          : result("database-wal", OK, `${Math.round(wal / 1024)} KB`, hint),
    );
  } catch {
    out.push(
      result("database-wal", OK, "no log file (idle or cleanly closed)", hint),
    );
  }
  return out;
}
function checkDisk(config, statfs) {
  const hint = "docs/OPERATIONS.md#disk-space";
  const targets = [
    ["data", config.dataDir],
    ...(config.backupDir ? [["backup", config.backupDir]] : []),
  ];
  return targets.map(([label, dir]) => {
    try {
      const s = statfs(dir);
      const freePercent = (Number(s.bavail) / Number(s.blocks)) * 100;
      const inodes = s.files ? (Number(s.ffree) / Number(s.files)) * 100 : 100;
      const low = Math.min(freePercent, inodes);
      if (!Number.isFinite(low))
        return result(`disk-${label}`, WARN, "could not read disk usage", hint);
      const text = `${freePercent.toFixed(0)}% space and ${inodes.toFixed(0)}% inodes free`;
      return low < THRESHOLDS.diskCriticalFreePercent
        ? result(`disk-${label}`, CRITICAL, text, hint)
        : low < THRESHOLDS.diskWarnFreePercent
          ? result(`disk-${label}`, WARN, text, hint)
          : result(`disk-${label}`, OK, text, hint);
    } catch {
      return result(`disk-${label}`, WARN, "could not read disk usage", hint);
    }
  });
}
function checkBackup(config, env) {
  const hint = "docs/OPERATIONS.md#backup-failure";
  const run = spawnSync(
    process.execPath,
    [join(HERE, "..", "backup-status.mjs"), "--json"],
    {
      env: { ...env, SPORTOZEN_DATABASE_PATH: config.databasePath },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  let report = null;
  try {
    report = JSON.parse(run.stdout.trim().split("\n").pop() ?? "");
  } catch {
    /* not JSON */
  }
  if (!report)
    return result(
      "backup",
      WARN,
      "backup status could not be read (is SPORTOZEN_BACKUP_DIR set?)",
      hint,
    );
  if (run.status === 0) return result("backup", OK, report.verdict, hint);
  if (run.status === 3)
    return result(
      "backup",
      WARN,
      `${report.verdict}; newest backup ${report.lastBackupAgeMinutes ?? "none"} min old`,
      hint,
    );
  const failed = report.lastFailure
    ? `; last failure ${report.lastFailure.at} during ${report.lastFailure.stage}`
    : "";
  return result("backup", CRITICAL, `${report.verdict}${failed}`, hint);
}
function checkWorker(config, now) {
  const hint = "docs/OPERATIONS.md#background-worker";
  if (config.expectWorker === "false")
    return result("worker", SKIP, "not expected on this server", hint);
  let age;
  try {
    age =
      (now - statSync(join(config.dataDir, "worker-heartbeat")).mtimeMs) / 1000;
  } catch {
    return config.expectWorker === "true"
      ? result(
          "worker",
          CRITICAL,
          "no heartbeat file: the worker has not run",
          hint,
        )
      : result(
          "worker",
          SKIP,
          "the worker has never run here (not enabled)",
          hint,
        );
  }
  return age > THRESHOLDS.workerStaleSeconds
    ? result("worker", CRITICAL, `no heartbeat for ${Math.round(age)} s`, hint)
    : result("worker", OK, `heartbeat ${Math.round(age)} s ago`, hint);
}
function checkOutbox(config, now) {
  const hint = "docs/OPERATIONS.md#email-delivery";
  if (!config.emailEnabled)
    return result("email-outbox", SKIP, "e-mail delivery is off", hint);
  let db;
  try {
    db = openReadOnly(config.databasePath);
    const since = new Date(now - 24 * 3600 * 1000).toISOString();
    const failed = Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE status='FAILED' AND finishedAt>=?",
        )
        .get(since).n,
    );
    const stuck = Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE status IN ('QUEUED','SENDING') AND createdAt<?",
        )
        .get(
          new Date(now - THRESHOLDS.outboxStuckMinutes * 60000).toISOString(),
        ).n,
    );
    if (stuck)
      return result(
        "email-outbox",
        WARN,
        `${stuck} message(s) waiting over ${THRESHOLDS.outboxStuckMinutes} min (retries pending or provider down)`,
        hint,
      );
    if (failed)
      return result(
        "email-outbox",
        WARN,
        `${failed} message(s) failed permanently in the last 24 h`,
        hint,
      );
    return result("email-outbox", OK, "no stuck or failed messages", hint);
  } catch {
    return result("email-outbox", WARN, "outbox could not be read", hint);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
function checkAbuse(config, now) {
  const hint = "docs/OPERATIONS.md#authentication-abuse";
  let db;
  try {
    db = openReadOnly(config.databasePath);
    // Only accounts paused in the CURRENT 15-minute window (the previous
    // window's row is kept for a while but no longer blocks anyone).
    const paused = Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM request_rate_limits WHERE scope LIKE 'signin-failure:%' AND bucket=? AND requests>?",
        )
        .get(String(Math.floor(now / SIGN_IN_WINDOW_MS)), config.signInLimit).n,
    );
    return paused >= THRESHOLDS.abusePausedAccounts
      ? result(
          "auth-abuse",
          WARN,
          `${paused} accounts are paused by repeated failed sign-ins (possible password guessing)`,
          hint,
        )
      : result("auth-abuse", OK, `${paused} account(s) currently paused`, hint);
  } catch {
    return result("auth-abuse", SKIP, "rate-limit table not readable", hint);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
function checkDeployments(config, now, appLevel) {
  const hint = "docs/OPERATIONS.md#failed-deployment-and-rollback";
  if (!existsSync(config.deployLog))
    return result("deployment", SKIP, "no deployment log yet", hint);
  const events = readFileSync(config.deployLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-50)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const last = events.at(-1);
  if (!last) return result("deployment", SKIP, "no deployment events", hint);
  const ageMs = now - Date.parse(last.ts);
  const day = 24 * 3600 * 1000;
  const what = `${last.event} ${last.release}`;
  if (last.event === "deploy.failed" || last.event === "rollback.not_ready")
    // Sticky until something newer is logged, but it only stays critical while
    // the application is actually not ready.
    return appLevel === OK
      ? result(
          "deployment",
          WARN,
          `${what}: the latest deployment failed but the service is ready now; confirm which release is live`,
          hint,
        )
      : result(
          "deployment",
          CRITICAL,
          `${what}: the service may not be running the intended release`,
          hint,
        );
  if (
    ageMs < day &&
    (last.event === "deploy.rolled_back" ||
      last.event === "deploy.not_ready" ||
      last.event === "deploy.aborted")
  )
    return result(
      "deployment",
      WARN,
      `${what}: a release failed or was refused in the last 24 h`,
      hint,
    );
  if (
    (last.event === "deploy.started" || last.event === "rollback.started") &&
    ageMs > 15 * 60000
  )
    return result(
      "deployment",
      WARN,
      `${what}: started but never completed`,
      hint,
    );
  return result("deployment", OK, `${what} at ${last.ts}`, hint);
}
/** The last weekly deep check, as a result the every-minute run can keep alerting on. */
function checkDeepRecord(config, now, deepResult) {
  const hint = "docs/OPERATIONS.md#database-unavailable-or-locked";
  const file = join(config.stateDir, "deep.json");
  if (deepResult) {
    try {
      mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({
          at: now,
          level: deepResult.level,
          detail: deepResult.detail,
        }),
        { mode: 0o600 },
      );
    } catch {
      /* state is best effort */
    }
    return deepResult;
  }
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    const days = (now - record.at) / 86400000;
    if (days > THRESHOLDS.deepCheckStaleDays)
      return result(
        "database-integrity",
        WARN,
        `the weekly deep check has not run for ${Math.floor(days)} days`,
        hint,
      );
    return result(
      "database-integrity",
      record.level,
      `${record.detail} (weekly check, ${Math.floor(days)} d ago)`,
      hint,
    );
  } catch {
    return result(
      "database-integrity",
      SKIP,
      "the weekly deep check has not run yet",
      hint,
    );
  }
}
function daysUntil(host) {
  return new Promise((resolveDays, reject) => {
    const socket = connect(
      { host, port: 443, servername: host, timeout: 5000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolveDays((Date.parse(cert.valid_to) - Date.now()) / 86400000);
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}
async function checkCertificate(config, certDays) {
  const hint = "docs/OPERATIONS.md#certificate-expiry";
  if (!config.certHost)
    return result("certificate", SKIP, "SPORTOZEN_OPS_CERT_HOST not set", hint);
  try {
    const days = await certDays(config.certHost);
    return days < THRESHOLDS.certCriticalDays
      ? result(
          "certificate",
          CRITICAL,
          `expires in ${days.toFixed(0)} days`,
          hint,
        )
      : days < THRESHOLDS.certWarnDays
        ? result(
            "certificate",
            WARN,
            `expires in ${days.toFixed(0)} days`,
            hint,
          )
        : result("certificate", OK, `${days.toFixed(0)} days left`, hint);
  } catch {
    return result(
      "certificate",
      CRITICAL,
      "TLS connection to the public name failed",
      hint,
    );
  }
}

/** One check failing to run must not stop the others (or monitoring as a whole). */
async function guarded(name, run) {
  try {
    return await run();
  } catch (error) {
    return [
      result(
        name,
        WARN,
        `the check itself failed: ${error.code ?? error.name}`,
        "docs/OPERATIONS.md",
      ),
    ].flat();
  }
}
/** Runs every check. Dependencies are injectable for tests. */
export async function runOpsChecks(
  config,
  {
    deep = false,
    now = Date.now(),
    env = process.env,
    fetchImpl = fetch,
    statfs = statfsSync,
    certDays = daysUntil,
    fileSize = (path) => statSync(path).size,
  } = {},
) {
  const app = await guarded("app", () => checkApp(config, fetchImpl));
  const database = await guarded("database", () =>
    checkDatabase(config, deep, fileSize),
  );
  const integrity = database.find((r) => r.name === "database-integrity");
  const rest = database.filter((r) => r.name !== "database-integrity");
  return [
    app,
    ...rest,
    await guarded("database-integrity", () =>
      checkDeepRecord(config, now, integrity),
    ),
    ...(await guarded("disk-data", () => checkDisk(config, statfs))),
    await guarded("backup", () => checkBackup(config, env)),
    await guarded("worker", () => checkWorker(config, now)),
    await guarded("email-outbox", () => checkOutbox(config, now)),
    await guarded("auth-abuse", () => checkAbuse(config, now)),
    await guarded("deployment", () => checkDeployments(config, now, app.level)),
    await guarded("certificate", () => checkCertificate(config, certDays)),
  ].flat();
}
export const worst = (results) =>
  results.some((r) => r.level === CRITICAL)
    ? CRITICAL
    : results.some((r) => r.level === WARN)
      ? WARN
      : OK;

/**
 * Decides which alerts to send. State per check: its level, how many passes in
 * a row it has been seen at that level (`seen`), and when it was last alerted
 * (`lastSentAt`, 0 = never).
 *  - A problem is reported only after it is seen on THRESHOLDS.confirmPasses
 *    consecutive passes, so one failed probe or a restart that overlaps a pass
 *    tells nobody.
 *  - After that: once; again if it gets worse; again after an hour (critical)
 *    or a day (warning) while it persists.
 *  - One RESOLVED message when something that was reported clears; a problem
 *    that cleared before it was ever reported produces nothing.
 * Returns the alerts to send and the state to keep (the caller commits the part
 * of it that was actually delivered).
 */
export function decideAlerts(results, state, now) {
  const next = {};
  const send = [];
  for (const r of results) {
    if (r.level !== CRITICAL && r.level !== WARN) continue;
    const before = state[r.name];
    const same = before && before.level === r.level;
    const seen = same ? (before.seen ?? 1) + 1 : 1;
    const repeat =
      r.level === CRITICAL
        ? THRESHOLDS.repeatCriticalMs
        : THRESHOLDS.repeatWarningMs;
    const reported = before?.reported; // the level last alerted, if any
    const lastSentAt = before?.lastSentAt ?? 0;
    const confirmed = seen >= THRESHOLDS.confirmPasses;
    // Due: confirmed, and either not yet reported at this level, or the repeat
    // interval has passed. A one-pass blip to another level and back does not
    // reset the interval, so it cannot cause a duplicate.
    const due =
      confirmed && (reported !== r.level || now - lastSentAt >= repeat);
    next[r.name] = {
      level: r.level,
      since: same ? before.since : now,
      seen,
      lastSentAt: due ? now : lastSentAt,
      ...(due ? { reported: r.level } : reported ? { reported } : {}),
    };
    if (due)
      send.push({
        kind: !reported ? "NEW" : reported !== r.level ? "CHANGED" : "REMINDER",
        ...r,
      });
  }
  for (const [name, before] of Object.entries(state)) {
    if (next[name]) continue;
    const seenNow = results.find((r) => r.name === name);
    if (!seenNow || seenNow.level === SKIP) {
      next[name] = before; // not evaluated (or switched off) this pass: keep as it was
    } else if (before.reported) {
      send.push({
        kind: "RESOLVED",
        name,
        level: OK,
        detail: "back to normal",
        hint: "",
      });
    } // else: a problem that cleared before it was ever reported is simply dropped
  }
  return { send, state: next };
}
export function formatAlert(alert, config, now = Date.now()) {
  const severity =
    alert.level === CRITICAL
      ? "CRITICAL"
      : alert.level === WARN
        ? "WARNING"
        : alert.level === "info"
          ? "TEST"
          : "RESOLVED";
  // Only the free-text parts are redacted; the time stamp and fixed words are not
  // (redaction would read a date as a long number).
  const detail = redact(alert.detail, 240),
    server = redact(config.serverName, 40);
  const subject =
    `[Sportozen ${server}] ${severity} ${alert.name}: ${detail}`.slice(0, 200);
  const body = [
    `${alert.kind}: ${alert.name} is ${alert.level}`,
    `Detail: ${detail}`,
    alert.hint ? `What to do: ${alert.hint}` : "",
    `Server: ${server}`,
    `Time: ${new Date(now).toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { severity, subject, body };
}
/**
 * Ends a process and everything it started. The command is started as the
 * leader of its own process group (not on Windows, where taskkill walks the
 * tree), so a wrapper script that is hung, or ignores SIGTERM, cannot outlive
 * the deadline, and neither can the programs it launched.
 */
function endProcessTree(child) {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
/**
 * Runs the alert command with a HARD deadline. spawn()'s own `timeout` option
 * only sends SIGTERM to the direct child, never escalates and never settles
 * the promise, so a command that ignored SIGTERM held the run until systemd
 * killed it. Here a timer kills the whole process group with SIGKILL and
 * settles the outcome itself, whatever the command does.
 */
const runningCommands = new Set();
/** Ends every alert command still running (the run itself is being stopped). */
export function endRunningCommands() {
  for (const child of runningCommands) endProcessTree(child);
  runningCommands.clear();
}
function runAlertCommand(argv, timeoutMs) {
  return new Promise((resolveOutcome) => {
    let timer;
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      runningCommands.delete(child);
      resolveOutcome(outcome);
    };
    let child;
    try {
      // No shell: an alert text can never be interpreted as a command.
      child = spawn(argv[0], argv.slice(1), {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      finish({ sink: "command", ok: false });
      return;
    }
    runningCommands.add(child);
    timer = setTimeout(() => {
      endProcessTree(child);
      finish({ sink: "command", ok: false, timedOut: true });
    }, timeoutMs);
    child.on("error", () => finish({ sink: "command", ok: false }));
    child.on("exit", (code) => finish({ sink: "command", ok: code === 0 }));
  });
}
/** Sends one alert through every configured destination; never throws. */
export async function sendAlert(
  config,
  message,
  {
    fetchImpl = fetch,
    commandTimeoutMs = config.alertCommandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    webhookTimeoutMs = WEBHOOK_TIMEOUT_MS,
  } = {},
) {
  const outcomes = [];
  if (config.alertCommand) {
    const argv = config.alertCommand.map((part) =>
      part
        .replaceAll("{subject}", message.subject)
        .replaceAll("{body}", message.body)
        .replaceAll("{severity}", message.severity),
    );
    outcomes.push(await runAlertCommand(argv, commandTimeoutMs));
  }
  if (config.alertWebhook) {
    try {
      const response = await fetchImpl(config.alertWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          severity: message.severity,
          subject: message.subject,
          text: message.body,
          server: config.serverName,
        }),
        // The body is an alert, not something to forward to wherever a redirect points.
        redirect: "error",
        signal: AbortSignal.timeout(webhookTimeoutMs),
      });
      outcomes.push({ sink: "webhook", ok: response.ok });
    } catch {
      outcomes.push({ sink: "webhook", ok: false });
    }
  }
  return outcomes;
}
export function readState(config) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(config.stateDir, "alerts.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
export function writeState(config, state) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const target = join(config.stateDir, "alerts.json");
  // A name of its own: two writers must never share one temporary file.
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    // A full disk or a failed rename must not leave a new orphan every minute.
    try {
      unlinkSync(temporary);
    } catch {
      /* never created */
    }
    throw error;
  }
}
/**
 * The state to keep after delivery: the new state for every alert that was
 * delivered (or that needed no delivery), and the OLD state for any alert whose
 * delivery failed or was held back, so only that one is retried next pass.
 */
export function commitState(previous, decided, delivered) {
  const kept = { ...decided.state };
  for (const alert of decided.send) {
    if (delivered.has(alert.name)) continue;
    const old = previous[alert.name];
    // Undelivered: keep counting, but put "last alerted" back as it was so the
    // same alert is due again on the next pass. An undelivered RESOLVED keeps
    // its old entry so it is retried.
    if (kept[alert.name]) {
      const { reported, ...rest } = kept[alert.name];
      void reported;
      kept[alert.name] = {
        ...rest,
        lastSentAt: old?.lastSentAt ?? 0,
        ...(old?.reported ? { reported: old.reported } : {}),
      };
    } else if (old) kept[alert.name] = old;
  }
  return kept;
}

/**
 * Only one run at a time handles alerts (the every-minute run and the weekly deep
 * run are separate units and could overlap, and each reads and rewrites the
 * state). Returns a release function, or null when another run holds the lock.
 *
 * The lock file names its owner (process id, a random token, the time). A run
 * releases the lock only if the file still carries ITS token, and can ask
 * `release.owned()` whether it still holds it, so a run that was taken over can
 * neither delete the new holder's lock nor overwrite its state. A lock is
 * stale when its process no longer exists (no waiting after a crash and no
 * dependence on the clock) or when it is older than five minutes (a holder
 * that is hung; with the hard delivery limits a healthy run takes far less).
 */
export const LOCK_STALE_MS = 5 * 60_000;
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, but is somebody else's
  }
}
function readLockFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && Number.isFinite(parsed.at))
      return { pid: parsed.pid, at: parsed.at };
  } catch {
    /* the previous format: just the time */
  }
  return { pid: null, at: Number(raw) };
}
export function acquireAlertLock(config, now = Date.now()) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const file = join(config.stateDir, "alerts.lock");
  const mine = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    at: now,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
      const release = () => {
        // Only a lock that is still mine: a run that was taken over (it hung
        // past the stale limit) must not delete its successor's lock.
        if (readLockFile(file) !== mine) return;
        try {
          unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
      release.owned = () => readLockFile(file) === mine;
      return release;
    } catch {
      const raw = readLockFile(file);
      if (raw === null) {
        // Gone (try again) or present but unreadable (a leftover nobody can
        // read): the latter is removed, or every later run would see "locked".
        if (existsSync(file)) {
          try {
            unlinkSync(file);
          } catch {
            return null;
          }
        }
        continue;
      }
      const held = parseLock(raw);
      const age = now - held.at;
      const holderGone = held.pid !== null && !processExists(held.pid);
      const stale = holderGone || !(age < LOCK_STALE_MS); // NaN counts as stale
      if (!stale) return null;
      // Take over only the very lock that was judged stale (it may have been
      // replaced a moment ago by another run that won the race).
      if (readLockFile(file) === raw) {
        try {
          unlinkSync(file);
        } catch {
          /* someone else took it over */
        }
      }
    }
  }
  return null;
}

/**
 * One alert pass: lock, decide, deliver (bounded), save the state after every
 * alert. Returns { undelivered, locked } where `locked` means another run holds
 * the lock and this pass did nothing. The lock is released on every exit path,
 * including SIGTERM and SIGINT (systemd stopping the unit), and delivery stops
 * at once if the lock was lost to another run.
 */
export async function runAlertPass(
  config,
  results,
  {
    send = sendAlert,
    now = () => Date.now(),
    budgetMs = THRESHOLDS.alertBudgetMs,
    log = (line) => console.error(line),
  } = {},
) {
  const destination = Boolean(config.alertCommand || config.alertWebhook);
  const release = destination ? acquireAlertLock(config, now()) : () => {};
  if (!release) return { undelivered: 0, locked: true };
  const owned = release.owned ?? (() => true);
  let undelivered = 0;
  const onSignal = (signal) => {
    endRunningCommands(); // a hung command is not left behind
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const started = now();
    const previous = readState(config);
    const decided = decideAlerts(results, previous, started);
    if (!destination && decided.send.length)
      log(
        "WARNING: alerts are due but no destination is configured (SPORTOZEN_ALERT_COMMAND or SPORTOZEN_ALERT_WEBHOOK_URL).",
      );
    const delivered = new Set();
    const save = () => {
      // A run that lost the lock must not overwrite the new holder's state.
      if (!owned()) {
        log("ERROR: the alert lock was taken over; state not saved.");
        undelivered++;
        return false;
      }
      try {
        writeState(config, commitState(previous, decided, delivered));
      } catch (error) {
        log(`ERROR: alert state could not be saved: ${error.code ?? error.name}`);
        undelivered++;
      }
      return true;
    };
    // Without a destination nothing is remembered as sent, so configuring one
    // later still reports what is wrong.
    if (destination) save();
    // A bounded number per pass, within a time budget, and the state is saved
    // after EACH alert, so being stopped part-way never repeats what was sent.
    const due = decided.send.slice(0, THRESHOLDS.maxAlertsPerRun);
    let handled = 0;
    for (const alert of due) {
      if (now() - started >= budgetMs || (destination && !owned())) break;
      handled++;
      const outcomes = await send(config, formatAlert(alert, config, started));
      // Told somewhere = delivered (re-sending to the destination that works
      // every minute would only be noise); a destination that failed is still
      // reported through the exit status so the unit shows it.
      if (outcomes.some((o) => o.ok)) delivered.add(alert.name);
      if (destination && outcomes.some((o) => !o.ok)) undelivered++;
      if (destination && !save()) break;
    }
    // What was not attempted (over the per-run limit, out of time, or the lock
    // was lost) stays due and is retried on the next pass.
    if (destination)
      undelivered += Math.max(0, decided.send.length - handled);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    release();
  }
  return { undelivered, locked: false };
}
