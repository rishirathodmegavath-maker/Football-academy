/**
 * Measures the academy payload, finance view and record reads on a temporary
 * copy of a synthetic database: response bytes, executed SQL statements, time
 * and a digest of each response (equal digests = identical responses).
 *
 * node --conditions=react-server --import tsx scripts/measure-workspace-access.ts \
 *   .local/e2e-bharat-<id>.sqlite <academyId> [runs]
 *
 * The source database is copied first and never opened; the copy is deleted.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [source, academyId, runsArg] = process.argv.slice(2);
if (!source || !academyId)
  throw new Error(
    "Usage: measure-workspace-access.ts <synthetic .sqlite> <academyId> [runs]",
  );
const runs = Number(runsArg ?? 15);
const directory = mkdtempSync(join(tmpdir(), "sportozen-measure-"));
const copy = join(directory, "measure.sqlite");
copyFileSync(resolve(source), copy);
if (existsSync(`${resolve(source)}-wal`))
  copyFileSync(`${resolve(source)}-wal`, `${copy}-wal`);
process.env.SPORTOZEN_DATABASE_PATH = copy;

async function main() {
  const { database } = await import("../src/server/database");
  const { workspaceRepository: repo } =
    await import("../src/server/workspace-repository");
  const { workspace } = await import("../src/server/workspace-service");
  const { financeView } = await import("../src/server/finance-service");
  const { visibleRecords } = await import("../src/server/workspace-access");
  type Access = Parameters<typeof workspace>[0];
  const db = database();
  let queries = 0;
  const prepare = db.prepare;
  // Statements are counted in one separate pass; timed runs use the plain
  // prepare so the counting wrapper does not inflate the timings.
  const counting = ((sql: string) => {
    const statement = prepare.call(db, sql);
    for (const method of ["get", "all", "run"] as const) {
      const run = statement[method].bind(statement) as (
        ...args: unknown[]
      ) => unknown;
      Object.defineProperty(statement, method, {
        value: (...args: unknown[]) => {
          queries++;
          return run(...args);
        },
      });
    }
    return statement;
  }) as typeof db.prepare;
  const persona = (role: string): Access => {
    const row = db
      .prepare(
        'SELECT m.userId,u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId WHERE m.academyId=? AND m.role=? AND m.active=1 ORDER BY m.rowid LIMIT 1',
      )
      .get(academyId, role);
    if (!row) throw new Error(`No active ${role} in ${academyId}`);
    const userId = String(row.userId);
    return {
      academy: repo.academy(academyId)!,
      membership: repo.membership(academyId, userId)!,
      user: {
        id: userId,
        name: String(row.name),
        email: "",
        emailVerified: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        image: null,
      },
    };
  };
  const owner = persona("OWNER"),
    coach = persona("COACH"),
    parent = persona("PARENT");
  const rows: Record<string, string | number>[] = [];
  const measure = (label: string, read: () => unknown) => {
    queries = 0;
    db.prepare = counting;
    const json = JSON.stringify(read());
    db.prepare = prepare;
    const count = queries,
      bytes = Buffer.byteLength(json),
      digest = createHash("sha256").update(json).digest("hex").slice(0, 16);
    read(); // warm caches outside the timed runs
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      JSON.stringify(read());
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    rows.push({
      request: label,
      bytes,
      queries: count,
      medianMs: Number(times[Math.floor(times.length / 2)].toFixed(1)),
      maxMs: Number(times.at(-1)!.toFixed(1)),
      digest,
    });
  };
  measure("owner workspace()", () => workspace(owner));
  measure("coach workspace()", () => workspace(coach));
  measure("parent workspace()", () => workspace(parent));
  measure("owner financeView()", () => financeView(owner));
  measure("parent financeView()", () => financeView(parent));
  measure("owner records: attendance", () =>
    visibleRecords(owner, "attendance"),
  );
  measure("coach records: attendance", () =>
    visibleRecords(coach, "attendance"),
  );
  console.table(rows);
  console.log(JSON.stringify({ runs, rows }));
  db.close();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
