// WP8: the operational checks and alerting (scripts/lib/ops.mjs, ops-check.mjs,
// ops-alert.mjs), run against a real database created by the application, a
// fake application endpoint and fake alert destinations.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });
import {
  THRESHOLDS,
  acquireAlertLock,
  commitState,
  decideAlerts,
  formatAlert,
  loadOpsConfig,
  redact as opsRedact,
  runOpsChecks,
  sendAlert,
} from "../../scripts/lib/ops.mjs";
import { redact } from "@/server/redact";

let root: string, dataDir: string, databasePath: string;
let configFor: (
  extra?: Record<string, string>,
) => ReturnType<typeof loadOpsConfig>;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const ready = (status = 200, body: unknown = { ready: true, checks: {} }) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const stat = (freePercent: number) => () => ({
  bavail: freePercent,
  blocks: 100,
  files: 1000,
  ffree: 900,
});
const find = (results: { name: string }[], name: string) =>
  results.find((r) => r.name === name) as unknown as {
    level: string;
    detail: string;
  };
const run = (
  extra: Parameters<typeof runOpsChecks>[1] = {},
  env: Record<string, string> = {},
) =>
  runOpsChecks(configFor(env), {
    now: NOW,
    fetchImpl: ready(),
    statfs: stat(80) as never,
    fileSize: () => 4096,
    env: { ...process.env, SPORTOZEN_BACKUP_DIR: join(root, "no-backups") },
    certDays: async () => 90,
    ...extra,
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sportozen-ops-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  databasePath = join(dataDir, "workspaces.sqlite");
  process.env.SPORTOZEN_DATABASE_PATH = databasePath;
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
  // The application creates its own schema.
  const { database } = await import("@/server/database");
  database();
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  configFor = (extra = {}) =>
    loadOpsConfig({
      ...process.env,
      SPORTOZEN_DATABASE_PATH: databasePath,
      SPORTOZEN_DEPLOY_LOG: join(root, "deployments.log"),
      SPORTOZEN_OPS_STATE_DIR: join(root, "ops"),
      ...extra,
    });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(dataDir, "worker-heartbeat"), { force: true });
  rmSync(join(root, "deployments.log"), { force: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout=2000");
  db.exec("DELETE FROM request_rate_limits");
  db.exec("DELETE FROM email_outbox");
  db.close();
});

describe("configuration", () => {
  it("accepts a JSON-array command and an https webhook, and refuses anything else", () => {
    expect(
      configFor({ SPORTOZEN_ALERT_COMMAND: '["/usr/bin/notify","{subject}"]' })
        .alertCommand,
    ).toEqual(["/usr/bin/notify", "{subject}"]);
    expect(() =>
      configFor({ SPORTOZEN_ALERT_COMMAND: "notify --now" }),
    ).toThrow(/JSON array/);
    expect(() => configFor({ SPORTOZEN_ALERT_COMMAND: "[]" })).toThrow();
    expect(() => configFor({ SPORTOZEN_ALERT_COMMAND: "[1]" })).toThrow();
    expect(() =>
      configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "http://hooks.example/x" }),
    ).toThrow(/https/);
    expect(
      configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "https://hooks.example/x" })
        .alertWebhook,
    ).toBe("https://hooks.example/x");
  });
  it("redacts exactly as the application's logger does", () => {
    for (const sample of [
      "token abcdefghijklmnopqrstuvwxyz0123 at https://x.example/a?b=c for a.b@example.org",
      "call +91 98765 43210 now; Bearer abc.def-ghi",
      "plain words only",
      "last failure 2026-11-02T12:24:15.527Z call +91 98765 43210",
    ])
      expect(opsRedact(sample)).toBe(redact(sample));
  });
});

describe("the application", () => {
  it("is ok when ready, and critical when it answers 503 (naming what is failing) or not at all", async () => {
    expect(find(await run(), "app").level).toBe("ok");
    const down = find(
      await run({
        fetchImpl: ready(503, {
          ready: false,
          checks: { database: "failed", schema: "failed" },
        }),
      }),
      "app",
    );
    expect(down.level).toBe("critical");
    expect(down.detail).toContain("database=failed");
    const none = find(
      await run({
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      }),
      "app",
    );
    expect(none.level).toBe("critical");
    expect(none.detail).toContain("no response");
  });
});

describe("the database", () => {
  it("is readable with a prompt write lock and a quiet log", async () => {
    const results = await run({}, {});
    expect(find(results, "database").level).toBe("ok");
    expect(find(results, "database-lock").level).toBe("ok");
    expect(find(results, "database-wal").level).toBe("ok");
  });
  it("reports a writer that cannot get the lock as critical (database locked)", async () => {
    const holder = new DatabaseSync(databasePath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const lock = find(await run(), "database-lock");
      expect(lock.level).toBe("critical");
      expect(lock.detail).toContain("write lock not obtained");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
  it("reports a missing or unreadable database file as critical", async () => {
    const missing = find(
      await run(
        {},
        { SPORTOZEN_DATABASE_PATH: join(root, "nothing-here.sqlite") },
      ),
      "database",
    );
    expect(missing.level).toBe("critical");
    const garbage = join(root, "garbage.sqlite");
    writeFileSync(garbage, "this is not a database ".repeat(200));
    const broken = (await run({}, { SPORTOZEN_DATABASE_PATH: garbage })).filter(
      (r) => r.name === "database",
    );
    expect(broken[0].level).toBe("critical");
  });
  it("warns, then goes critical, as the write-ahead log grows", async () => {
    const level = async (bytes: number) =>
      find(await run({ fileSize: () => bytes }), "database-wal").level;
    expect(await level(1024)).toBe("ok");
    expect(await level(THRESHOLDS.walWarnBytes)).toBe("warning");
    expect(await level(THRESHOLDS.walCriticalBytes)).toBe("critical");
  });
  it("finds integrity problems in a deep check and not in a clean database", async () => {
    expect(find(await run({ deep: true }), "database-integrity").level).toBe(
      "ok",
    );
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout=2000");
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare(
      "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES('no-such-academy','T','[]','ACTIVE')",
    ).run();
    db.close();
    try {
      expect(find(await run({ deep: true }), "database-integrity").level).toBe(
        "critical",
      );
    } finally {
      const cleanup = new DatabaseSync(databasePath);
      cleanup.exec("PRAGMA busy_timeout=2000");
      cleanup.exec(
        "DELETE FROM platform_entitlements WHERE academyId='no-such-academy'",
      );
      cleanup.close();
    }
  });
});

describe("disk, worker, outbox, abuse, deployments, certificate", () => {
  it("disk: ok, warning below 20% free, critical below 10%", async () => {
    const level = async (free: number) =>
      find(await run({ statfs: stat(free) as never }), "disk-data").level;
    expect(await level(60)).toBe("ok");
    expect(await level(15)).toBe("warning");
    expect(await level(5)).toBe("critical");
  });
  it("worker: checked once it has run; a missing file is critical only when it is expected", async () => {
    // Never run here: not a failure by default, critical when the owner says it is expected.
    expect(find(await run(), "worker").level).toBe("skipped");
    expect(
      find(await run({}, { SPORTOZEN_OPS_EXPECT_WORKER: "true" }), "worker")
        .level,
    ).toBe("critical");
    const file = join(dataDir, "worker-heartbeat");
    writeFileSync(file, "x");
    utimesSync(file, NOW / 1000 - 10, NOW / 1000 - 10);
    expect(find(await run(), "worker").level).toBe("ok");
    // Once it has run, a stale heartbeat is critical with no configuration at all.
    utimesSync(file, NOW / 1000 - 600, NOW / 1000 - 600);
    expect(find(await run(), "worker").level).toBe("critical");
    expect(
      find(await run({}, { SPORTOZEN_OPS_EXPECT_WORKER: "false" }), "worker")
        .level,
    ).toBe("skipped");
  });
  it("outbox: silent when e-mail is off; warns about stuck and failed messages", async () => {
    expect(find(await run(), "email-outbox").level).toBe("skipped");
    const on = { SPORTOZEN_EMAIL_TRANSPORT: "capture" };
    expect(find(await run({}, on), "email-outbox").level).toBe("ok");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout=2000");
    const insert = (
      status: string,
      createdAt: string,
      finishedAt: string | null,
    ) =>
      db
        .prepare(
          "INSERT INTO email_outbox(id,purpose,toAddress,subject,status,nextAttemptAt,createdAt,expiresAt,finishedAt) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          "INVITATION",
          "private.person@example.org",
          "s",
          status,
          createdAt,
          createdAt,
          createdAt,
          finishedAt,
        );
    insert(
      "FAILED",
      new Date(NOW - 3600e3).toISOString(),
      new Date(NOW - 1800e3).toISOString(),
    );
    db.close();
    const failed = find(await run({}, on), "email-outbox");
    expect(failed.level).toBe("warning");
    expect(failed.detail).toContain("failed permanently");
    expect(JSON.stringify(failed)).not.toContain("private.person");
  });
  it("auth abuse: counts only accounts paused in the current window, and only when several at once", async () => {
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout=2000");
    const current = String(Math.floor(NOW / (15 * 60_000)));
    const previous = String(Math.floor(NOW / (15 * 60_000)) - 1);
    const pause = (n: number, bucket = current) =>
      db
        .prepare(
          "INSERT INTO request_rate_limits(scope,bucket,requests,expiresAt) VALUES(?,?,?,?)",
        )
        .run(`signin-failure:account:${n}`, bucket, 11, NOW + 600_000);
    pause(1);
    pause(2);
    // The previous window's rows are still stored but block nobody.
    pause(3, previous);
    pause(4, previous);
    expect(find(await run(), "auth-abuse").level).toBe("ok");
    pause(5);
    const abuse = find(await run(), "auth-abuse");
    db.close();
    expect(abuse.level).toBe("warning");
    expect(abuse.detail).toContain("3 accounts");
  });
  it("deployment: reports a failed or rolled-back release, and an unfinished one", async () => {
    const write = (...events: [string, string, number][]) =>
      writeFileSync(
        join(root, "deployments.log"),
        events
          .map(([event, release, ago]) =>
            JSON.stringify({
              ts: new Date(NOW - ago).toISOString(),
              event,
              release,
              previous: "r1",
            }),
          )
          .join("\n") + "\n",
      );
    expect(find(await run(), "deployment").level).toBe("skipped");
    write(["deploy.succeeded", "r2", 3600e3]);
    expect(find(await run(), "deployment").level).toBe("ok");
    write(["deploy.rolled_back", "r1", 3600e3]);
    expect(find(await run(), "deployment").level).toBe("warning");
    write(["deploy.rolled_back", "r1", 3 * 24 * 3600e3]);
    expect(find(await run(), "deployment").level).toBe("ok");
    write(["deploy.failed", "r1", 60e3]);
    // Critical while the application is not ready; a warning once it is.
    expect(
      find(
        await run({ fetchImpl: ready(503, { ready: false, checks: {} }) }),
        "deployment",
      ).level,
    ).toBe("critical");
    expect(find(await run(), "deployment").level).toBe("warning");
    write(["deploy.aborted", "r4", 60e3]);
    expect(find(await run(), "deployment").level).toBe("warning");
    write(["rollback.started", "r1", 40 * 60e3]);
    expect(find(await run(), "deployment").level).toBe("warning");
    write(["deploy.started", "r3", 40 * 60e3]);
    expect(find(await run(), "deployment").level).toBe("warning");
  });
  it("certificate: skipped without a host; warns at 21 days and is critical at 7", async () => {
    expect(find(await run(), "certificate").level).toBe("skipped");
    const level = async (days: number) =>
      find(
        await run(
          { certDays: async () => days },
          { SPORTOZEN_OPS_CERT_HOST: "academy.example" },
        ),
        "certificate",
      ).level;
    expect(await level(60)).toBe("ok");
    expect(await level(14)).toBe("warning");
    expect(await level(3)).toBe("critical");
  });
});

describe("one broken check does not stop the others", () => {
  it("an unreadable deployment log is a warning, and every other check still reports", async () => {
    // A directory where the log should be: reading it throws.
    mkdirSync(join(root, "deployments.log"));
    try {
      const results = await run();
      expect(find(results, "deployment").level).toBe("warning");
      expect(find(results, "deployment").detail).toContain(
        "the check itself failed",
      );
      expect(find(results, "app").level).toBe("ok");
      expect(find(results, "database").level).toBe("ok");
    } finally {
      rmSync(join(root, "deployments.log"), { recursive: true, force: true });
    }
  });
  it("the weekly deep result is remembered, so the every-minute run keeps reporting it and notices when it stops running", async () => {
    const stateDir = join(root, "deep-state");
    const env = { SPORTOZEN_OPS_STATE_DIR: stateDir };
    expect(find(await run({}, env), "database-integrity").level).toBe(
      "skipped",
    );
    expect(
      find(await run({ deep: true }, env), "database-integrity").level,
    ).toBe("ok");
    const later = find(
      await run({ now: NOW + 2 * 86400e3 }, env),
      "database-integrity",
    );
    expect(later.level).toBe("ok");
    expect(later.detail).toContain("weekly check, 2 d ago");
    const stale = find(
      await run({ now: NOW + 9 * 86400e3 }, env),
      "database-integrity",
    );
    expect(stale.level).toBe("warning");
    expect(stale.detail).toContain("has not run for 9 days");
  });
});

describe("deciding what to alert", () => {
  const res = (name: string, level: string, detail = "d") => ({
    name,
    level,
    detail,
    hint: "h",
  });
  it("reports a problem only after two passes in a row, then once, hourly while critical, and says when it is resolved", () => {
    let state = {};
    // One pass: nothing yet (a restart that overlaps a pass must not page anyone).
    let step = decideAlerts([res("app", "critical")], state, NOW);
    expect(step.send).toEqual([]);
    state = step.state;
    step = decideAlerts([res("app", "critical")], state, NOW + 60_000);
    expect(step.send.map((s) => s.kind)).toEqual(["NEW"]);
    state = step.state;
    step = decideAlerts([res("app", "critical")], state, NOW + 5 * 60_000);
    expect(step.send).toEqual([]);
    state = step.state;
    step = decideAlerts([res("app", "critical")], state, NOW + 62 * 60_000);
    expect(step.send.map((s) => s.kind)).toEqual(["REMINDER"]);
    state = step.state;
    step = decideAlerts([res("app", "ok")], state, NOW + 63 * 60_000);
    expect(step.send.map((s) => s.kind)).toEqual(["RESOLVED"]);
    expect(step.state).toEqual({});
    expect(
      decideAlerts([res("app", "ok")], step.state, NOW + 64 * 60_000).send,
    ).toEqual([]);
  });
  it("a blip that clears before it was reported produces no alert at all, and a flapping value stays quiet", () => {
    let step = decideAlerts([res("app", "critical")], {}, NOW);
    step = decideAlerts([res("app", "ok")], step.state, NOW + 60_000);
    expect(step.send).toEqual([]);
    expect(step.state).toEqual({});
    // Alternating ok / warning never reaches two in a row.
    let state = {};
    const sent: string[] = [];
    for (let minute = 0; minute < 10; minute++) {
      step = decideAlerts(
        [res("database-lock", minute % 2 ? "ok" : "warning")],
        state,
        NOW + minute * 60_000,
      );
      sent.push(...step.send.map((s) => s.kind));
      state = step.state;
    }
    expect(sent).toEqual([]);
  });
  it("treats a warning that becomes critical as news (after confirming it), warnings remind daily, and normal states are silent", () => {
    const warn = (t: number, state = {}) =>
      decideAlerts([res("disk-data", "warning")], state, NOW + t);
    let step = warn(0);
    step = warn(60_000, step.state);
    expect(step.send).toHaveLength(1);
    expect(warn(3600e3, step.state).send).toEqual([]);
    expect(warn(25 * 3600e3, step.state).send).toHaveLength(1);
    step = decideAlerts(
      [res("disk-data", "critical")],
      step.state,
      NOW + 3600e3,
    );
    expect(step.send).toEqual([]);
    step = decideAlerts(
      [res("disk-data", "critical")],
      step.state,
      NOW + 3600e3 + 60_000,
    );
    expect(step.send.map((s) => s.kind)).toEqual(["CHANGED"]);
    expect(
      decideAlerts([res("a", "ok"), res("b", "skipped")], {}, NOW).send,
    ).toEqual([]);
  });
  it("a reported problem that blips to another level still gets its RESOLVED, and a blip back does not repeat it", () => {
    const step = (level: string, minute: number, state: object) =>
      decideAlerts([res("disk-data", level)], state, NOW + minute * 60_000);
    let s = step("warning", 0, {});
    s = step("warning", 1, s.state);
    expect(s.send.map((x) => x.kind)).toEqual(["NEW"]);
    // One critical pass in the middle, then clear: the operator is still told it cleared.
    let blip = step("critical", 2, s.state);
    expect(blip.send).toEqual([]);
    const cleared = step("ok", 3, blip.state);
    expect(cleared.send.map((x) => x.kind)).toEqual(["RESOLVED"]);
    // Warning, critical blip, warning again within the reminder interval: no duplicate NEW.
    blip = step("critical", 2, s.state);
    const back = step("warning", 3, blip.state);
    const again = step("warning", 4, back.state);
    expect(back.send).toEqual([]);
    expect(again.send).toEqual([]);
  });
  it("a check that is switched off or unreadable (skipped) is not announced as back to normal", () => {
    let s = decideAlerts([res("email-outbox", "warning")], {}, NOW);
    s = decideAlerts([res("email-outbox", "warning")], s.state, NOW + 60_000);
    expect(s.send).toHaveLength(1);
    const skipped = decideAlerts(
      [res("email-outbox", "skipped")],
      s.state,
      NOW + 120_000,
    );
    expect(skipped.send).toEqual([]);
    expect(
      (skipped.state as Record<string, unknown>)["email-outbox"],
    ).toBeDefined();
  });
  it("only one run at a time handles alerts, and a dead holder's lock is taken over", () => {
    const config = configFor({
      SPORTOZEN_OPS_STATE_DIR: join(root, "lock-state"),
    });
    const first = acquireAlertLock(config, NOW);
    expect(first).toBeTypeOf("function");
    expect(acquireAlertLock(config, NOW + 1000)).toBeNull();
    first!();
    const second = acquireAlertLock(config, NOW + 2000);
    expect(second).toBeTypeOf("function");
    // Holder died without releasing: five minutes later the lock is taken over.
    expect(acquireAlertLock(config, NOW + 2000 + 6 * 60_000)).toBeTypeOf(
      "function",
    );
  });
  it("keeps the time stamp readable and still removes addresses from the alert text", () => {
    const message = formatAlert(
      {
        kind: "NEW",
        name: "email-outbox",
        level: "warning",
        detail: "failed for jo@example.org",
        hint: "h",
      },
      configFor({ SPORTOZEN_SERVER_NAME: "prod-1" }),
      NOW,
    );
    expect(message.body).toContain("Time: 2026-11-02T12:00:00.000Z");
    expect(message.body).not.toContain("jo@example");
  });
  it("a check that is not evaluated this pass keeps its state", () => {
    let step = decideAlerts([res("database-integrity", "critical")], {}, NOW);
    step = decideAlerts(
      [res("database-integrity", "critical")],
      step.state,
      NOW + 60_000,
    );
    const kept = decideAlerts([res("app", "ok")], step.state, NOW + 120_000);
    expect(kept.send).toEqual([]);
    expect(
      (kept.state as Record<string, unknown>)["database-integrity"],
    ).toBeDefined();
  });
  it("after a failed delivery only that alert is retried; the others are remembered as sent", () => {
    const results = [res("app", "critical"), res("disk-data", "critical")];
    let decided = decideAlerts(results, {}, NOW);
    decided = decideAlerts(results, decided.state, NOW + 60_000);
    expect(decided.send.map((s) => s.name).sort()).toEqual([
      "app",
      "disk-data",
    ]);
    const kept = commitState({}, decided, new Set(["disk-data"]));
    // Next pass: only the undelivered one is due again; the delivered one is quiet.
    const retry = decideAlerts(results, kept, NOW + 120_000);
    expect(retry.send.map((s) => s.name)).toEqual(["app"]);
    // And a RESOLVED that could not be delivered is retried too.
    const sent = commitState({}, decided, new Set(["app", "disk-data"]));
    const cleared = decideAlerts(
      [res("app", "ok"), res("disk-data", "critical")],
      sent,
      NOW + 3 * 60_000,
    );
    expect(cleared.send.map((s) => s.kind)).toEqual(["RESOLVED"]);
    const afterFailure = commitState(sent, cleared, new Set());
    expect(afterFailure.app).toBeDefined();
    expect(
      decideAlerts(
        [res("app", "ok"), res("disk-data", "critical")],
        afterFailure,
        NOW + 4 * 60_000,
      ).send.map((s) => s.kind),
    ).toEqual(["RESOLVED"]);
  });
  it("formats alerts with no personal data and a pointer to what to do", () => {
    const message = formatAlert(
      {
        kind: "NEW",
        name: "email-outbox",
        level: "warning",
        detail: "failed for jo@example.org via https://x.example/t?k=SECRET",
        hint: "docs/OPERATIONS.md#email-delivery",
      },
      configFor({ SPORTOZEN_SERVER_NAME: "prod-1" }),
      NOW,
    );
    expect(message.subject).toContain("WARNING email-outbox");
    expect(message.body).toContain("docs/OPERATIONS.md#email-delivery");
    expect(message.body + message.subject).not.toMatch(/jo@example|SECRET/);
  });
});

describe("delivering an alert", () => {
  it("runs the command without a shell, so alert text can never be executed", async () => {
    const out = join(root, "argv.json");
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`;
    const config = configFor({
      SPORTOZEN_ALERT_COMMAND: JSON.stringify([
        process.execPath,
        "-e",
        script,
        "{severity}",
        "{subject}",
      ]),
    });
    const marker = join(root, "pwned");
    const outcomes = await sendAlert(config, {
      severity: "CRITICAL",
      subject: `x; touch ${marker}; $(touch ${marker}) \`touch ${marker}\``,
      body: "b",
    });
    expect(outcomes).toEqual([{ sink: "command", ok: true }]);
    const argv = JSON.parse(
      (await import("node:fs")).readFileSync(out, "utf8"),
    ) as string[];
    expect(argv[0]).toBe("CRITICAL");
    expect(argv[1]).toContain("$(touch");
    expect((await import("node:fs")).existsSync(marker)).toBe(false);
  });
  it("posts JSON to a webhook, and reports failure instead of throwing", async () => {
    const received: string[] = [];
    const server: Server = createServer(
      (request: IncomingMessage, response) => {
        let data = "";
        request.on("data", (c) => (data += c));
        request.on("end", () => {
          received.push(data);
          response.statusCode = request.url === "/down" ? 500 : 204;
          response.end();
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await sendAlert(
        configFor({
          SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
        }),
        { severity: "WARNING", subject: "s", body: "b" },
      );
      expect(ok).toEqual([{ sink: "webhook", ok: true }]);
      expect(JSON.parse(received[0])).toMatchObject({
        severity: "WARNING",
        subject: "s",
        text: "b",
      });
      const bad = await sendAlert(
        configFor({
          SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/down`,
        }),
        { severity: "WARNING", subject: "s", body: "b" },
      );
      expect(bad).toEqual([{ sink: "webhook", ok: false }]);
      const unreachable = await sendAlert(
        configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/x" }),
        { severity: "WARNING", subject: "s", body: "b" },
      );
      expect(unreachable).toEqual([{ sink: "webhook", ok: false }]);
    } finally {
      server.close();
    }
  });
});

describe("ops-check command", () => {
  async function serve(handler: (url: string) => [number, unknown]) {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      let data = "";
      request.on("data", (c) => (data += c));
      request.on("end", () => {
        hits.push(data);
        const [status, body] = handler(request.url ?? "");
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, hits, port: (server.address() as { port: number }).port };
  }
  const cli = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolveRun) => {
      // The preload fixes the disk reading so the host's own disk state cannot
      // add an alert (the CLI sends at most three per run).
      const child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(join(process.cwd(), "tests/unit/helpers/stub-statfs.mjs"))
            .href,
          "scripts/ops-check.mjs",
          ...args,
        ],
        {
          env: { ...process.env, ...env },
        },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("exit", (code) => resolveRun({ code, out }));
    });
  const baseEnv = (extra: Record<string, string>) => ({
    SPORTOZEN_DATABASE_PATH: databasePath,
    SPORTOZEN_OPS_STATE_DIR: join(root, `cli-state-${randomUUID()}`),
    SPORTOZEN_DEPLOY_LOG: join(root, "deployments.log"),
    SPORTOZEN_OPS_EXPECT_WORKER: "false",
    SPORTOZEN_BACKUP_DIR: join(root, "no-backups"),
    SPORTOZEN_SERVER_NAME: "test-server",
    ...extra,
  });
  it("alerts once for an outage after two passes, stays quiet afterwards, and sends nothing for what only blipped", async () => {
    const app = await serve(() => [200, { ready: true, checks: {} }]);
    const hook = await serve(() => [200, {}]);
    const env = baseEnv({
      SPORTOZEN_OPS_READY_URL: `http://127.0.0.1:${app.port}/api/ready`,
      SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/alert`,
    });
    try {
      await cli(["--alert"], env);
      await cli(["--alert"], env);
      // The backup is not set up in this test: a warning, reported after two passes.
      const initial = hook.hits.length;
      app.server.close();
      app.server.closeAllConnections();
      const first = await cli(["--alert", "--json"], env);
      expect(first.code).toBe(0);
      expect(JSON.parse(first.out.trim().split("\n").pop()!).overall).toBe(
        "critical",
      );
      expect(hook.hits.length).toBe(initial); // one failed pass is not reported yet
      await cli(["--alert"], env);
      expect(hook.hits.length).toBe(initial + 1);
      expect(JSON.parse(hook.hits.at(-1)!).subject).toContain("CRITICAL app");
      await cli(["--alert"], env);
      expect(hook.hits.length).toBe(initial + 1);
      expect((await cli(["--strict"], env)).code).toBe(1);
      expect(hook.hits.join(" ")).not.toMatch(/@|password|secret/i);
    } finally {
      hook.server.close();
    }
  });
  it("with two destinations, one broken: the working one is told once, the failure shows in the exit status", async () => {
    const app = await serve(() => [
      503,
      { ready: false, checks: { database: "failed" } },
    ]);
    const good = await serve(() => [200, {}]);
    const env = baseEnv({
      SPORTOZEN_OPS_READY_URL: `http://127.0.0.1:${app.port}/api/ready`,
      SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${good.port}/ok`,
      SPORTOZEN_ALERT_COMMAND: JSON.stringify([
        process.execPath,
        "-e",
        "process.exit(1)",
      ]),
    });
    try {
      await cli(["--alert"], env);
      const second = await cli(["--alert"], env);
      expect(second.code, second.out).toBe(4);
      const told = good.hits.filter((h) =>
        JSON.parse(h).subject.includes("CRITICAL app"),
      ).length;
      expect(told).toBe(1);
      const third = await cli(["--alert"], env);
      // Nothing new is due, so nothing is sent and nothing fails.
      expect(third.code).toBe(0);
      expect(
        good.hits.filter((h) => JSON.parse(h).subject.includes("CRITICAL app"))
          .length,
      ).toBe(1);
    } finally {
      app.server.close();
      good.server.close();
    }
  });
  it("--test-alert reports each destination, and says so when there is none or the configuration is wrong", async () => {
    const hook = await serve(() => [200, {}]);
    try {
      const ok = await cli(
        ["--test-alert"],
        baseEnv({
          SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/t`,
        }),
      );
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("webhook: accepted");
      expect(JSON.parse(hook.hits.at(-1)!).subject).toContain("TEST");
      const none = await cli(["--test-alert"], baseEnv({}));
      expect(none.code).toBe(3);
      const broken = await cli(
        ["--test-alert"],
        baseEnv({
          SPORTOZEN_ALERT_COMMAND: "[/usr/local/bin/notify,{severity}]",
        }),
      );
      expect(broken.code).toBe(3);
      expect(broken.out).toContain("single quotes");
    } finally {
      hook.server.close();
    }
  });
  it("the unit-failure alert command exits 3 with the reason on a bad configuration, 2 on a bad unit name", async () => {
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, ["scripts/ops-alert.mjs", ...args], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
    const bad = run(
      ["--unit", "sportozen-web.service"],
      baseEnv({ SPORTOZEN_ALERT_COMMAND: "not json" }),
    );
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain("SPORTOZEN_ALERT_COMMAND");
    expect(run(["--unit", "x; rm -rf /"], baseEnv({})).status).toBe(2);
    const hook = await serve(() => [200, {}]);
    try {
      const env = baseEnv({
        SPORTOZEN_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hook.port}/u`,
      });
      const sent = await new Promise<number | null>((resolveRun) => {
        const child = spawn(
          process.execPath,
          ["scripts/ops-alert.mjs", "--unit", "sportozen-backup.service"],
          { env: { ...process.env, ...env } },
        );
        child.on("exit", resolveRun);
      });
      expect(sent).toBe(0);
      const message = JSON.parse(hook.hits.at(-1)!);
      expect(message.subject).toContain(
        "CRITICAL unit sportozen-backup.service",
      );
      expect(message.text).toContain("backup-failure");
    } finally {
      hook.server.close();
    }
  });
});
const _unused = spawnSync;
void _unused;
