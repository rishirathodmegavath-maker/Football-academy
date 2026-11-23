// Backups: consistent, encrypted, verified by restoring them, copied off the
// server, pruned by a retention policy, and restorable only to a new file.
// Everything uses synthetic databases in a temporary directory.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createBackup,
  latestBackup,
  listBackups,
  loadBackupConfig,
  readStatus,
  rehearseRestore,
  restoreBackup,
  selectRetained,
  verifyArtifact,
} from "../../scripts/lib/backup.mjs";
vi.mock("server-only", () => ({}));
// Child processes, key derivation and file hashing: measured at up to 6 s when the whole suite runs in parallel (default limit 5 s).
vi.setConfig({ testTimeout: 30_000 });

const root = mkdtempSync(join(tmpdir(), "sportozen-backup-"));
afterAll(() =>
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }),
);
const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
let counter = 0;
const fresh = (name: string) => {
  const dir = join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** A live database with some synthetic rows, in WAL mode like production. */
function liveDatabase(dir: string, rows = 50) {
  const path = join(dir, "data", "live.sqlite");
  mkdirSync(join(dir, "data"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(
    "CREATE TABLE academy_workspaces(id TEXT PRIMARY KEY, config TEXT NOT NULL); CREATE TABLE workspace_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL); PRAGMA user_version=4",
  );
  db.prepare("INSERT INTO academy_workspaces VALUES('a1', ?)").run(
    JSON.stringify({ name: "Synthetic Secret Academy Name" }),
  );
  // One transaction: a commit per row costs an fsync each (seconds on Windows).
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++)
    db.prepare("INSERT INTO workspace_audit(action) VALUES(?)").run(`row ${i}`);
  db.exec("COMMIT");
  return { path, db };
}
const env = (dir: string, extra: Record<string, string> = {}) => ({
  SPORTOZEN_DATABASE_PATH: join(dir, "data", "live.sqlite"),
  SPORTOZEN_BACKUP_DIR: join(dir, "staging"),
  SPORTOZEN_BACKUP_ENCRYPTION_KEY: KEY,
  ...extra,
});
const config = (dir: string, extra: Record<string, string> = {}) =>
  loadBackupConfig(env(dir, extra), { cwd: join(dir, "app") });
const only = (dir: string) =>
  readdirSync(dir).filter((name) => !name.startsWith("."));

describe("backup configuration", () => {
  const base = (dir: string) => env(dir);
  it("accepts a safe configuration and applies the default retention", () => {
    const dir = fresh("cfg");
    const c = loadBackupConfig(base(dir), { cwd: join(dir, "app") });
    expect(c.retention).toEqual({ hourly: 24, daily: 30, monthly: 12 });
    expect(c.rpoMinutes).toBeNull();
    expect(c.key?.length).toBe(32);
  });
  it.each([
    [
      "no database",
      { SPORTOZEN_DATABASE_PATH: "" },
      /DATABASE_PATH is not set/,
    ],
    ["no staging dir", { SPORTOZEN_BACKUP_DIR: "" }, /BACKUP_DIR is not set/],
    ["relative staging dir", { SPORTOZEN_BACKUP_DIR: "backups" }, /absolute/],
    [
      "a short key",
      { SPORTOZEN_BACKUP_ENCRYPTION_KEY: "c2hvcnQ=" },
      /32 random bytes/,
    ],
    ["bad retention", { SPORTOZEN_BACKUP_KEEP_HOURLY: "0" }, /at least 1/],
    ["bad RPO", { SPORTOZEN_BACKUP_RPO_MINUTES: "soon" }, /integer/],
    [
      "a command that is not JSON",
      { SPORTOZEN_BACKUP_TARGET_COMMAND: "rclone copy" },
      /JSON array/,
    ],
    [
      "a command without {file}",
      { SPORTOZEN_BACKUP_TARGET_COMMAND: '["true"]' },
      /\{file\}/,
    ],
  ])("rejects %s", (_label, extra, message) => {
    const dir = fresh("cfg");
    expect(() =>
      loadBackupConfig({ ...base(dir), ...extra }, { cwd: join(dir, "app") }),
    ).toThrow(message);
  });
  it("rejects staging inside the application or database directory", () => {
    const dir = fresh("cfg");
    const cwd = join(dir, "app");
    for (const staging of [
      join(cwd, "b"),
      join(dir, "data", "b"),
      join(dir, "data"),
    ])
      expect(() =>
        loadBackupConfig(
          { ...base(dir), SPORTOZEN_BACKUP_DIR: staging },
          { cwd },
        ),
      ).toThrow(/outside|overlap/);
  });
  it("refuses to write unencrypted backups unless explicitly allowed", () => {
    const dir = fresh("cfg");
    const e = { ...base(dir) } as Record<string, string>;
    delete e.SPORTOZEN_BACKUP_ENCRYPTION_KEY;
    expect(() => loadBackupConfig(e, { cwd: join(dir, "app") })).toThrow(
      /unencrypted/,
    );
    expect(
      loadBackupConfig(
        { ...e, SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED: "1" },
        { cwd: join(dir, "app") },
      ).key,
    ).toBeNull();
  });
  it("rejects two off-server targets and a target that overlaps local directories", () => {
    const dir = fresh("cfg");
    const cwd = join(dir, "app");
    expect(() =>
      loadBackupConfig(
        {
          ...base(dir),
          SPORTOZEN_BACKUP_TARGET_DIR: join(dir, "remote"),
          SPORTOZEN_BACKUP_TARGET_COMMAND: '["cp","{file}","x"]',
        },
        { cwd },
      ),
    ).toThrow(/only one/);
    expect(() =>
      loadBackupConfig(
        {
          ...base(dir),
          SPORTOZEN_BACKUP_TARGET_DIR: join(dir, "staging", "remote"),
        },
        { cwd },
      ),
    ).toThrow(/separate/);
  });
});

describe("creating a backup", () => {
  it("stores an encrypted, verified backup with a manifest and no readable data", async () => {
    const dir = fresh("create");
    const { db } = liveDatabase(dir);
    const c = config(dir);
    const result = await createBackup({ config: c, label: "manual" });
    const files = only(c.directory).filter((n) => n !== "status.json");
    expect(files).toHaveLength(2);
    expect(files.some((n) => n.endsWith(".sqlite.gz.enc"))).toBe(true);
    const artifact = join(c.directory, result.name);
    const bytes = readFileSync(artifact);
    expect(bytes.subarray(0, 5).toString()).toBe("SZBK1");
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("Synthetic Secret Academy Name"))).toBe(
      false,
    );
    const manifest = JSON.parse(readFileSync(`${artifact}.json`, "utf8"));
    expect(manifest).toMatchObject({
      encrypted: true,
      label: "manual",
      userVersion: 4,
      counts: { academy_workspaces: 1, workspace_audit: 50 },
    });
    expect(JSON.stringify(manifest)).not.toContain("Synthetic Secret");
    expect(JSON.stringify(manifest)).not.toContain(KEY);
    expect(manifest.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(readStatus(c.directory).lastSuccess).toMatchObject({
      name: result.name,
      offServer: false,
    });
    if (process.platform !== "win32") {
      expect(statSync(artifact).mode & 0o077).toBe(0);
      expect(statSync(c.directory).mode & 0o077).toBe(0);
    }
    db.close();
  });
  it("is consistent while another process keeps writing", async () => {
    const dir = fresh("busy");
    const { db } = liveDatabase(dir, 2000);
    db.close();
    const c = config(dir);
    // The application is a separate process that writes continuously.
    const stopFile = join(dir, "stop"),
      readyFile = join(dir, "writer-ready");
    const writerScript = join(dir, "writer.mjs");
    writeFileSync(
      writerScript,
      `import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const db = new DatabaseSync(${JSON.stringify(c.database)});
db.exec("PRAGMA busy_timeout=5000");
let n = 0;
writeFileSync(${JSON.stringify(readyFile)}, "1");
while (!existsSync(${JSON.stringify(stopFile)})) {
  db.prepare("INSERT INTO workspace_audit(action) VALUES(?)").run("live write");
  n++;
  // About 100 writes a second: busy for a school-sized academy, light on the machine.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
console.log("WRITES " + n);
`,
    );
    const writer = spawn(process.execPath, [writerScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    writer.stdout.on("data", (d) => (output += d));
    writer.stderr.on("data", (d) => (output += d));
    const exited = new Promise((resolve) => writer.on("exit", resolve));
    while (!existsSync(readyFile)) await new Promise((r) => setTimeout(r, 20));
    const results = [];
    for (let i = 0; i < 2; i++)
      results.push(
        await createBackup({ config: c, now: Date.now() + i * 1000 }),
      );
    writeFileSync(stopFile, "1");
    await exited;
    const writes = Number(/WRITES (\d+)/.exec(output)?.[1]);
    expect(writes, output).toBeGreaterThan(5);
    for (const [index, result] of results.entries()) {
      const target = join(dir, `restored-${index}.sqlite`);
      const restored = await restoreBackup({
        artifact: join(c.directory, result.name),
        key: c.key,
        target,
      });
      expect(restored.ok, restored.problems.join()).toBe(true);
      const copy = new DatabaseSync(target, { readOnly: true });
      const rows = Number(
        copy.prepare("SELECT COUNT(*) n FROM workspace_audit").get()?.n,
      );
      expect(rows).toBeGreaterThanOrEqual(2000);
      expect(rows).toBe(result.manifest.counts.workspace_audit);
      expect(
        copy.prepare("PRAGMA integrity_check").get()?.integrity_check,
      ).toBe("ok");
      copy.close();
    }
  }, 60_000);
  it("leaves no partial files and records the failure when the database is unusable", async () => {
    const dir = fresh("broken");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "data", "live.sqlite"),
      "this is not a database file at all".repeat(200),
    );
    const c = config(dir);
    await expect(createBackup({ config: c })).rejects.toThrow(
      /backup failed during snapshot/,
    );
    expect(only(c.directory).filter((n) => n !== "status.json")).toEqual([]);
    expect(readStatus(c.directory).lastFailure.stage).toBe("snapshot");
    const missing = fresh("missing");
    await expect(createBackup({ config: config(missing) })).rejects.toThrow(
      /does not exist/,
    );
  });
  it("refuses to run twice at once and recovers from a stale lock", async () => {
    const dir = fresh("lock");
    const { db } = liveDatabase(dir);
    const c = config(dir);
    mkdirSync(c.directory, { recursive: true });
    writeFileSync(join(c.directory, ".backup.lock"), "{}");
    await expect(createBackup({ config: c })).rejects.toThrow(
      /already running/,
    );
    const old = new Date(Date.now() - 7 * 3600_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(c.directory, ".backup.lock"), old, old);
    await expect(createBackup({ config: c })).resolves.toMatchObject({
      name: expect.any(String),
    });
    expect(existsSync(join(c.directory, ".backup.lock"))).toBe(false);
    db.close();
  });
  it("works without encryption when explicitly allowed", async () => {
    const dir = fresh("plain");
    const { db } = liveDatabase(dir);
    const e = env(dir, { SPORTOZEN_BACKUP_ALLOW_UNENCRYPTED: "1" }) as Record<
      string,
      string
    >;
    delete e.SPORTOZEN_BACKUP_ENCRYPTION_KEY;
    const c = loadBackupConfig(e, { cwd: join(dir, "app") });
    const result = await createBackup({ config: c });
    expect(result.name.endsWith(".sqlite.gz")).toBe(true);
    const restored = await restoreBackup({
      artifact: join(c.directory, result.name),
      key: null,
      target: join(dir, "r.sqlite"),
    });
    expect(restored.ok).toBe(true);
    db.close();
  });
});

describe("restoring and detecting damage", () => {
  async function backedUp(name: string) {
    const dir = fresh(name);
    const { db } = liveDatabase(dir);
    const c = config(dir);
    const result = await createBackup({ config: c });
    db.close();
    return { dir, c, artifact: join(c.directory, result.name) };
  }
  it("restores to a new path with identical data and a private file", async () => {
    const { dir, c, artifact } = await backedUp("restore");
    const target = join(dir, "restore-out", "workspaces.sqlite");
    const result = await restoreBackup({
      artifact,
      key: c.key,
      target,
      liveDatabase: c.database,
    });
    expect(result.ok, result.problems.join()).toBe(true);
    const db = new DatabaseSync(target, { readOnly: true });
    expect(
      db.prepare("SELECT config FROM academy_workspaces WHERE id='a1'").get()
        ?.config,
    ).toContain("Synthetic Secret");
    expect(db.prepare("SELECT COUNT(*) n FROM workspace_audit").get()?.n).toBe(
      50,
    );
    db.close();
    if (process.platform !== "win32")
      expect(statSync(target).mode & 0o077).toBe(0);
    expect(readdirSync(join(dir, "restore-out"))).toEqual([
      "workspaces.sqlite",
    ]);
  });
  it("never restores over the live database or any existing file", async () => {
    const { dir, c, artifact } = await backedUp("refuse");
    await expect(
      restoreBackup({
        artifact,
        key: c.key,
        target: c.database,
        liveDatabase: c.database,
      }),
    ).rejects.toThrow(/live database/);
    const existing = join(dir, "existing.sqlite");
    writeFileSync(existing, "keep me");
    await expect(
      restoreBackup({ artifact, key: c.key, target: existing }),
    ).rejects.toThrow(/already exists/);
    expect(readFileSync(existing, "utf8")).toBe("keep me");
    await expect(
      restoreBackup({ artifact, key: c.key, target: "relative.sqlite" }),
    ).rejects.toThrow(/absolute/);
    // the live file is untouched by all of the above
    expect(statSync(c.database).size).toBeGreaterThan(0);
  });
  it("detects a flipped byte, truncation, a missing or edited manifest", async () => {
    const { dir, c, artifact } = await backedUp("damage");
    const out = (n: string) => join(dir, n);
    const original = readFileSync(artifact);
    const damaged = Buffer.from(original);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    writeFileSync(artifact, damaged);
    let r = await verifyArtifact({
      artifact,
      key: c.key,
      output: out("v1.sqlite"),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/hash does not match/);
    expect(existsSync(out("v1.sqlite"))).toBe(false);
    writeFileSync(artifact, original.subarray(0, original.length - 40));
    r = await verifyArtifact({
      artifact,
      key: c.key,
      output: out("v2.sqlite"),
    });
    expect(r.ok).toBe(false);
    writeFileSync(artifact, original);
    const manifestPath = `${artifact}.json`;
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(
      manifestPath,
      manifest.replace(/"workspace_audit": 50/, '"workspace_audit": 51'),
    );
    r = await verifyArtifact({
      artifact,
      key: c.key,
      output: out("v3.sqlite"),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/workspace_audit/);
    writeFileSync(manifestPath, manifest);
    rmSync(manifestPath);
    r = await verifyArtifact({
      artifact,
      key: c.key,
      output: out("v4.sqlite"),
    });
    expect(r.problems).toEqual(["manifest not found"]);
    writeFileSync(manifestPath, manifest);
    expect(
      (await verifyArtifact({ artifact, key: c.key, output: out("ok.sqlite") }))
        .ok,
    ).toBe(true);
  });
  it("detects tampering even when the attacker also fixes the manifest hash", async () => {
    const { dir, c, artifact } = await backedUp("forge");
    const { createHash } = await import("node:crypto");
    const forged = Buffer.from(readFileSync(artifact));
    forged[forged.length - 100] ^= 0x01;
    writeFileSync(artifact, forged);
    const manifest = JSON.parse(readFileSync(`${artifact}.json`, "utf8"));
    manifest.artifactSha256 = createHash("sha256").update(forged).digest("hex");
    writeFileSync(`${artifact}.json`, JSON.stringify(manifest));
    const r = await verifyArtifact({
      artifact,
      key: c.key,
      output: join(dir, "forged.sqlite"),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(
      /decryption failed|incorrect header|invalid|unexpected/i,
    );
    expect(existsSync(join(dir, "forged.sqlite"))).toBe(false);
  });
  it("reports a wrong or missing key without leaking either key", async () => {
    const { dir, artifact } = await backedUp("key");
    const wrong = await verifyArtifact({
      artifact,
      key: Buffer.from(OTHER_KEY, "base64"),
      output: join(dir, "w.sqlite"),
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join()).toMatch(/wrong key/);
    expect(JSON.stringify(wrong)).not.toContain(OTHER_KEY);
    expect(JSON.stringify(wrong)).not.toContain(KEY);
    const missing = await verifyArtifact({
      artifact,
      key: null,
      output: join(dir, "m.sqlite"),
    });
    expect(missing.problems.join()).toMatch(/key is required/);
  });
  it("rehearses a restore and leaves nothing behind", async () => {
    const { dir, c, artifact } = await backedUp("rehearse");
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    const result = await rehearseRestore({ artifact, key: c.key, scratch });
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("off-server copies", () => {
  it("copies artifact and manifest to a directory target and verifies the copy", async () => {
    const dir = fresh("remote");
    const { db } = liveDatabase(dir);
    const remote = join(dir, "remote-store");
    const c = config(dir, { SPORTOZEN_BACKUP_TARGET_DIR: remote });
    const result = await createBackup({ config: c });
    expect(result.uploaded).toBe("directory");
    expect(readdirSync(remote).sort()).toEqual(
      [result.name, `${result.name}.json`].sort(),
    );
    const restored = await restoreBackup({
      artifact: join(remote, result.name),
      key: c.key,
      target: join(dir, "from-remote.sqlite"),
    });
    expect(restored.ok).toBe(true);
    const status = readStatus(c.directory);
    expect(status.lastOffServer.name).toBe(result.name);
    expect(status.lastSuccess.offServer).toBe(true);
    db.close();
  });
  it("keeps the local backup and says so when the upload fails", async () => {
    const dir = fresh("remote-fail");
    const { db } = liveDatabase(dir);
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "file");
    const c = config(dir, {
      SPORTOZEN_BACKUP_TARGET_DIR: join(blocker, "sub"),
    });
    await expect(createBackup({ config: c })).rejects.toMatchObject({
      stage: "upload",
    });
    const status = readStatus(c.directory);
    expect(status.lastSuccess.offServer).toBe(false);
    expect(status.lastOffServer).toBeUndefined();
    expect(status.lastFailure.stage).toBe("upload");
    expect(listBackups(c.directory)).toHaveLength(1);
    db.close();
  });
  it("runs an upload command without a shell and redacts secrets from its output", async () => {
    const dir = fresh("command");
    const { db } = liveDatabase(dir);
    const dest = join(dir, "cmd-store");
    mkdirSync(dest);
    const copier = join(dir, "copier.mjs");
    writeFileSync(
      copier,
      `import { copyFileSync } from "node:fs"; import { join } from "node:path";
if (process.argv[2].includes("FAIL")) { console.error("boom ${KEY}"); process.exit(3); }
copyFileSync(process.argv[2], join(process.argv[3], process.argv[4]));`,
    );
    const c = config(dir, {
      SPORTOZEN_BACKUP_TARGET_COMMAND: JSON.stringify([
        process.execPath,
        copier,
        "{file}",
        dest,
        "{name}",
      ]),
    });
    const ok = await createBackup({ config: c });
    expect(ok.uploaded).toBe("command");
    expect(readdirSync(dest)).toHaveLength(2);
    // A path with shell metacharacters is passed as one argument, not interpreted.
    const evil = fresh("command-fail");
    const second = liveDatabase(evil);
    const bad = config(evil, {
      SPORTOZEN_BACKUP_TARGET_COMMAND: JSON.stringify([
        process.execPath,
        copier,
        "FAIL{file}",
        dest,
        "{name}",
      ]),
    });
    const failure = await createBackup({ config: bad }).catch((e) => e);
    expect(failure.stage).toBe("upload");
    expect(failure.message).toContain("exit 3");
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).toContain("[redacted]");
    second.db.close();
    db.close();
  });
});

describe("retention", () => {
  const at = (iso: string, label = "scheduled") => ({
    name: `${iso}-${label}`,
    createdAt: new Date(iso),
    label,
  });
  const hourly = (days: number) =>
    Array.from({ length: days * 24 }, (_v, i) =>
      at(new Date(Date.UTC(2026, 9, 31, 12) - i * 3600_000).toISOString()),
    );
  it("keeps the newest N, one per day and one per month", () => {
    const entries = hourly(100);
    const now = Date.UTC(2026, 9, 31, 12);
    const { keep } = selectRetained(entries, now, {
      hourly: 24,
      daily: 30,
      monthly: 12,
    });
    const days = new Set(
      entries
        .filter((e) => keep.has(e.name))
        .map((e) => e.createdAt.toISOString().slice(0, 10)),
    );
    expect(keep.size).toBeLessThanOrEqual(24 + 30 + 12);
    expect(keep.has(entries[0]!.name)).toBe(true);
    expect(days.size).toBeGreaterThanOrEqual(30);
    // the oldest month in range keeps its newest backup
    expect([...keep].some((n) => n.startsWith("2026-07"))).toBe(true);
    expect(keep.size).toBeLessThan(entries.length);
  });
  it("always keeps the newest backup, even with a zero policy", () => {
    const entries = hourly(3);
    const { keep, remove } = selectRetained(entries, Date.now(), {
      hourly: 1,
      daily: 0,
      monthly: 0,
    });
    expect(keep.size).toBe(1);
    expect(keep.has(entries[0]!.name)).toBe(true);
    expect(remove).toHaveLength(entries.length - 1);
  });
  it("protects pre-deploy backups for 14 days only", () => {
    const now = Date.UTC(2026, 9, 31, 12);
    const young = at("2026-10-25T10:00:00.000Z", "pre-deploy");
    const old = at("2026-09-01T10:00:00.000Z", "pre-deploy");
    const newest = at("2026-10-31T11:00:00.000Z");
    const { keep } = selectRetained([newest, young, old], now, {
      hourly: 1,
      daily: 0,
      monthly: 0,
    });
    expect(keep.has(young.name)).toBe(true);
    expect(keep.has(old.name)).toBe(false);
  });
  it("prunes artifact and manifest together and touches nothing else", async () => {
    const dir = fresh("prune");
    const { db } = liveDatabase(dir);
    const c = config(dir, {
      SPORTOZEN_BACKUP_KEEP_HOURLY: "2",
      SPORTOZEN_BACKUP_KEEP_DAILY: "0",
      SPORTOZEN_BACKUP_KEEP_MONTHLY: "0",
    });
    mkdirSync(c.directory, { recursive: true });
    writeFileSync(join(c.directory, "notes.txt"), "keep");
    writeFileSync(
      join(
        c.directory,
        "sportozen-20250101T000000Z-scheduled.sqlite.gz.enc.partial",
      ),
      "keep",
    );
    const start = Date.now();
    for (let i = 0; i < 4; i++)
      await createBackup({ config: c, now: start + i * 3600_000 });
    const backups = listBackups(c.directory);
    expect(backups).toHaveLength(2);
    const files = only(c.directory);
    expect(files).toContain("notes.txt");
    expect(files).toContain(
      "sportozen-20250101T000000Z-scheduled.sqlite.gz.enc.partial",
    );
    expect(
      files.filter((n) => n.startsWith("sportozen-") && n.endsWith(".json")),
    ).toHaveLength(2);
    expect(latestBackup(c.directory)).toContain(backups[0]!.name);
    db.close();
  });
});

describe("command line", () => {
  // The working directory stands for the application directory; staging must be outside it.
  const appDirectory = mkdtempSync(join(tmpdir(), "sportozen-app-"));
  afterAll(() => rmSync(appDirectory, { recursive: true, force: true }));
  const cli = (script: string, args: string[], extra: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", script), ...args],
      {
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production" as const,
          ...extra,
        },
        cwd: appDirectory,
        encoding: "utf8",
      },
    );
  let dir: string, e: Record<string, string>, live: DatabaseSync;
  beforeAll(() => {
    dir = fresh("cli");
    live = liveDatabase(dir).db;
    e = env(dir, { SPORTOZEN_BACKUP_TARGET_DIR: join(dir, "remote") });
  });
  afterAll(() => live.close());

  it("backs up, reports status against the RPO and rehearses a restore", () => {
    const made = cli("backup-database.mjs", ["--label", "cli"], e);
    expect(made.status, made.stdout + made.stderr).toBe(0);
    expect(made.stdout).toContain("backup complete");
    expect(made.stdout + made.stderr).not.toContain(KEY);
    const noRpo = cli("backup-status.mjs", [], e);
    expect(noRpo.status).toBe(3);
    expect(noRpo.stdout).toContain("RPO not configured");
    const within = cli("backup-status.mjs", ["--json"], {
      ...e,
      SPORTOZEN_BACKUP_RPO_MINUTES: "60",
    });
    expect(within.status).toBe(0);
    expect(JSON.parse(within.stdout)).toMatchObject({
      verdict: "ok",
      offServerConfigured: true,
    });
    const [file] = readdirSync(join(dir, "remote")).filter((n) =>
      n.endsWith(".enc"),
    );
    const rehearsal = cli(
      "restore-database.mjs",
      ["--backup", join(dir, "remote", file!), "--rehearse"],
      { ...e, SPORTOZEN_BACKUP_RTO_MINUTES: "240" },
    );
    expect(rehearsal.status, rehearsal.stdout + rehearsal.stderr).toBe(0);
    expect(rehearsal.stdout).toContain("integrity ok");
    expect(rehearsal.stdout).toContain("RTO budget 240 min");
    expect(rehearsal.stdout + rehearsal.stderr).not.toContain(KEY);
  });
  it("status fails when the newest backup is older than the RPO", () => {
    const stale = fresh("cli-stale");
    mkdirSync(join(stale, "staging"), { recursive: true });
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    writeFileSync(
      join(stale, "staging", "status.json"),
      JSON.stringify({
        lastSuccess: { at: old, offServer: true },
        lastOffServer: { at: old },
      }),
    );
    const result = cli("backup-status.mjs", [], {
      ...env(stale, { SPORTOZEN_BACKUP_TARGET_DIR: join(stale, "r") }),
      SPORTOZEN_BACKUP_RPO_MINUTES: "60",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/over the 60 min RPO/);
    const none = cli("backup-status.mjs", [], env(fresh("cli-none"), {}));
    expect(none.status).toBe(1);
  });
  it("exits 2 when stored but not uploaded, and 1 when misconfigured", () => {
    const d = fresh("cli-exit");
    liveDatabase(d).db.close();
    const blocker = join(d, "file");
    writeFileSync(blocker, "x");
    const notUploaded = cli(
      "backup-database.mjs",
      [],
      env(d, { SPORTOZEN_BACKUP_TARGET_DIR: join(blocker, "sub") }),
    );
    expect(notUploaded.status).toBe(2);
    const misconfigured = cli("backup-database.mjs", [], {
      SPORTOZEN_DATABASE_PATH: join(d, "data", "live.sqlite"),
    });
    expect(misconfigured.status).toBe(1);
    expect(misconfigured.stdout).toContain("SPORTOZEN_BACKUP_DIR is not set");
  });
  it("restore refuses the live database and reports corruption", () => {
    const [file] = readdirSync(join(dir, "remote")).filter((n) =>
      n.endsWith(".enc"),
    );
    const artifact = join(dir, "remote", file!);
    const refused = cli(
      "restore-database.mjs",
      ["--backup", artifact, "--target", e.SPORTOZEN_DATABASE_PATH!],
      e,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("live database");
    const copy = join(dir, "damaged.sqlite.gz.enc");
    const bytes = Buffer.from(readFileSync(artifact));
    bytes[bytes.length - 30]! ^= 0xff;
    writeFileSync(copy, bytes);
    writeFileSync(`${copy}.json`, readFileSync(`${artifact}.json`));
    const damaged = cli(
      "restore-database.mjs",
      ["--backup", copy, "--verify-only"],
      e,
    );
    expect(damaged.status).toBe(1);
    expect(damaged.stderr).toContain("VERIFICATION FAILED");
    expect(damaged.stdout + damaged.stderr).not.toContain(KEY);
    const noKey = cli(
      "restore-database.mjs",
      ["--backup", artifact, "--verify-only"],
      { ...e, SPORTOZEN_BACKUP_ENCRYPTION_KEY: "" },
    );
    expect(noKey.status).toBe(1);
  });
});
