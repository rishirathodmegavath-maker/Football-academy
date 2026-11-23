// Extended synthetic fixture: the business entities the API baseline fixture
// does not cover. Everything is created through the real services (finance,
// trial, period and workspace services), so the stored shapes are the ones the
// application writes. Call after seedApiFixture(); it leaves that fixture's
// records untouched and adds to them.
import { randomUUID } from "node:crypto";
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import {
  publishUpdate,
  reviewUpdate,
  saveRecord,
} from "@/server/workspace-service";
import { financeAction } from "@/server/finance-service";
import { trialAction } from "@/server/trial-service";
import { periodAction } from "@/server/period-service";
import type {
  WorkspaceConversation,
  WorkspacePlayer,
  WorkspaceUpdate,
} from "@/domain/workspace";
import type { TrialEnrolment } from "@/domain/trial";
import type { FinancePayment } from "@/domain/finance";
import type { WeeklyPlan } from "@/domain/communication";
import { registerTestUser, type TestUser } from "./mock-auth";
import type { WorkspaceAccess } from "@/server/workspace-access";
import { A, B, ids, contextFor, type Fixture } from "./api-harness";

export const extended = {
  platformAdmin: "platform-admin",
  support: "support-1",
} as const;

const users: Record<string, TestUser> = {};
/** An access context for a user of the extended fixture (support member). */
export function extendedContext(userId: string): WorkspaceAccess {
  const membership = repo.membership(A, userId);
  if (!membership) throw new Error(`No membership for ${userId}`);
  return { academy: repo.academy(A)!, membership, user: users[userId] };
}

export interface ExtendedFixture {
  trialPlayerId: string;
  payments: { verified: string; pending: string };
  trial: TrialEnrolment;
  update: WorkspaceUpdate;
  conversation: WorkspaceConversation;
  weekly: WeeklyPlan;
}

export function seedExtendedFixture(base: Fixture): ExtendedFixture {
  const db = database();
  const owner = contextFor("ownerA");
  const stamp = {
    version: 1,
    updatedAt: "2026-09-02T00:00:00.000Z",
    updatedBy: ids.ownerA,
  };
  const fee = (action: string, data: unknown, extra = {}) =>
    financeAction(owner, { requestId: randomUUID(), action, data, ...extra });

  // Payments: one reference submitted and verified for player 1's invoice,
  // one submitted and still awaiting verification for player 2's.
  const pay = (invoiceId: string, amountMinor: number) =>
    fee("reference", {
      invoiceId,
      amountMinor,
      currency: "INR",
      reference: `SYNTHETIC-${randomUUID()}`,
      method: "BANK_TRANSFER",
      paidOn: "2026-09-20",
    }) as FinancePayment;
  const verified = pay(base.invoices[ids.p1], 100000),
    pending = pay(base.invoices[ids.p2], 50000);
  fee(
    "verify",
    { reviewed: true, note: "Matched synthetic bank record to invoice." },
    { id: verified.id, expectedVersion: verified.version },
  );

  // A trial: a new trial player in batch A with a policy and a free enrolment.
  const player = saveRecord(owner, "player", {
    name: "Synthetic Trial Player",
    birthDate: "2015-04-04",
    squad: "Squad A",
    squadId: ids.squadA,
    coachId: ids.coachA,
    status: "TRIAL",
    placementReviewed: true,
  }) as WorkspacePlayer;
  const trialRequest = (action: string, data: unknown) => ({
    requestId: randomUUID(),
    action,
    data,
    expectedVersion: 0,
  });
  trialAction(
    owner,
    trialRequest("policy", {
      defaultDurationDays: 10,
      paidTrialsAllowed: false,
      defaultFeeMinor: 0,
      currency: "INR",
      feeRuleNote: "",
    }),
  );
  const trial = trialAction(
    owner,
    trialRequest("create", {
      playerId: player.id,
      squadId: ids.squadA,
      coachId: ids.coachA,
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      pricing: "FREE",
      feeMinor: 0,
      currency: "INR",
    }),
  ) as TrialEnrolment;

  // An approved, published parent update for player 1 from their approved report.
  const plan = repo.list(A, "plan").find((p) => p.playerId === ids.p1)!;
  const update = saveRecord(owner, "update", {
    playerId: ids.p1,
    sportId: "football",
    planId: plan.id,
    type: "DEVELOPMENT",
    sourceReportId: base.reports[ids.p1],
    messageBody: "Synthetic update: first touch is improving.",
  }) as WorkspaceUpdate;
  reviewUpdate(owner, update.id, "submit", true);
  reviewUpdate(owner, update.id, "approve", true);
  publishUpdate(owner, update.id);

  // A conversation started by parent 1 with a public reply and an internal note.
  const conversation: WorkspaceConversation = {
    id: "conversation-extended",
    academyId: A,
    ...stamp,
    guardianId: ids.parent1,
    playerId: ids.p1,
    subject: "Synthetic question about practice",
    status: "OPEN",
    messages: [
      {
        id: "msg-1",
        senderId: ids.parent1,
        senderRole: "PARENT",
        body: "How can we practise at home?",
        at: "2026-09-03T05:00:00.000Z",
        internal: false,
      },
      {
        id: "msg-2",
        senderId: ids.coachA,
        senderRole: "COACH",
        body: "SYNTHETIC INTERNAL COACH NOTE",
        at: "2026-09-03T06:00:00.000Z",
        internal: true,
      },
    ],
  };
  repo.save(A, "conversation", conversation);

  // A weekly plan for batch A, prepared as a draft (approval needs scheduled
  // source sessions in the week, which this fixture does not add).
  const [prepared] = periodAction(owner, {
    requestId: randomUUID(),
    action: "weeklyPrepare",
    data: { squadId: ids.squadA, week: "2026-09-07" },
  }) as WeeklyPlan[];
  const weekly = repo.find(A, "weekly", prepared.id)!;

  // A platform administrator (no academy role) and an authorised support
  // member linked to player 1 only.
  db.exec(
    "CREATE TABLE IF NOT EXISTS platform_administrators(userId TEXT PRIMARY KEY)",
  );
  db.prepare(
    "INSERT OR IGNORE INTO platform_administrators(userId) VALUES(?)",
  ).run(extended.platformAdmin);
  users[extended.platformAdmin] = registerTestUser(
    extended.platformAdmin,
    "Synthetic Platform Admin",
  );
  users[extended.support] = registerTestUser(
    extended.support,
    "Synthetic Support",
  );
  db.prepare('INSERT OR REPLACE INTO "user"(id,name) VALUES(?,?)').run(
    extended.platformAdmin,
    "Synthetic Platform Admin",
  );
  db.prepare('INSERT OR REPLACE INTO "user"(id,name) VALUES(?,?)').run(
    extended.support,
    "Synthetic Support",
  );
  db.prepare(
    "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
  ).run("m-support-ext", A, extended.support, "SUPPORT", '["football"]');
  db.prepare(
    "INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)",
  ).run(A, extended.support, ids.p1);
  void B;
  return {
    trialPlayerId: player.id,
    payments: { verified: verified.id, pending: pending.id },
    trial,
    update,
    conversation,
    weekly,
  };
}
