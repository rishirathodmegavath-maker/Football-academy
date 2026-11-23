/**
 * WP2: which SQL statements the Home summary runs, how often, for each role, on
 * a COPY of a synthetic database (the source is copied first, never opened).
 * Used to attribute the statement count before anything is changed.
 *
 * node --conditions=react-server --import tsx scripts/profile-home-sql.ts \
 *   .local/e2e-bharat-<id>.sqlite <academyId> [out.json]
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [source, academyId, out] = process.argv.slice(2);
if (!source || !academyId)
  throw new Error(
    "Usage: profile-home-sql.ts <synthetic .sqlite> <academyId> [out.json]",
  );
const directory = mkdtempSync(join(tmpdir(), "sportozen-home-sql-"));
const copy = join(directory, "profile.sqlite");
copyFileSync(resolve(source), copy);
if (existsSync(`${resolve(source)}-wal`))
  copyFileSync(`${resolve(source)}-wal`, `${copy}-wal`);
process.env.SPORTOZEN_DATABASE_PATH = copy;

async function main() {
  const { database } = await import("../src/server/database");
  const { workspaceRepository: repo } =
    await import("../src/server/workspace-repository");
  const { homeSummary } = await import("../src/server/home-summary-service");
  type Access = Parameters<typeof homeSummary>[0];
  const db = database();
  const result: Record<string, unknown> = {};
  for (const role of ["OWNER", "COACH"]) {
    const row = db
      .prepare(
        "SELECT userId FROM academy_memberships WHERE academyId=? AND role=? AND active=1 ORDER BY rowid LIMIT 1",
      )
      .get(academyId, role);
    if (!row) continue;
    const userId = String(row.userId);
    const ctx: Access = {
      academy: repo.academy(academyId)!,
      membership: repo.membership(academyId, userId)!,
      user: {
        id: userId,
        name: "Synthetic",
        email: "",
        emailVerified: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        image: null,
      },
    };
    const seen = new Map<string, number>();
    const prepare = db.prepare;
    db.prepare = ((sql: string) => {
      const statement = prepare.call(db, sql);
      const key = sql.replace(/\s+/g, " ").trim().slice(0, 150);
      for (const method of ["get", "all", "run"] as const) {
        const run = statement[method].bind(statement) as (
          ...args: unknown[]
        ) => unknown;
        Object.defineProperty(statement, method, {
          value: (...args: unknown[]) => {
            seen.set(key, (seen.get(key) ?? 0) + 1);
            return run(...args);
          },
        });
      }
      return statement;
    }) as typeof db.prepare;
    homeSummary(ctx, new Date());
    db.prepare = prepare;
    const sorted = [...seen].sort((a, b) => b[1] - a[1]);
    result[role] = {
      statements: sorted.reduce((total, [, n]) => total + n, 0),
      distinct: sorted.length,
      top: sorted.slice(0, 8).map(([sql, n]) => ({ n, sql })),
    };
  }
  db.close();
  rmSync(directory, { recursive: true, force: true });
  const text = JSON.stringify(result, null, 1);
  console.log(text);
  if (out) writeFileSync(out, text);
}
main().catch((error) => {
  rmSync(directory, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
