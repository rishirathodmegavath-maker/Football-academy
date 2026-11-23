import { test, expect, type APIRequestContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
// Phase 6: the money lifecycle through the real HTTP API, cross-checked against
// an independent calculation made straight from the database rows. Every
// amount is checked three ways: what the owner's API says, what the guardian's
// API says, and what the stored invoice, adjustment and payment rows add up to.
test.use({ actionTimeout: 15000 });
test("fee plans, invoices, payments, adjustments and totals agree across API, database and documents", async ({
  playwright,
}) => {
  test.setTimeout(240000);
  // Sign-up is limited per address (3 per 10 s) for the whole run: let the previous spec's window clear,
  // and leave a clear window for the next one (see the end of this test).
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8);
  type Who = { api: APIRequestContext; email: string; id: string };
  async function account(name: string): Promise<Who> {
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name}-${suffix}@example.test`;
    const r = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(r.status(), await r.text()).toBe(200);
    return { api, email, id: (await r.json()).user.id };
  }
  const call = async <T>(who: Who, path: string, data: unknown, want = 200) => {
    const r = await who.api.post(path, { data });
    expect(r.status(), `${path} ${await r.text()}`).toBe(want);
    return r.json() as Promise<T>;
  };
  const status = async (who: Who, path: string, data: unknown) =>
    (await who.api.post(path, { data })).status();
  const owner = await account("FinOwner");
  const parent1 = await account("FinParent1");
  const parent2 = await account("FinParent2");
  const academy = await call<{ id: string }>(
    owner,
    "/api/workspaces",
    {
      name: "Finance Check Academy",
      contactEmail: "fin@example.test",
      country: "IN",
      language: "en",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      modules: ["development", "reports", "communication", "fees"],
      demo: false,
    },
    201,
  );
  const root = `/api/workspaces/${academy.id}`;
  const player = async (name: string) =>
    (
      await call<{ id: string }>(
        owner,
        `${root}/records/player`,
        { name, birthDate: "2015-05-05", squad: "U12", coachId: owner.id },
        201,
      )
    ).id;
  const p1 = await player("Fictional Fin One"),
    p2 = await player("Fictional Fin Two");
  const branch = (
    await call<{ id: string }>(
      owner,
      `${root}/records/branch`,
      { name: "Fin Branch", timezone: "Asia/Kolkata" },
      201,
    )
  ).id;
  const batch = (
    await call<{ id: string }>(owner, `${root}/training`, {
      requestId: crypto.randomUUID(),
      action: "squad",
      data: { name: "Fin Batch", branchId: branch, playerIds: [p1, p2] },
    })
  ).id;
  for (const [who, pid] of [
    [parent1, p1],
    [parent2, p2],
  ] as const) {
    const invite = await call<{ token: string }>(owner, `${root}/actions`, {
      action: "invite",
      data: {
        email: who.email,
        role: "PARENT",
        playerIds: [pid],
        guardianVerified: true,
      },
    });
    await call(who, "/api/invitations/accept", { token: invite.token });
  }
  const fin = (action: string, data: unknown, extra: object = {}) => ({
    requestId: crypto.randomUUID(),
    action,
    data,
    ...extra,
  });
  type Money = { id: string; version: number; status?: string };

  // ---- fee plans ------------------------------------------------------------
  const plan = await call<Money & { amountMinor: number }>(
    owner,
    `${root}/finance`,
    fin("plan", {
      name: "Monthly football",
      amountMinor: 333333,
      currency: "INR",
      billingFrequency: "MONTHLY",
      applicableStartDate: "2026-10-01",
      active: true,
    }),
  );
  expect(plan.amountMinor).toBe(333333);
  for (const bad of [
    { amountMinor: 0, billingFrequency: "MONTHLY" },
    { amountMinor: -5, billingFrequency: "MONTHLY" },
    { amountMinor: 1.5, billingFrequency: "MONTHLY" },
    { amountMinor: 100, billingFrequency: "FREE" },
    { amountMinor: 100, billingFrequency: "FORTNIGHTLY" },
    { amountMinor: 100, billingFrequency: "CUSTOM" },
  ])
    expect(
      await status(
        owner,
        `${root}/finance`,
        fin("plan", {
          name: "Bad",
          currency: "INR",
          applicableStartDate: "2026-10-01",
          active: true,
          ...bad,
        }),
      ),
      JSON.stringify(bad),
    ).toBe(400);
  expect(
    await status(
      owner,
      `${root}/finance`,
      fin(
        "plan",
        {
          name: "Monthly football",
          amountMinor: 333333,
          currency: "USD",
          billingFrequency: "MONTHLY",
          applicableStartDate: "2026-10-01",
          active: true,
        },
        { id: plan.id, expectedVersion: plan.version },
      ),
    ),
    "a plan cannot change currency",
  ).toBe(400);
  // plan -> batch assignment -> suggestion -> invoice, using the applicable amount
  await call(
    owner,
    `${root}/finance`,
    fin("batchAssignment", {
      squadId: batch,
      planId: plan.id,
      effectiveFrom: "2026-10-01",
      active: true,
    }),
  );
  const suggestions = (
    (await (await owner.api.get(`${root}/finance`)).json()) as {
      invoiceSuggestions: {
        playerId: string;
        available: boolean;
        chargeMinor?: number;
        periodStart?: string;
        periodEnd?: string;
        planVersion?: number;
        assignmentId?: string;
        assignmentVersion?: number;
        planId?: string;
      }[];
    }
  ).invoiceSuggestions;
  const suggestion = suggestions.find((s) => s.playerId === p1 && s.available)!;
  expect(suggestion, "a monthly suggestion for player one").toBeTruthy();
  expect(suggestion.chargeMinor).toBe(333333);
  expect(suggestion.periodEnd! > suggestion.periodStart!).toBe(true);

  // ---- invoices, payments, adjustments --------------------------------------
  const invoice = (
    playerId: string,
    chargeMinor: number,
    label: string,
    extra: object = {},
  ) =>
    call<Money>(
      owner,
      `${root}/finance`,
      fin("invoice", {
        playerId,
        label,
        chargeMinor,
        currency: "INR",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        dueDate: "2026-10-20",
        ...extra,
      }),
    );
  const pay = (invoiceId: string, amountMinor: number, reference: string) =>
    call<Money>(
      owner,
      `${root}/finance`,
      fin("reference", {
        invoiceId,
        amountMinor,
        currency: "INR",
        reference,
        method: "BANK_TRANSFER",
        paidOn: "2026-10-15",
      }),
    );
  const decide = (action: "verify" | "reject", payment: Money) =>
    call<Money>(
      owner,
      `${root}/finance`,
      fin(
        action,
        { reviewed: true, note: "Matched against the synthetic bank record." },
        { id: payment.id, expectedVersion: payment.version },
      ),
    );
  const adjust = (
    invoiceId: string,
    version: number,
    direction: "CREDIT" | "DEBIT",
    amountMinor: number,
  ) =>
    status(
      owner,
      `${root}/finance`,
      fin(
        "adjustment",
        {
          invoiceId,
          direction,
          amountMinor,
          currency: "INR",
          reason: "Reviewed by the academy owner",
          reviewed: true,
        },
        { expectedVersion: version },
      ),
    );
  const view = async (who: Who) =>
    (await (await who.api.get(`${root}/finance`)).json()) as {
      invoices: {
        id: string;
        playerId: string;
        chargeMinor: number;
        billedMinor: number;
        paidMinor: number;
        outstandingMinor: number;
        adjustmentMinor: number;
        pendingReferenceMinor: number;
        status: string;
        version: number;
      }[];
      receipts: { id: string; invoiceId: string; paymentId: string }[];
      payments: {
        id: string;
        status: string;
        amountMinor: number;
        invoiceId: string;
      }[];
      summary: {
        currency: string;
        billedMinor: number;
        collectedMinor: number;
        outstandingMinor: number;
        overdueMinor: number;
        invoiceCount: number;
        paidInvoiceCount: number;
      }[];
    };
  const current = async (id: string) =>
    (await view(owner)).invoices.find((i) => i.id === id)!;

  // A: ₹12,345.67, part paid, a duplicate and an overpayment refused
  const a = await invoice(p1, 1234567, "October football");
  const aPay1 = await pay(a.id, 500000, "FIN-BANK-001");
  let now = await current(a.id);
  expect(now).toMatchObject({
    billedMinor: 1234567,
    paidMinor: 0,
    outstandingMinor: 1234567,
    pendingReferenceMinor: 500000,
  });
  await decide("verify", aPay1);
  now = await current(a.id);
  expect(now).toMatchObject({
    paidMinor: 500000,
    outstandingMinor: 734567,
    status: "PARTIAL",
    pendingReferenceMinor: 0,
  });
  // the same reference, however it is typed, is recorded once
  for (const dup of ["FIN-BANK-001", " fin-bank-001 ", "Fin-Bank-001"])
    expect(
      await status(
        owner,
        `${root}/finance`,
        fin("reference", {
          invoiceId: a.id,
          amountMinor: 1000,
          currency: "INR",
          reference: dup,
          method: "CASH",
          paidOn: "2026-10-16",
        }),
      ),
      dup,
    ).toBe(409);
  // a retry of the very same request returns the same payment and records nothing new
  const retryKey = crypto.randomUUID();
  const retryBody = {
    requestId: retryKey,
    action: "reference",
    data: {
      invoiceId: a.id,
      amountMinor: 100000,
      currency: "INR",
      reference: "FIN-BANK-RETRY",
      method: "CASH",
      paidOn: "2026-10-16",
    },
  };
  const first = await call<Money>(owner, `${root}/finance`, retryBody);
  const second = await call<Money>(owner, `${root}/finance`, retryBody);
  expect(second.id).toBe(first.id);
  expect(
    await status(owner, `${root}/finance`, {
      ...retryBody,
      data: { ...retryBody.data, amountMinor: 1 },
    }),
    "key reused with other content",
  ).toBe(409);
  await decide("reject", first);
  expect(
    (await current(a.id)).paidMinor,
    "a rejected payment never counts",
  ).toBe(500000);
  // more than the balance: refused (as a reference or when verified)
  const tooMuch = await status(
    owner,
    `${root}/finance`,
    fin("reference", {
      invoiceId: a.id,
      amountMinor: 734568,
      currency: "INR",
      reference: "FIN-BANK-OVER",
      method: "CASH",
      paidOn: "2026-10-17",
    }),
  );
  expect([400, 409]).toContain(tooMuch);
  expect((await current(a.id)).paidMinor).toBe(500000);
  const aPay2 = await pay(a.id, 734567, "FIN-BANK-002");
  await decide("verify", aPay2);
  now = await current(a.id);
  expect(now).toMatchObject({
    paidMinor: 1234567,
    outstandingMinor: 0,
    status: "PAID",
  });
  expect(
    await status(
      owner,
      `${root}/finance`,
      fin("reference", {
        invoiceId: a.id,
        amountMinor: 1,
        currency: "INR",
        reference: "FIN-BANK-AFTER",
        method: "CASH",
        paidOn: "2026-10-18",
      }),
    ),
    "a paid invoice takes no more payments",
  ).toBe(400);
  expect(
    await status(
      owner,
      `${root}/finance`,
      fin(
        "verify",
        { reviewed: true, note: "Again, to see what happens." },
        { id: aPay2.id, expectedVersion: aPay2.version },
      ),
    ),
    "a decided payment is final",
  ).toBeGreaterThanOrEqual(400);

  // B: a discount (credit) cannot exceed the balance, then the reduced amount is paid
  const b = await invoice(p1, 250000, "Discounted month");
  expect(
    await adjust(b.id, b.version, "CREDIT", 250001),
    "credit above the balance",
  ).toBe(400);
  expect(
    await adjust(b.id, (await current(b.id)).version, "CREDIT", 50000),
  ).toBe(200);
  now = await current(b.id);
  expect(now).toMatchObject({
    adjustmentMinor: -50000,
    billedMinor: 200000,
    outstandingMinor: 200000,
  });
  await decide("verify", await pay(b.id, 200000, "FIN-BANK-B"));
  expect(await current(b.id)).toMatchObject({
    outstandingMinor: 0,
    status: "PAID",
  });

  // C: a full waiver is not payable
  const c = await invoice(p1, 80000, "Waived month");
  expect(await adjust(c.id, c.version, "CREDIT", 80000)).toBe(200);
  expect(await current(c.id)).toMatchObject({
    billedMinor: 0,
    outstandingMinor: 0,
    status: "WAIVED",
  });
  expect(
    await status(
      owner,
      `${root}/finance`,
      fin("reference", {
        invoiceId: c.id,
        amountMinor: 1,
        currency: "INR",
        reference: "FIN-BANK-C",
        method: "CASH",
        paidOn: "2026-10-18",
      }),
    ),
  ).toBe(400);

  // D: odd minor units: a debit, then three equal part-payments leave exactly 1
  const d = await invoice(p2, 99999, "Odd amount");
  expect(await adjust(d.id, d.version, "DEBIT", 1)).toBe(200);
  expect(await current(d.id)).toMatchObject({
    billedMinor: 100000,
    outstandingMinor: 100000,
    status: "OVERDUE",
  });
  for (const [i, amount] of [33333, 33333, 33333].entries())
    await decide("verify", await pay(d.id, amount, `FIN-BANK-D${i}`));
  expect(await current(d.id)).toMatchObject({
    paidMinor: 99999,
    outstandingMinor: 1,
    status: "PARTIAL",
  });
  await decide("verify", await pay(d.id, 1, "FIN-BANK-D-LAST"));
  expect(await current(d.id)).toMatchObject({
    outstandingMinor: 0,
    status: "PAID",
  });

  // E: free and scholarship invoices carry no charge, and an unpaid one is overdue then pending by date
  const free = await invoice(p2, 0, "Scholarship month", {
    zeroChargeReason: "SCHOLARSHIP",
    confirmed: true,
  });
  expect(["FREE", "WAIVED"]).toContain((await current(free.id)).status);
  expect(
    await status(
      owner,
      `${root}/finance`,
      fin("invoice", {
        playerId: p2,
        label: "No reason",
        chargeMinor: 0,
        currency: "INR",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        dueDate: "2026-10-20",
      }),
    ),
  ).toBe(400);
  const future = await invoice(p2, 120000, "Next month", {
    periodStart: "2026-12-01",
    periodEnd: "2026-12-31",
    dueDate: "2026-12-10",
  });
  expect(await current(future.id)).toMatchObject({
    outstandingMinor: 120000,
    status: "PENDING",
  });
  for (const bad of [
    { chargeMinor: -1 },
    { chargeMinor: 1.5 },
    { currency: "ZZZ" },
    { periodEnd: "2026-09-01" },
    { dueDate: "tomorrow" },
  ])
    expect(
      await status(
        owner,
        `${root}/finance`,
        fin("invoice", {
          playerId: p2,
          label: "Bad",
          chargeMinor: 100,
          currency: "INR",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          dueDate: "2026-10-20",
          ...bad,
        }),
      ),
      JSON.stringify(bad),
    ).toBe(400);

  // ---- the independent calculation, straight from the stored rows -----------
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!, {
    readOnly: true,
  });
  const rows = (kind: string) =>
    (
      db
        .prepare(
          "SELECT body FROM academy_finance_records WHERE academyId=? AND kind=?",
        )
        .all(academy.id, kind) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  const invoices = rows("invoice") as {
      id: string;
      chargeMinor: number;
      playerId: string;
    }[],
    adjustments = rows("adjustment") as {
      invoiceId: string;
      direction: string;
      amountMinor: number;
    }[],
    payments = rows("payment") as {
      invoiceId: string;
      status: string;
      amountMinor: number;
    }[];
  const oracle = invoices.map((inv) => {
    const adj = adjustments
      .filter((x) => x.invoiceId === inv.id)
      .reduce(
        (s, x) =>
          s + (x.direction === "CREDIT" ? -x.amountMinor : x.amountMinor),
        0,
      );
    const billed = inv.chargeMinor + adj;
    const paid = payments
      .filter((x) => x.invoiceId === inv.id && x.status === "VERIFIED")
      .reduce((s, x) => s + x.amountMinor, 0);
    return {
      id: inv.id,
      playerId: inv.playerId,
      billed,
      paid,
      outstanding: billed - paid,
    };
  });
  const verifiedCount = payments.filter((p) => p.status === "VERIFIED").length;
  db.close();
  const ownerView = await view(owner);
  expect(ownerView.invoices).toHaveLength(oracle.length);
  for (const o of oracle) {
    const api = ownerView.invoices.find((i) => i.id === o.id)!;
    expect(
      [api.billedMinor, api.paidMinor, api.outstandingMinor],
      o.id,
    ).toEqual([o.billed, o.paid, o.outstanding]);
    expect(Number.isInteger(api.billedMinor) && api.outstandingMinor >= 0).toBe(
      true,
    );
  }
  const totals = oracle.reduce(
    (s, o) => ({
      billed: s.billed + o.billed,
      paid: s.paid + o.paid,
      outstanding: s.outstanding + o.outstanding,
    }),
    { billed: 0, paid: 0, outstanding: 0 },
  );
  expect(ownerView.summary).toHaveLength(1);
  expect(ownerView.summary[0]).toMatchObject({
    currency: "INR",
    billedMinor: totals.billed,
    collectedMinor: totals.paid,
    outstandingMinor: totals.outstanding,
    invoiceCount: oracle.length,
  });
  expect(totals.paid).toBe(1234567 + 200000 + 99999 + 1);
  expect(ownerView.receipts, "one receipt per verified payment").toHaveLength(
    verifiedCount,
  );
  expect(new Set(ownerView.receipts.map((r) => r.paymentId)).size).toBe(
    verifiedCount,
  );

  // ---- a guardian sees the same numbers for their own child, and nothing else ----
  for (const [who, pid] of [
    [parent1, p1],
    [parent2, p2],
  ] as const) {
    const mine = await view(who);
    const expected = oracle.filter((o) => o.playerId === pid);
    expect(mine.invoices.map((i) => i.id).sort()).toEqual(
      expected.map((o) => o.id).sort(),
    );
    for (const o of expected) {
      const api = mine.invoices.find((i) => i.id === o.id)!;
      expect([api.billedMinor, api.paidMinor, api.outstandingMinor]).toEqual([
        o.billed,
        o.paid,
        o.outstanding,
      ]);
    }
    expect(mine.summary[0].billedMinor).toBe(
      expected.reduce((s, o) => s + o.billed, 0),
    );
    expect(mine.summary[0].outstandingMinor).toBe(
      expected.reduce((s, o) => s + o.outstanding, 0),
    );
  }

  // ---- documents: every invoice and receipt renders as a real PDF -------------
  for (const inv of ownerView.invoices) {
    const r = await owner.api.get(`${root}/finance/invoice/${inv.id}/pdf`);
    expect(r.status(), inv.id).toBe(200);
    expect(r.headers()["content-type"]).toBe("application/pdf");
    const body = await r.body();
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      (await PDFDocument.load(body)).getPageCount(),
    ).toBeGreaterThanOrEqual(1);
  }
  for (const receipt of ownerView.receipts) {
    const r = await owner.api.get(`${root}/finance/receipt/${receipt.id}/pdf`);
    expect(r.status(), receipt.id).toBe(200);
    expect((await r.body()).subarray(0, 5).toString()).toBe("%PDF-");
  }
  // A guardian may download their own child's documents and nobody else's.
  const ownReceipt = ownerView.receipts.find(
    (r) =>
      ownerView.invoices.find((i) => i.id === r.invoiceId)!.playerId === p1,
  )!;
  expect(
    (
      await parent1.api.get(`${root}/finance/receipt/${ownReceipt.id}/pdf`)
    ).status(),
  ).toBe(200);
  expect(
    (
      await parent2.api.get(`${root}/finance/receipt/${ownReceipt.id}/pdf`)
    ).status(),
  ).toBeGreaterThanOrEqual(403);
  expect(
    (await parent2.api.get(`${root}/finance/invoice/${a.id}/pdf`)).status(),
  ).toBeGreaterThanOrEqual(403);
  for (const who of [owner, parent1, parent2]) await who.api.dispose();
  await new Promise((resolve) => setTimeout(resolve, 11000));
});
