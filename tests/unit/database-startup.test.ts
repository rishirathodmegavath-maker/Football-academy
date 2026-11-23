// Opening the database while another process holds a lock, or while several
// processes open one brand-new file together (the web server and the
// communication worker, or parallel build workers), must wait and succeed.
// The first test is deterministic; the second is a probabilistic smoke test of
// the same property and cannot by itself prove the absence of the race.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Temp-file cleanup is best effort: on Windows a just-exited process can keep
// its database file locked for a moment (EPERM), and that must never mask the
// result of the test or fail it.
function discard(path: string, options: { force: boolean }) {
  try {
    rmSync(path, { ...options, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left in the OS temp directory
  }
}
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

describe("opening the database", () => {
  it("waits for a lock another process holds, then succeeds", async () => {
    const id = randomUUID(),
      database = join(tmpdir(), `sportozen-held-${id}.sqlite`),
      script = join(tmpdir(), `sportozen-held-${id}.mts`),
      marker = join(tmpdir(), `sportozen-held-${id}.started`),
      source = join(process.cwd(), "src/server/database").replace(/\\/g, "/");
    // A file that already exists in the default rollback-journal mode, with a
    // write lock held by this process, as a busy peer would hold it.
    const holder = new DatabaseSync(database);
    // As the application opens its own connections: a COMMIT must wait for the
    // brief read locks the waiting child takes, not fail at once.
    holder.exec("PRAGMA busy_timeout=5000");
    holder.exec("CREATE TABLE held(x)");
    holder.exec("BEGIN IMMEDIATE");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
import { database } from "${pathToFileURL(source).href}";
// Start-up time of this process varies with machine load, so announce the
// moment just before the call; the test times the lock from this marker.
writeFileSync(${JSON.stringify(marker)}, "about to open");
const started = Date.now();
database();
console.log("waited:" + (Date.now() - started));
`,
    );
    try {
      const running = run(script, database);
      // Wait until the child is about to open the database, then keep the
      // lock for a fixed time after that, whatever the machine load.
      const deadline = Date.now() + 40_000;
      while (!existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(existsSync(marker), "child never started").toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      holder.exec("COMMIT");
      const result = await running;
      expect(result.output).toMatch(/waited:\d+/);
      expect(result.code, result.output.slice(0, 400)).toBe(0);
      // It really waited for the lock instead of failing or skipping it.
      expect(Number(/waited:(\d+)/.exec(result.output)?.[1])).toBeGreaterThan(
        500,
      );
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // already committed
      }
      holder.close();
      discard(script, { force: true });
      discard(marker, { force: true });
      for (const suffix of ["", "-wal", "-shm"])
        discard(database + suffix, { force: true });
    }
  }, 90_000);
  it("lets many processes start against a new file at once", async () => {
    const id = randomUUID(),
      database = join(tmpdir(), `sportozen-startup-${id}.sqlite`),
      script = join(process.cwd(), `.local/startup-${id}.mts`);
    mkdirSync(join(process.cwd(), ".local"), { recursive: true });
    writeFileSync(
      script,
      `import { database, atomic } from "../src/server/database";
const db = database();
atomic(() => db.prepare("SELECT 1").get());
console.log("ok");
`,
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 16 }, () => run(script, database)),
      );
      expect(
        results.filter((r) => r.code !== 0).map((r) => r.output.slice(0, 300)),
      ).toEqual([]);
    } finally {
      discard(script, { force: true });
      for (const suffix of ["", "-wal", "-shm"])
        discard(database + suffix, { force: true });
    }
  }, 120_000);
});
