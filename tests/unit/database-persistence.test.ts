// Production database behaviour for a single-server SQLite deployment:
// connection settings, durability across a hard kill, restart and a new release
// directory, and several processes starting against an OLD database at once.
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
vi.mock("server-only", () => ({}));

const root = mkdtempSync(join(tmpdir(), "sportozen-persist-"));
const sourceUrl = (name: string) =>
  pathToFileURL(join(process.cwd(), "src/server", name).replace(/\\/g, "/"))
    .href;
const discard = (path: string) => {
  try {
    rmSync(path, {
      force: true,
      recursive: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    // left in the OS temp directory
  }
};
afterAll(() => discard(root));

type Run = { code: number; output: string };
// Absolute loader path so a child can run from any working directory.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const node = (
  script: string,
  env: Record<string, string>,
  cwd = process.cwd(),
) =>
  new Promise<Run>((resolve) => {
    const child = execFile(
      process.execPath,
      ["--conditions=react-server", "--import", tsx, script],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          output: stdout + stderr,
        }),
    );
    child.stdin?.end();
  });
const script = (name: string, body: string) => {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
};

describe("connection settings of the production connection", () => {
  it("uses WAL, a 5 s busy timeout, foreign keys and recursive triggers", async () => {
    const database = join(root, "pragmas.sqlite");
    const probe = script(
      "pragmas.mts",
      `import { database } from ${JSON.stringify(sourceUrl("database"))};
const db = database();
const one = (name: string) => Object.values(db.prepare("PRAGMA " + name).get() as object)[0];
console.log("RESULT " + JSON.stringify({
  journal: one("journal_mode"),
  busy: one("busy_timeout"),
  foreignKeys: one("foreign_keys"),
  recursive: one("recursive_triggers"),
  integrity: one("integrity_check"),
}));
`,
    );
    const result = await node(probe, { SPORTOZEN_DATABASE_PATH: database });
    expect(result.code, result.output).toBe(0);
    const reported = JSON.parse(/RESULT (.*)/.exec(result.output)![1]!);
    expect(reported).toEqual({
      journal: "wal",
      busy: 5000,
      foreignKeys: 1,
      recursive: 1,
      integrity: "ok",
    });
  }, 60_000);
});

describe("persistence", () => {
  it("keeps committed data after a hard kill, a restart and a different working directory", async () => {
    const database = join(root, "durable", "workspaces.sqlite");
    const writer = script(
      "writer.mts",
      `import { database, audit } from ${JSON.stringify(sourceUrl("database"))};
const db = database();
db.prepare("INSERT INTO academy_workspaces(id, config) VALUES(?, ?)").run("academy-d", "{}");
audit("academy-d", "user-1", "committed before the crash", "r1");
// Hard exit: no close(), no checkpoint, nothing flushed by the application.
process.kill(process.pid, "SIGKILL");
`,
    );
    const killed = await node(writer, { SPORTOZEN_DATABASE_PATH: database });
    expect(killed.code === 0 ? "exited cleanly" : "killed").toBe("killed");
    // A new "release directory": different cwd, same absolute database path.
    const release = join(root, "release-2");
    mkdirSync(release);
    const reader = script(
      "reader.mts",
      `import { database } from ${JSON.stringify(sourceUrl("database"))};
const db = database();
console.log("RESULT " + JSON.stringify({
  academy: db.prepare("SELECT COUNT(*) n FROM academy_workspaces WHERE id='academy-d'").get().n,
  audit: db.prepare("SELECT COUNT(*) n FROM workspace_audit WHERE action='committed before the crash'").get().n,
  version: db.prepare("PRAGMA user_version").get().user_version,
}));
`,
    );
    const restarted = await node(
      reader,
      { SPORTOZEN_DATABASE_PATH: database },
      release,
    );
    expect(restarted.code, restarted.output).toBe(0);
    expect(JSON.parse(/RESULT (.*)/.exec(restarted.output)![1]!)).toEqual({
      academy: 1,
      audit: 1,
      version: 4,
    });
    // Opening twice more changes nothing (migrations are repeatable).
    const again = await node(reader, { SPORTOZEN_DATABASE_PATH: database });
    expect(JSON.parse(/RESULT (.*)/.exec(again.output)![1]!)).toEqual({
      academy: 1,
      audit: 1,
      version: 4,
    });
  }, 90_000);

  it("creates the database directory and the file private to the owner on POSIX", async () => {
    if (process.platform === "win32") return;
    const database = join(root, "private-dir", "nested", "workspaces.sqlite");
    const open = script(
      "open.mts",
      `import { database } from ${JSON.stringify(sourceUrl("database"))};
database();`,
    );
    const result = await node(open, {
      SPORTOZEN_DATABASE_PATH: database,
    });
    expect(result.code, result.output).toBe(0);
    expect(statSync(database).mode & 0o077).toBe(0);
    expect(statSync(join(root, "private-dir", "nested")).mode & 0o077).toBe(0);
  }, 60_000);
});

describe("migrations when several processes start together", () => {
  /** A database from before delivery_attempts gained its metadata column. */
  const legacy = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE delivery_attempts(id TEXT PRIMARY KEY, jobId TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, providerId TEXT, reason TEXT)",
    );
    db.prepare(
      "INSERT INTO delivery_attempts(id, jobId, at, state) VALUES('a1', 'j1', 'now', 'SENT')",
    ).run();
    db.close();
  };
  it("survives a stale schema read: the column is already there when the ALTER runs", async () => {
    const { migrateCommunications } =
      await import("@/server/migrations/003-communications");
    const real = new DatabaseSync(":memory:");
    real.exec(
      "CREATE TABLE delivery_attempts(id TEXT PRIMARY KEY, jobId TEXT, at TEXT, state TEXT, providerId TEXT, reason TEXT)",
    );
    // Another process adds the column between this one checking and altering.
    const stale = {
      exec: (sql: string) => real.exec(sql),
      prepare: (sql: string) =>
        sql.includes("table_info(delivery_attempts)")
          ? { all: () => [] }
          : real.prepare(sql),
    } as unknown as DatabaseSync;
    real.exec("ALTER TABLE delivery_attempts ADD COLUMN metadata TEXT");
    expect(() => migrateCommunications(stale)).not.toThrow();
    expect(
      real
        .prepare("PRAGMA table_info(delivery_attempts)")
        .all()
        .filter((c) => c.name === "metadata"),
    ).toHaveLength(1);
    expect(real.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(real.isTransaction).toBe(false);
  });
  it("rolls back and reports any other migration error", async () => {
    const { migrateCommunications } =
      await import("@/server/migrations/003-communications");
    const real = new DatabaseSync(":memory:");
    real.exec(
      "CREATE TABLE delivery_attempts(id TEXT PRIMARY KEY, jobId TEXT, at TEXT, state TEXT, providerId TEXT, reason TEXT)",
    );
    const failing = {
      exec: (sql: string) => {
        if (/ALTER TABLE/.test(sql)) throw new Error("disk I/O error");
        return real.exec(sql);
      },
      prepare: (sql: string) => real.prepare(sql),
    } as unknown as DatabaseSync;
    expect(() => migrateCommunications(failing)).toThrow("disk I/O error");
    expect(real.isTransaction).toBe(false);
    expect(real.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
  });
  it("adds the missing column exactly once and keeps old rows", async () => {
    const processes = 6,
      rounds = 1;
    for (let round = 0; round < rounds; round++) {
      const id = randomUUID(),
        database = join(root, `legacy-${id}`, "workspaces.sqlite"),
        go = join(root, `go-${id}`);
      legacy(database);
      const racer = script(
        `racer-${id}.mts`,
        `import { existsSync } from "node:fs";
import { database } from ${JSON.stringify(sourceUrl("database"))};
// Release every process at once so they all see the old schema together.
while (!existsSync(${JSON.stringify(go)})) { /* spin */ }
database();
`,
      );
      const runs = Array.from({ length: processes }, () =>
        node(racer, { SPORTOZEN_DATABASE_PATH: database }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
      writeFileSync(go, "go");
      const results = await Promise.all(runs);
      const failures = results.filter((r) => r.code !== 0);
      expect(
        failures.map((r) => r.output.split("\n").find((l) => /Error/.test(l))),
        `round ${round}`,
      ).toEqual([]);
      const db = new DatabaseSync(database, { readOnly: true });
      const columns = db
        .prepare("PRAGMA table_info(delivery_attempts)")
        .all()
        .map((c) => String(c.name));
      expect(columns.filter((name) => name === "metadata")).toHaveLength(1);
      expect(
        db.prepare("SELECT COUNT(*) n FROM delivery_attempts").get()?.n,
      ).toBe(1);
      db.close();
      expect(existsSync(go)).toBe(true);
    }
  }, 180_000);
});
