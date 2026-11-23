// Liveness and readiness endpoints, and a clean shutdown that leaves the
// database file complete (no write-ahead log left behind).
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
vi.mock("server-only", () => ({}));

const filename = join(tmpdir(), `sportozen-health-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
const discard = (path: string) => {
  try {
    rmSync(path, { force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left in the OS temp directory
  }
};
afterAll(async () => {
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"]) discard(filename + suffix);
});

describe("health and readiness", () => {
  it("liveness answers without touching the database", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(existsSync(filename)).toBe(false);
  });
  it("readiness is 200 with a complete schema and reveals no details", async () => {
    const { GET } = await import("@/app/api/ready/route");
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ready: true,
      checks: { database: "ok", schema: "ok" },
    });
    expect(JSON.stringify(body)).not.toContain(filename);
  });
  it("readiness fails closed when a required table is missing", async () => {
    const { database } = await import("@/server/database");
    const { REQUIRED_TABLES, readiness } = await import("@/server/readiness");
    const db = database();
    expect(REQUIRED_TABLES).toContain("request_rate_limits");
    db.exec("ALTER TABLE request_rate_limits RENAME TO request_rate_limits_x");
    try {
      const result = readiness();
      expect(result.ready).toBe(false);
      expect(result.checks.schema).toBe("failed");
    } finally {
      db.exec(
        "ALTER TABLE request_rate_limits_x RENAME TO request_rate_limits",
      );
    }
    expect(readiness().ready).toBe(true);
  });
  it("readiness turns 503 while the service is draining", async () => {
    const { GET } = await import("@/app/api/ready/route");
    const state = globalThis as { sportozenDraining?: boolean };
    state.sportozenDraining = true;
    try {
      const response = GET();
      expect(response.status).toBe(503);
      expect((await response.json()).checks.service).toBe("draining");
    } finally {
      state.sportozenDraining = false;
    }
  });
});

describe("clean shutdown", () => {
  const run = (script: string, database: string) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ["--conditions=react-server", "--import", "tsx", script],
        {
          cwd: process.cwd(),
          env: { ...process.env, SPORTOZEN_DATABASE_PATH: database },
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            output: stdout + stderr,
          }),
      );
      child.stdin?.end();
    });
  const walBytes = (database: string) =>
    existsSync(database + "-wal") ? statSync(database + "-wal").size : 0;
  const scenario = async (install: boolean) => {
    const id = randomUUID(),
      database = join(tmpdir(), `sportozen-shutdown-${id}.sqlite`),
      script = join(tmpdir(), `sportozen-shutdown-${id}.mts`),
      root = process.cwd().replace(/\\/g, "/");
    writeFileSync(
      script,
      `import { database } from ${JSON.stringify(pathToFileURL(root + "/src/server/database").href)};
import { installShutdownHandlers } from ${JSON.stringify(pathToFileURL(root + "/src/server/shutdown").href)};
${install ? "installShutdownHandlers();" : ""}
const db = database();
db.exec("CREATE TABLE IF NOT EXISTS shutdown_probe(x TEXT)");
for (let i = 0; i < 200; i++) db.prepare("INSERT INTO shutdown_probe VALUES(?)").run("row " + i);
process.exit(0);
`,
    );
    try {
      const result = await run(script, database);
      return { result, wal: walBytes(database), database };
    } finally {
      discard(script);
    }
  };
  it("checkpoints the log so the file is complete after process exit", async () => {
    const clean = await scenario(true);
    expect(clean.result.code, clean.result.output).toBe(0);
    expect(clean.wal).toBe(0);
    // The data is in the main file itself, readable without the -wal file.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(clean.database, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) n FROM shutdown_probe").get()?.n).toBe(
      200,
    );
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) discard(clean.database + suffix);
  }, 60_000);
  it("without the handler the log is left behind (the test can fail)", async () => {
    const dirty = await scenario(false);
    expect(dirty.result.code, dirty.result.output).toBe(0);
    expect(dirty.wal).toBeGreaterThan(0);
    for (const suffix of ["", "-wal", "-shm"]) discard(dirty.database + suffix);
  }, 60_000);
  it("closeDatabaseCleanly is safe before the database exists and twice", async () => {
    const { closeDatabaseCleanly } = await import("@/server/shutdown");
    expect(closeDatabaseCleanly()).toBe(true);
    expect(closeDatabaseCleanly()).toBe(false);
  });
});
