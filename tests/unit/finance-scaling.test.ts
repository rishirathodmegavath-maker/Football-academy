// WP2: the fee account must not cost more per invoice as invoices accumulate.
// Listing it used to read every payment and adjustment of the academy once per
// invoice, so it grew with invoices × payments (10 ms at one month of invoices
// for 60 players, about 1.8 s at twelve). Its figures must be unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { financeAction, financeView } from "@/server/finance-service";
import type { FinancePayment } from "@/domain/finance";
import {
  ids,
  contextFor,
  countQueries,
  seedApiFixture,
} from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-finance-scaling-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const owner = () => contextFor("ownerA");
const fee = (action: string, data: unknown, extra = {}) =>
  financeAction(owner(), {
    requestId: randomUUID(),
    action,
    data,
    ...extra,
  }) as { id: string; version: number };

function addMonth(month: number) {
  const plan = financeView(owner()).plans[0];
  // Months after the plan starts (2026-09); payments are dated in the past.
  const at = new Date(Date.UTC(2027, month - 1, 1)),
    ym = at.toISOString().slice(0, 7);
  for (const playerId of [ids.p1, ids.p2, ids.p3]) {
    const invoice = fee("invoice", {
      playerId,
      planId: plan.id,
      label: `${ym} training fee`,
      chargeMinor: 250000,
      currency: "INR",
      periodStart: `${ym}-01`,
      periodEnd: `${ym}-28`,
      dueDate: `${ym}-07`,
    });
    const payment = fee("reference", {
      invoiceId: invoice.id,
      amountMinor: 100000,
      currency: "INR",
      reference: `SYNTHETIC-${randomUUID()}`,
      method: "BANK_TRANSFER",
      paidOn: "2026-10-01",
    });
    if (playerId !== ids.p3)
      fee(
        "verify",
        { reviewed: true, note: "Matched." },
        { id: payment.id, expectedVersion: payment.version },
      );
  }
}

describe("the fee account as invoices accumulate", () => {
  it("runs the same number of statements per added invoice, however many exist", async () => {
    const statements = async () =>
      (await countQueries(() => financeView(owner()))).queries;
    const counts: number[] = [];
    for (const month of [1, 2, 3, 4, 5, 6]) {
      addMonth(month);
      counts.push(await statements());
    }
    // The fee account is a handful of list reads plus the per-player invoice
    // proposals; adding invoices and payments must not add statements to it.
    expect(new Set(counts).size).toBe(1);
  });
  it("keeps every invoice's figures consistent with its own payments", () => {
    const view = financeView(owner());
    expect(view.invoices.length).toBeGreaterThan(18);
    for (const invoice of view.invoices) {
      const own = view.payments.filter(
        (p: FinancePayment) => p.invoiceId === invoice.id,
      );
      const adjustments = view.adjustments.filter(
        (a) => a.invoiceId === invoice.id,
      );
      const adjusted = adjustments.reduce(
        (total, a) =>
          total + (a.direction === "CREDIT" ? -a.amountMinor : a.amountMinor),
        0,
      );
      expect(invoice.adjustmentMinor).toBe(adjusted);
      expect(invoice.billedMinor).toBe(invoice.chargeMinor + adjusted);
      expect(invoice.paidMinor).toBe(
        own
          .filter((p) => p.status === "VERIFIED")
          .reduce((total, p) => total + p.amountMinor, 0),
      );
      expect(invoice.pendingReferenceMinor).toBe(
        own
          .filter((p) => p.status === "PENDING")
          .reduce((total, p) => total + p.amountMinor, 0),
      );
      expect(invoice.outstandingMinor).toBe(
        invoice.billedMinor - invoice.paidMinor,
      );
    }
    const unverified = view.invoices.filter((i) => i.pendingReferenceMinor > 0);
    expect(unverified.length).toBeGreaterThan(0);
    const verified = view.invoices.filter((i) => i.paidMinor > 0);
    expect(verified.length).toBeGreaterThan(0);
  });
  it("is the same for a parent as for the owner, narrowed to their child", () => {
    const parent = financeView(contextFor("parent1"));
    const all = financeView(owner());
    expect(parent.invoices.map((i) => i.id).sort()).toEqual(
      all.invoices
        .filter((i) => i.playerId === ids.p1)
        .map((i) => i.id)
        .sort(),
    );
    for (const invoice of parent.invoices)
      expect(invoice).toEqual(all.invoices.find((i) => i.id === invoice.id));
  });
});
