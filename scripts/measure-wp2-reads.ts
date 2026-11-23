/**
 * WP2: bytes, gzip bytes, SQL statements and time for the academy payload and
 * for each focused read that can replace it, per role, on a temporary copy of
 * a synthetic database. The source database is copied first and never opened;
 * the copy is deleted.
 *
 * node --conditions=react-server --import tsx scripts/measure-wp2-reads.ts \
 *   .local/e2e-bharat-<id>.sqlite <academyId> [runs] [out.json]
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [source, academyId, runsArg, out] = process.argv.slice(2);
if (!source || !academyId)
  throw new Error(
    "Usage: measure-wp2-reads.ts <synthetic .sqlite> <academyId> [runs] [out.json]",
  );
const runs = Number(runsArg ?? 15);
const directory = mkdtempSync(join(tmpdir(), "sportozen-wp2-reads-"));
const copy = join(directory, "measure.sqlite");
copyFileSync(resolve(source), copy);
if (existsSync(`${resolve(source)}-wal`))
  copyFileSync(`${resolve(source)}-wal`, `${copy}-wal`);
process.env.SPORTOZEN_DATABASE_PATH = copy;

async function main() {
  const { database } = await import("../src/server/database");
  const { workspaceRepository: repo } =
    await import("../src/server/workspace-repository");
  const { workspace, workspaceBootstrap } =
    await import("../src/server/workspace-service");
  const { homeSummary } = await import("../src/server/home-summary-service");
  const { queryRecords } = await import("../src/server/records-query");
  const { financeView } = await import("../src/server/finance-service");
  const { communicationView } =
    await import("../src/server/communication-service");
  const { trialView } = await import("../src/server/trial-service");
  const { visibleRecord } = await import("../src/server/workspace-access");
  const { payloadFor } = await import("../src/services/workspace-profiles");
  type Access = Parameters<typeof workspace>[0];
  const db = database();
  let queries = 0;
  const prepare = db.prepare;
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
  const persona = (role: string): Access | undefined => {
    const row = db
      .prepare(
        'SELECT m.userId,u.name FROM academy_memberships m JOIN "user" u ON u.id=m.userId WHERE m.academyId=? AND m.role=? AND m.active=1 ORDER BY m.rowid LIMIT 1',
      )
      .get(academyId, role);
    if (!row) return undefined;
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
  const rows: Record<string, string | number>[] = [];
  const measure = (role: string, label: string, read: () => unknown) => {
    queries = 0;
    db.prepare = counting;
    const json = JSON.stringify(read());
    db.prepare = prepare;
    const count = queries;
    read();
    const times: number[] = [];
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      JSON.stringify(read());
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    rows.push({
      role,
      read: label,
      bytes: Buffer.byteLength(json),
      gzip: gzipSync(json).byteLength,
      queries: count,
      medianMs: Number(times[Math.floor(times.length / 2)].toFixed(1)),
      digest: createHash("sha256")
        .update(json.replace(/"generatedAt":"[^"]*"/, ""))
        .digest("hex")
        .slice(0, 12),
    });
  };
  const month = "2026-09";
  for (const [role, label] of [
    ["OWNER", "owner"],
    ["COACH", "coach"],
    ["PARENT", "parent"],
  ] as const) {
    const ctx = persona(role);
    if (!ctx) continue;
    measure(label, "full academy payload (baseline)", () => workspace(ctx));
    measure(label, "bootstrap", () => workspaceBootstrap(ctx));
    if (role !== "PARENT")
      measure(label, "home summary", () => homeSummary(ctx));
    for (const screen of ["fees", "settings", "calendar"]) {
      const wanted = payloadFor(screen, role);
      if (Array.isArray(wanted))
        measure(label, `payload for ${screen} (${wanted.length} kinds)`, () =>
          workspace(ctx, wanted),
        );
    }
    if (role !== "PARENT") {
      const first = (
        queryRecords(
          ctx,
          "report",
          new URLSearchParams("view=summary&limit=1"),
        ) as { items: { id: string; playerId: string }[] }
      ).items[0];
      measure(label, "reports: summary list (all)", () =>
        queryRecords(ctx, "report", new URLSearchParams("view=summary")),
      );
      measure(label, "reports: summary page of 20", () =>
        queryRecords(
          ctx,
          "report",
          new URLSearchParams(`view=summary&limit=20&period=${month}`),
        ),
      );
      if (first)
        measure(label, "reports: one full report", () =>
          visibleRecord(ctx, "report", first.id),
        );
      measure(label, "sessions: one week, summary", () =>
        queryRecords(
          ctx,
          "session",
          new URLSearchParams("view=summary&from=2026-09-14&to=2026-09-20"),
        ),
      );
      const session = (
        queryRecords(ctx, "session", new URLSearchParams("limit=1")) as {
          items: { id: string }[];
        }
      ).items[0];
      if (session)
        measure(label, "attendance: one session", () =>
          queryRecords(
            ctx,
            "attendance",
            new URLSearchParams(`session=${session.id}`),
          ),
        );
      measure(label, "players: page of 20", () =>
        queryRecords(ctx, "player", new URLSearchParams("limit=20")),
      );
    } else {
      measure(label, "reports: summary list", () =>
        queryRecords(ctx, "report", new URLSearchParams("view=summary")),
      );
    }
    if (role !== "COACH")
      measure(label, "finance view", () => financeView(ctx));
    if (role !== "PARENT") {
      measure(label, "communication view", () => communicationView(ctx));
      const trial = db
        .prepare(
          "SELECT playerId FROM academy_trial_enrolments WHERE academyId=? LIMIT 1",
        )
        .get(academyId);
      if (trial)
        measure(label, "trial view (one player)", () =>
          trialView(ctx, String(trial.playerId)),
        );
    }
  }
  console.table(rows);
  if (out) writeFileSync(out, JSON.stringify({ runs, rows }, null, 1));
  db.close();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
