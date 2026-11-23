/**
 * WP2: how the fee account grows with the number of billing months, measured on
 * a COPY of a synthetic database (the source is copied first and never opened).
 * For 1, 3, 6 and 12 months of invoices for every player (a payment for two
 * thirds of them, half of those verified) it reports the Owner's fee account
 * and one Parent's: decoded and gzip bytes, SQL statements and time.
 *
 * node --conditions=react-server --import tsx scripts/measure-fee-growth.ts \
 *   .local/e2e-bharat-<id>.sqlite <academyId> [out.json]
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [source, academyId, out] = process.argv.slice(2);
if (!source || !academyId)
  throw new Error(
    "Usage: measure-fee-growth.ts <synthetic .sqlite> <academyId> [out.json]",
  );
const directory = mkdtempSync(join(tmpdir(), "sportozen-fee-growth-"));
const copy = join(directory, "growth.sqlite");
copyFileSync(resolve(source), copy);
if (existsSync(`${resolve(source)}-wal`))
  copyFileSync(`${resolve(source)}-wal`, `${copy}-wal`);
process.env.SPORTOZEN_DATABASE_PATH = copy;

async function main() {
  const { database } = await import("../src/server/database");
  const { workspaceRepository: repo } =
    await import("../src/server/workspace-repository");
  const { financeAction, financeView } =
    await import("../src/server/finance-service");
  type Access = Parameters<typeof financeView>[0];
  const db = database();
  const access = (userId: string): Access => ({
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
  });
  const userOf = (role: string) =>
    String(
      db
        .prepare(
          "SELECT userId FROM academy_memberships WHERE academyId=? AND role=? AND active=1 ORDER BY rowid LIMIT 1",
        )
        .get(academyId, role)!.userId,
    );
  const owner = access(userOf("OWNER")),
    parent = access(userOf("PARENT"));
  const players = repo.list(academyId, "player");
  const fee = (action: string, data: unknown, extra = {}) =>
    financeAction(owner, {
      requestId: randomUUID(),
      action,
      data,
      ...extra,
    }) as { id: string; version: number };
  const plan = fee("plan", {
    name: "Synthetic monthly training",
    amountMinor: 250000,
    currency: "INR",
    billingFrequency: "MONTHLY",
    applicableStartDate: "2025-01-01",
    dueAfterDays: 7,
    active: true,
  });

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
  const measure = (who: Access) => {
    queries = 0;
    db.prepare = counting;
    const json = JSON.stringify(financeView(who));
    db.prepare = prepare;
    const statements = queries;
    const times: number[] = [];
    for (let run = 0; run < 9; run++) {
      const start = performance.now();
      JSON.stringify(financeView(who));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      bytes: Buffer.byteLength(json),
      gzip: gzipSync(json).byteLength,
      statements,
      medianMs: Number(times[4].toFixed(1)),
    };
  };

  const rows: Record<string, unknown>[] = [];
  let months = 0,
    invoices = 0,
    payments = 0;
  for (const target of [1, 3, 6, 12]) {
    while (months < target) {
      const month = months + 1,
        mm = String(month).padStart(2, "0");
      for (const [index, player] of players.entries()) {
        const invoice = fee("invoice", {
          playerId: player.id,
          planId: plan.id,
          label: `2025-${mm} training fee`,
          chargeMinor: 250000,
          currency: "INR",
          periodStart: `2025-${mm}-01`,
          periodEnd: `2025-${mm}-28`,
          dueDate: `2025-${mm}-07`,
        });
        invoices++;
        if (index % 3 === 2) continue;
        const payment = fee("reference", {
          invoiceId: invoice.id,
          amountMinor: 250000,
          currency: "INR",
          reference: `SYNTHETIC-${randomUUID()}`,
          method: "BANK_TRANSFER",
          paidOn: `2025-${mm}-06`,
        });
        payments++;
        if (index % 2 === 0)
          fee(
            "verify",
            { reviewed: true, note: "Matched synthetic bank record." },
            { id: payment.id, expectedVersion: payment.version },
          );
      }
      months++;
    }
    rows.push({
      months: target,
      invoices,
      payments,
      owner: measure(owner),
      parent: measure(parent),
    });
  }
  db.close();
  rmSync(directory, { recursive: true, force: true });
  const text = JSON.stringify({ players: players.length, rows }, null, 1);
  console.log(text);
  if (out) writeFileSync(out, text);
}
main().catch((error) => {
  rmSync(directory, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
