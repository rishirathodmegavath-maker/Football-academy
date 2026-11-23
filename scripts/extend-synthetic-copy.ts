/**
 * Adds the entities the Bharat seed lacks (invoices and payments, trials,
 * published updates, conversations, weekly plans) to a COPY of the synthetic
 * Bharat database, through the same services the application uses. The source
 * file is never opened or changed; the extended copy is written next to the
 * destination you name and the original 60-player baseline stays comparable.
 *
 * node --conditions=react-server --import tsx scripts/extend-synthetic-copy.ts \
 *   .local/e2e-bharat-<id>.sqlite <academyId> <destination .sqlite>
 */
import { copyFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const [source, academyId, destination] = process.argv.slice(2);
if (!source || !academyId || !destination)
  throw new Error(
    "Usage: extend-synthetic-copy.ts <source .sqlite> <academyId> <destination .sqlite>",
  );
if (resolve(source) === resolve(destination))
  throw new Error("The destination must be a different file.");
copyFileSync(resolve(source), resolve(destination));
if (existsSync(`${resolve(source)}-wal`))
  copyFileSync(`${resolve(source)}-wal`, `${resolve(destination)}-wal`);
process.env.SPORTOZEN_DATABASE_PATH = resolve(destination);

async function main() {
  const { database } = await import("../src/server/database");
  const { workspaceRepository: repo } =
    await import("../src/server/workspace-repository");
  const { financeAction } = await import("../src/server/finance-service");
  const { trialAction } = await import("../src/server/trial-service");
  const { periodAction } = await import("../src/server/period-service");
  const { saveRecord, reviewUpdate, publishUpdate } =
    await import("../src/server/workspace-service");
  const db = database();
  const ownerId = String(
    db
      .prepare(
        "SELECT userId FROM academy_memberships WHERE academyId=? AND role='OWNER' LIMIT 1",
      )
      .get(academyId)!.userId,
  );
  const owner = {
    academy: repo.academy(academyId)!,
    membership: repo.membership(academyId, ownerId)!,
    user: {
      id: ownerId,
      name: "Synthetic Owner",
      email: "",
      emailVerified: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      image: null,
    },
  };
  const players = repo.list(academyId, "player");
  const squads = repo.list(academyId, "squad");
  const fee = (action: string, data: unknown, extra = {}) =>
    financeAction(owner, {
      requestId: randomUUID(),
      action,
      data,
      ...extra,
    }) as { id: string; version: number };

  // Invoices for every player; payments for two thirds, half of those verified.
  const plan = fee("plan", {
    name: "Synthetic monthly training",
    amountMinor: 250000,
    currency: "INR",
    billingFrequency: "MONTHLY",
    applicableStartDate: "2026-09-01",
    dueAfterDays: 7,
    active: true,
  });
  let invoices = 0,
    payments = 0,
    verified = 0;
  for (const [index, player] of players.entries()) {
    const invoice = fee("invoice", {
      playerId: player.id,
      planId: plan.id,
      label: "October training fee",
      chargeMinor: 250000,
      currency: "INR",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      dueDate: "2026-10-07",
    });
    invoices++;
    if (index % 3 === 2) continue;
    const payment = fee("reference", {
      invoiceId: invoice.id,
      amountMinor: 250000,
      currency: "INR",
      reference: `SYNTHETIC-${randomUUID()}`,
      method: "BANK_TRANSFER",
      paidOn: "2026-10-06",
    });
    payments++;
    if (index % 2 === 0) {
      fee(
        "verify",
        { reviewed: true, note: "Matched synthetic bank record." },
        { id: payment.id, expectedVersion: payment.version },
      );
      verified++;
    }
  }
  // Trials for five players.
  trialAction(owner, {
    requestId: randomUUID(),
    action: "policy",
    expectedVersion: 0,
    data: {
      defaultDurationDays: 10,
      paidTrialsAllowed: false,
      defaultFeeMinor: 0,
      currency: "INR",
      feeRuleNote: "",
    },
  });
  let trials = 0;
  for (const player of players.slice(0, 5)) {
    const squad =
      squads.find((s) => s.playerIds.includes(player.id)) ?? squads[0];
    trialAction(owner, {
      requestId: randomUUID(),
      action: "create",
      expectedVersion: 0,
      data: {
        playerId: player.id,
        squadId: squad.id,
        coachId: player.coachId,
        startDate: "2026-10-12",
        endDate: "2026-10-21",
        pricing: "FREE",
        feeMinor: 0,
        currency: "INR",
      },
    });
    trials++;
  }
  // Published updates from ten approved reports.
  const reports = repo
    .list(academyId, "report")
    .filter((r) => r.status === "Approved")
    .slice(0, 10);
  let updates = 0;
  for (const report of reports) {
    const update = saveRecord(owner, "update", {
      playerId: report.playerId,
      sportId: "football",
      planId: report.planId,
      type: "DEVELOPMENT",
      sourceReportId: report.id,
      messageBody: "Synthetic update: steady progress this month.",
    }) as { id: string };
    reviewUpdate(owner, update.id, "submit", true);
    reviewUpdate(owner, update.id, "approve", true);
    publishUpdate(owner, update.id);
    updates++;
  }
  // Conversations from twenty guardians, each with a public and an internal message.
  let conversations = 0;
  for (const player of players.slice(0, 20)) {
    const link = db
      .prepare(
        "SELECT userId FROM guardian_relationships WHERE academyId=? AND playerId=? LIMIT 1",
      )
      .get(academyId, player.id);
    if (!link) continue;
    const stamp = {
      version: 1,
      updatedAt: "2026-10-05T00:00:00.000Z",
      updatedBy: String(link.userId),
    };
    repo.save(academyId, "conversation", {
      id: `synthetic-conversation-${player.id}`,
      academyId,
      ...stamp,
      guardianId: String(link.userId),
      playerId: player.id,
      subject: "Synthetic question about practice",
      status: "OPEN",
      messages: [
        {
          id: `${player.id}-1`,
          senderId: String(link.userId),
          senderRole: "PARENT",
          body: "How can we practise at home?",
          at: "2026-10-05T05:00:00.000Z",
          internal: false,
        },
        {
          id: `${player.id}-2`,
          senderId: ownerId,
          senderRole: "OWNER",
          body: "Synthetic internal note.",
          at: "2026-10-05T06:00:00.000Z",
          internal: true,
        },
      ],
    });
    conversations++;
  }
  // A weekly draft for each batch.
  let weekly = 0;
  for (const squad of squads) {
    periodAction(owner, {
      requestId: randomUUID(),
      action: "weeklyPrepare",
      data: { squadId: squad.id, week: "2026-10-19" },
    });
    weekly++;
  }
  console.log(
    JSON.stringify({
      destination: resolve(destination),
      added: {
        invoices,
        payments,
        verifiedPayments: verified,
        trials,
        updates,
        conversations,
        weeklyPlans: weekly,
      },
    }),
  );
  db.close();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
