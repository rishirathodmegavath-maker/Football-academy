// WP8 independent-review fixes (c) and (d): alert delivery must respect its time
// limit (a hung or SIGTERM-ignoring command is killed, with whatever it started),
// and overlapping monitor runs must be safe (an owner-checked lock, crash and
// clock-step recovery, no state written by a run that lost the lock). Fix (a),
// the rollback after a failed restart, is tested in deploy/tests/test-release.sh.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
vi.setConfig({ testTimeout: 60_000 });
import {
  THRESHOLDS,
  acquireAlertLock,
  loadOpsConfig,
  readState,
  runAlertPass,
  sendAlert,
} from "../../scripts/lib/ops.mjs";

const OPS_URL = pathToFileURL(
  join(process.cwd(), "scripts/lib/ops.mjs"),
).href;
let root: string;
let counter = 0;
const configFor = (extra: Record<string, string> = {}) =>
  loadOpsConfig({
    ...process.env,
    SPORTOZEN_DATABASE_PATH: join(root, "data", "workspaces.sqlite"),
    SPORTOZEN_DEPLOY_LOG: join(root, "deployments.log"),
    SPORTOZEN_OPS_STATE_DIR: join(root, `state-${++counter}`),
    ...extra,
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
async function until(condition: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50));
  return condition();
}
const pidOf = (file: string) => Number(readFileSync(file, "utf8"));

// A command that ignores SIGTERM, starts a grandchild, and never ends.
const HANG = () => join(root, "hang.cjs");
// Hangs when the subject names "hang-check", otherwise succeeds at once.
const SELECTIVE = () => join(root, "selective.cjs");
const NOW = Date.parse("2026-11-02T12:00:00Z");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sportozen-ops-fixes-"));
  mkdirSync(join(root, "data"));
  writeFileSync(
    HANG(),
    `const fs = require("fs"), { spawn } = require("child_process");
process.on("SIGTERM", () => {}); // ignores the polite request
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2] + ".parent", String(process.pid));
fs.writeFileSync(process.argv[2] + ".child", String(grandchild.pid));
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    SELECTIVE(),
    `const fs = require("fs");
const [log, hangFile, subject] = process.argv.slice(2);
fs.appendFileSync(log, subject + "\\n");
if (subject.includes("hang-check")) {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(hangFile, String(process.pid));
  setInterval(() => {}, 1000);
} else process.exit(0);
`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("(c) alert delivery respects its time limit", () => {
  const message = { severity: "CRITICAL", subject: "s", body: "b" };

  it("kills a command that ignores SIGTERM, and what it started, at the deadline", async () => {
    const base = join(root, `hang-${++counter}`);
    const config = configFor({
      SPORTOZEN_ALERT_COMMAND: JSON.stringify([process.execPath, HANG(), base]),
    });
    const started = Date.now();
    const outcomes = await sendAlert(config, message, { commandTimeoutMs: 1500 });
    const took = Date.now() - started;
    expect(outcomes).toEqual([{ sink: "command", ok: false, timedOut: true }]);
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(6000); // not "until somebody kills the run"
    const parent = pidOf(`${base}.parent`);
    const child = pidOf(`${base}.child`);
    expect(
      await until(() => !alive(parent) && !alive(child)),
      "the hung command and its child must both be gone",
    ).toBe(true);
  });

  it("reports a command that exits non-zero, or does not exist, without waiting", async () => {
    const started = Date.now();
    const failing = await sendAlert(
      configFor({
        SPORTOZEN_ALERT_COMMAND: JSON.stringify([process.execPath, "-e", "process.exit(3)"]),
      }),
      message,
      { commandTimeoutMs: 15_000 },
    );
    const missing = await sendAlert(
      configFor({
        SPORTOZEN_ALERT_COMMAND: JSON.stringify([join(root, "no-such-program")]),
      }),
      message,
      { commandTimeoutMs: 15_000 },
    );
    expect(failing).toEqual([{ sink: "command", ok: false }]);
    expect(missing).toEqual([{ sink: "command", ok: false }]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not time out a command that finishes in time", async () => {
    const ok = await sendAlert(
      configFor({
        SPORTOZEN_ALERT_COMMAND: JSON.stringify([process.execPath, "-e", "setTimeout(() => {}, 300)"]),
      }),
      message,
      { commandTimeoutMs: 5000 },
    );
    expect(ok).toEqual([{ sink: "command", ok: true }]);
  });

  it("stops waiting for a webhook that never answers", async () => {
    const config = configFor({
      SPORTOZEN_ALERT_WEBHOOK_URL: "https://alerts.example.org/hook",
    });
    // Settles only if it is given a signal that fires: without one it hangs
    // forever and the test times out, so dropping the signal is caught.
    const hangs = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const outcomes = await sendAlert(config, message, {
      fetchImpl: hangs,
      webhookTimeoutMs: 400,
    });
    expect(outcomes).toEqual([{ sink: "webhook", ok: false }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("leaves no temporary file behind when saving the state fails", async () => {
    const { writeState } = await import("../../scripts/lib/ops.mjs");
    const config = configFor();
    mkdirSync(join(config.stateDir, "alerts.json"), { recursive: true }); // the rename onto a directory fails
    expect(() => writeState(config, { a: 1 })).toThrow();
    expect(readdirSync(config.stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("accepts a shorter command limit from the environment, and refuses nonsense", () => {
    expect(configFor({ SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS: "5" }).alertCommandTimeoutMs).toBe(5000);
    expect(configFor().alertCommandTimeoutMs).toBe(20_000);
    for (const bad of ["0", "21", "1.5", "soon", "-3"])
      expect(() => configFor({ SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS: bad })).toThrow(
        /SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS/,
      );
  });

  it("the worst case fits inside the unit time limit with room to spare", () => {
    // checks (about 24 s) + the last alert may START at the budget and take 28 s
    const worst = 24_000 + THRESHOLDS.alertBudgetMs + 20_000 + 8_000;
    expect(worst).toBeLessThan(120_000); // sportozen-ops-check.service TimeoutStartSec
  });

  describe("a hung destination cannot starve the other alerts", () => {
    const results = [
      { name: "hang-check", level: "critical", detail: "d", hint: "h" },
      { name: "ok-check-1", level: "critical", detail: "d", hint: "h" },
      { name: "ok-check-2", level: "critical", detail: "d", hint: "h" },
    ];
    it("delivers the others in the same pass and retries only the hung one", async () => {
      const log = join(root, `delivered-${++counter}.log`);
      const hangFile = join(root, `hangpid-${counter}`);
      const config = configFor({
        SPORTOZEN_ALERT_COMMAND: JSON.stringify([
          process.execPath,
          SELECTIVE(),
          log,
          hangFile,
          "{subject}",
        ]),
        SPORTOZEN_ALERT_COMMAND_TIMEOUT_SECONDS: "2",
      });
      const quiet = { log: () => undefined };
      // Pass 1 only counts (two passes are needed before anyone is told).
      await runAlertPass(config, results, quiet);
      const started = Date.now();
      const pass = await runAlertPass(config, results, quiet);
      const took = Date.now() - started;
      expect(took).toBeLessThan(15_000);
      expect(pass.locked).toBe(false);
      expect(pass.undelivered).toBe(1); // only the hung one is reported failed
      const state = readState(config) as Record<string, { reported?: string }>;
      expect(state["ok-check-1"]!.reported).toBe("critical");
      expect(state["ok-check-2"]!.reported).toBe("critical");
      expect(state["hang-check"]!.reported).toBeUndefined(); // still due
      expect(
        await until(() => existsSync(hangFile) && !alive(pidOf(hangFile))),
        "the hung command was killed",
      ).toBe(true);
      // The next pass retries the hung alert only; the delivered ones stay quiet.
      const third = await runAlertPass(config, results, quiet);
      expect(third.undelivered).toBe(1);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines.filter((l) => l.includes("ok-check-1"))).toHaveLength(1);
      expect(lines.filter((l) => l.includes("ok-check-2"))).toHaveLength(1);
      expect(lines.filter((l) => l.includes("hang-check")).length).toBe(2);
      // The lock does not outlive any of those passes.
      expect(existsSync(join(config.stateDir, "alerts.lock"))).toBe(false);
    });
  });

  it("starts no new alert once the time budget is used up, and retries it next pass", async () => {
    const config = configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "https://alerts.example.org/hook" });
    let clock = NOW;
    const sent: string[] = [];
    const send = async (_c: unknown, message: { subject: string }) => {
      sent.push(message.subject);
      clock += 40_000; // each delivery "takes" 40 s
      return [{ sink: "webhook", ok: true }];
    };
    const results = ["a-check", "b-check", "c-check"].map((name) => ({
      name,
      level: "critical",
      detail: "d",
      hint: "h",
    }));
    const options = { send: send as never, now: () => clock, log: () => undefined };
    await runAlertPass(config, results, options);
    clock = NOW + 60_000;
    sent.length = 0;
    const pass = await runAlertPass(config, results, options);
    expect(sent).toHaveLength(2); // 0 s and 40 s start inside the 60 s budget; 80 s does not
    expect(pass.undelivered).toBe(1);
    const state = readState(config) as Record<string, { reported?: string }>;
    expect(Object.values(state).filter((e) => e.reported).length).toBe(2);
  });
});

describe("(d) overlapping runs are handled safely", () => {
  let config: ReturnType<typeof loadOpsConfig>;
  beforeEach(() => {
    config = configFor();
  });
  const lockFile = () => join(config.stateDir, "alerts.lock");

  it("a run that was taken over cannot delete its successor's lock", () => {
    const a = acquireAlertLock(config, NOW)!;
    expect(a).toBeTypeOf("function");
    // A hangs past the stale limit; B takes over.
    const b = acquireAlertLock(config, NOW + 6 * 60_000)!;
    expect(b).toBeTypeOf("function");
    expect(a.owned()).toBe(false);
    expect(b.owned()).toBe(true);
    a(); // A finally finishes: must not remove B's lock
    expect(existsSync(lockFile())).toBe(true);
    expect(b.owned()).toBe(true);
    expect(acquireAlertLock(config, NOW + 6 * 60_000 + 1000)).toBeNull(); // a third run cannot enter
    b();
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireAlertLock(config, NOW + 7 * 60_000)).toBeTypeOf("function");
  });

  it("takes over at once from a holder that no longer exists (no five-minute blackout)", () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    expect(dead.pid).toBeGreaterThan(0);
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ pid: dead.pid, token: "x", at: NOW }));
    expect(acquireAlertLock(config, NOW + 1000)).toBeTypeOf("function");
  });

  it("is not fooled by a clock that stepped backwards", () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    mkdirSync(config.stateDir, { recursive: true });
    // The lock is "from the future": a crashed holder, and the clock went back an hour.
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: dead.pid, token: "x", at: NOW + 3_600_000 }),
    );
    expect(acquireAlertLock(config, NOW)).toBeTypeOf("function");
    // A live holder with a "future" stamp is still a live holder.
    rmSync(lockFile());
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: process.pid, token: "y", at: NOW + 3_600_000 }),
    );
    expect(acquireAlertLock(config, NOW)).toBeNull();
  });

  it("treats a damaged or old-format lock as stale only when it really is", () => {
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(lockFile(), "not a lock");
    expect(acquireAlertLock(config, NOW)).toBeTypeOf("function"); // unreadable = stale
    rmSync(lockFile());
    writeFileSync(lockFile(), String(NOW)); // the previous format: just the time
    expect(acquireAlertLock(config, NOW + 1000)).toBeNull(); // recent: held
    expect(acquireAlertLock(config, NOW + 6 * 60_000)).toBeTypeOf("function"); // old: stale
  });

  // Windows refuses a rename onto a file another process is replacing at that
  // instant (a sharing error, not a name collision); the service runs on Linux,
  // where this is also proven by deploy/tests/test-ops-delivery.sh.
  it.skipIf(process.platform === "win32")("two processes saving state at the same time never collide on a temporary file", async () => {
    const worker = join(root, "statewriter.mjs");
    writeFileSync(
      worker,
      `import { writeState } from ${JSON.stringify(OPS_URL)};
import { appendFileSync } from "node:fs";
const [stateDir, goAt, tag, out] = process.argv.slice(2);
while (Date.now() < Number(goAt)) {}
let errors = 0;
for (let i = 0; i < 400; i++) {
  try { writeState({ stateDir }, { tag, i }); } catch { errors++; }
}
appendFileSync(out, JSON.stringify({ tag, errors }) + "\\n");
`,
    );
    const stateDir = join(root, `writers-${++counter}`);
    const out = join(root, `writers-${counter}.log`);
    const goAt = Date.now() + 3000;
    await Promise.all(
      ["a", "b"].map(
        (tag) =>
          new Promise<void>((resolveChild) =>
            spawn(process.execPath, [worker, stateDir, String(goAt), tag, out], { stdio: "ignore" }).on("exit", () => resolveChild()),
          ),
      ),
    );
    const results = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(results.map((r) => r.errors)).toEqual([0, 0]);
    expect(() => JSON.parse(readFileSync(join(stateDir, "alerts.json"), "utf8"))).not.toThrow();
  });

  it("a run that lost the lock stops sending and does not overwrite the new holder's state", async () => {
    const results = [{ name: "x-check", level: "critical", detail: "d", hint: "h" }];
    const config2 = configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "https://alerts.example.org/hook" });
    await runAlertPass(config2, results, { log: () => undefined }); // pass 1: counting
    let stolenState = "";
    const messages: string[] = [];
    const send = async () => {
      // While this run is delivering, another run takes the lock and writes its state.
      writeFileSync(join(config2.stateDir, "alerts.lock"), JSON.stringify({ pid: process.pid, token: "other", at: Date.now() }));
      stolenState = JSON.stringify({ "x-check": { level: "critical", since: 0, seen: 99, lastSentAt: 1, reported: "critical" } });
      writeFileSync(join(config2.stateDir, "alerts.json"), stolenState);
      messages.push("sent");
      return [{ sink: "webhook", ok: true }];
    };
    const lines: string[] = [];
    const pass = await runAlertPass(config2, results, { send: send as never, log: (l: string) => lines.push(l) });
    expect(messages).toHaveLength(1);
    expect(readFileSync(join(config2.stateDir, "alerts.json"), "utf8")).toBe(stolenState); // untouched
    expect(pass.undelivered).toBeGreaterThanOrEqual(1);
    expect(lines.join("\n")).toMatch(/lock was taken over/);
    // And the new holder's lock is still there.
    expect(existsSync(join(config2.stateDir, "alerts.lock"))).toBe(true);
  });

  it("many processes trying at the same instant: never two holders at once", async () => {
    const worker = join(root, "lockworker.mjs");
    writeFileSync(
      worker,
      `import { acquireAlertLock } from ${JSON.stringify(OPS_URL)};
import { appendFileSync } from "node:fs";
const [stateDir, goAt, holdMs, out] = process.argv.slice(2);
while (Date.now() < Number(goAt)) {}
const release = acquireAlertLock({ stateDir });
if (release) {
  const start = Date.now();
  while (Date.now() - start < Number(holdMs)) {}
  const end = Date.now();
  release();
  appendFileSync(out, JSON.stringify({ won: true, start, end }) + "\\n");
} else appendFileSync(out, JSON.stringify({ won: false }) + "\\n");
`,
    );
    const stateDir = join(root, `race-${++counter}`);
    const out = join(root, `race-${counter}.log`);
    const goAt = Date.now() + 4000;
    const children = Array.from({ length: 8 }, () =>
      new Promise<void>((resolveChild) =>
        spawn(process.execPath, [worker, stateDir, String(goAt), "700", out], { stdio: "ignore" }).on("exit", () => resolveChild()),
      ),
    );
    await Promise.all(children);
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(8);
    const winners = lines.filter((l) => l.won).sort((a, b) => a.start - b.start);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < winners.length; i++)
      expect(winners[i].start, "holdings must not overlap").toBeGreaterThanOrEqual(winners[i - 1].end);
    expect(existsSync(join(stateDir, "alerts.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "SIGTERM (systemd stopping the unit) releases the lock and exits 143",
    async () => {
      const results = [{ name: "x-check", level: "critical", detail: "d", hint: "h" }];
      const config3 = configFor({ SPORTOZEN_ALERT_WEBHOOK_URL: "https://alerts.example.org/hook" });
      await runAlertPass(config3, results, { log: () => undefined });
      const runner = join(root, "signal-runner.mjs");
      writeFileSync(
        runner,
        `import { loadOpsConfig, runAlertPass } from ${JSON.stringify(OPS_URL)};
const config = loadOpsConfig(process.env);
const results = [{ name: "x-check", level: "critical", detail: "d", hint: "h" }];
await runAlertPass(config, results, { send: () => { console.log("HOLDING"); setInterval(() => {}, 1000); return new Promise(() => {}); }, log: () => {} });
`,
      );
      const child = spawn(process.execPath, [runner], {
        env: { ...process.env, SPORTOZEN_OPS_STATE_DIR: config3.stateDir, SPORTOZEN_DATABASE_PATH: join(root, "data", "workspaces.sqlite"), SPORTOZEN_ALERT_WEBHOOK_URL: "https://alerts.example.org/hook" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      expect(await until(() => output.includes("HOLDING"), 15_000)).toBe(true);
      expect(existsSync(join(config3.stateDir, "alerts.lock"))).toBe(true);
      const code = await new Promise<number | null>((r) => {
        child.on("exit", (c) => r(c));
        child.kill("SIGTERM");
      });
      expect(code).toBe(143);
      expect(existsSync(join(config3.stateDir, "alerts.lock"))).toBe(false);
    },
  );
});
