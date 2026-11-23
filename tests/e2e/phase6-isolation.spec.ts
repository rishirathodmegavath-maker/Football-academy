import { test, expect, type APIRequestContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
// Phase 6: black-box tenancy and authorization checks against the real server,
// real sessions and two independent academies. The UI hides things; this spec
// does not trust that: it calls the APIs directly with the wrong credentials,
// the wrong academy, tampered identifiers and forged origins, and then reads
// the victim's data back to prove nothing changed.
test.use({ actionTimeout: 15000 });
test("academy isolation and role authorization hold at the API", async ({
  playwright,
}) => {
  test.setTimeout(420000);
  // Sign-up is limited per address (3 per 10 s) for the whole run: let the previous spec's window clear,
  // and leave a clear window for the next one (see the end of this test).
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8);
  type Who = { api: APIRequestContext; email: string; id: string };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 11000));
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
  const post = async <T>(who: Who, path: string, data: unknown, want = 200) => {
    const r = await who.api.post(path, { data });
    expect(r.status(), `${path} ${await r.text()}`).toBe(want);
    return r.json() as Promise<T>;
  };
  const code = async (p: Promise<{ status(): number }>) => (await p).status();
  // Sign-up is limited to 3 per 10 s per address.
  const ownerA = await account("IsoOwnerA");
  const coach1 = await account("IsoCoachA1");
  const coach2 = await account("IsoCoachA2");
  await wait();
  const parentA1 = await account("IsoParentA1");
  const parentA2 = await account("IsoParentA2");
  const ownerB = await account("IsoOwnerB");
  await wait();
  const parentB = await account("IsoParentB");
  const stranger = await account("IsoStranger");
  const admin = await account("IsoPlatformAdmin");

  const academyBody = (name: string) => ({
    name,
    contactEmail: "iso@example.test",
    country: "IN",
    language: "en",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    modules: ["development", "reports", "communication", "fees"],
    demo: false,
  });
  const A = (
    await post<{ id: string }>(
      ownerA,
      "/api/workspaces",
      academyBody("Iso Academy A"),
      201,
    )
  ).id;
  const B = (
    await post<{ id: string }>(
      ownerB,
      "/api/workspaces",
      academyBody("Iso Academy B"),
      201,
    )
  ).id;
  const ra = `/api/workspaces/${A}`,
    rb = `/api/workspaces/${B}`;
  const invite = (
    owner: Who,
    root: string,
    email: string,
    role: string,
    playerIds?: string[],
  ) =>
    post<{ token: string }>(owner, `${root}/actions`, {
      action: "invite",
      data: {
        email,
        role,
        ...(playerIds ? { playerIds, guardianVerified: true } : {}),
      },
    });
  for (const who of [coach1, coach2])
    await post(who, "/api/invitations/accept", {
      token: (await invite(ownerA, ra, who.email, "COACH")).token,
    });
  const player = async (
    owner: Who,
    root: string,
    name: string,
    coachId: string,
  ) =>
    (
      await post<{ id: string }>(
        owner,
        `${root}/records/player`,
        { name, birthDate: "2015-05-05", squad: "U12", coachId },
        201,
      )
    ).id;
  const p1 = await player(ownerA, ra, "Fictional Iso One", coach1.id),
    p2 = await player(ownerA, ra, "Fictional Iso Two", coach2.id),
    p3 = await player(ownerA, ra, "Fictional Iso Three", coach1.id),
    b1 = await player(ownerB, rb, "Fictional Iso Bravo", ownerB.id);
  const branchA = (
      await post<{ id: string }>(
        ownerA,
        `${ra}/records/branch`,
        { name: "A Branch", timezone: "Asia/Kolkata" },
        201,
      )
    ).id,
    branchB = (
      await post<{ id: string }>(
        ownerB,
        `${rb}/records/branch`,
        { name: "B Branch", timezone: "Asia/Kolkata" },
        201,
      )
    ).id;
  const batch = async (
    owner: Who,
    root: string,
    branchId: string,
    name: string,
    playerIds: string[],
  ) =>
    (
      await post<{ id: string }>(owner, `${root}/training`, {
        requestId: crypto.randomUUID(),
        action: "squad",
        data: { name, branchId, playerIds },
      })
    ).id;
  const batchX = await batch(ownerA, ra, branchA, "Batch X", [p1, p3]),
    batchY = await batch(ownerA, ra, branchA, "Batch Y", [p2]),
    batchB = await batch(ownerB, rb, branchB, "Batch B", [b1]);
  await post(parentA1, "/api/invitations/accept", {
    token: (await invite(ownerA, ra, parentA1.email, "PARENT", [p1])).token,
  });
  await post(parentA2, "/api/invitations/accept", {
    token: (await invite(ownerA, ra, parentA2.email, "PARENT", [p2])).token,
  });
  await post(parentB, "/api/invitations/accept", {
    token: (await invite(ownerB, rb, parentB.email, "PARENT", [b1])).token,
  });
  const invoice = async (
    owner: Who,
    root: string,
    playerId: string,
    chargeMinor: number,
  ) =>
    post<{ id: string }>(owner, `${root}/finance`, {
      requestId: crypto.randomUUID(),
      action: "invoice",
      data: {
        playerId,
        label: "Iso monthly",
        chargeMinor,
        currency: "INR",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        dueDate: "2026-10-20",
      },
    });
  const invA1 = await invoice(ownerA, ra, p1, 100000),
    invA2 = await invoice(ownerA, ra, p2, 250000),
    invB = await invoice(ownerB, rb, b1, 777700);
  const convA1 = await post<{ id: string }>(
    parentA1,
    `${ra}/records/conversation`,
    { playerId: p1, guardianId: parentA1.id, subject: "Question A1" },
    201,
  );
  const convA2 = await post<{ id: string }>(
    parentA2,
    `${ra}/records/conversation`,
    { playerId: p2, guardianId: parentA2.id, subject: "Question A2" },
    201,
  );
  const convB = await post<{ id: string }>(
    parentB,
    `${rb}/records/conversation`,
    { playerId: b1, guardianId: parentB.id, subject: "Question B" },
    201,
  );
  await post(parentA2, `${ra}/actions`, {
    action: "reply",
    id: convA2.id,
    data: { body: "Private A2 text" },
  });
  await post(parentB, `${rb}/actions`, {
    action: "reply",
    id: convB.id,
    data: { body: "Private B text" },
  });

  const names = async (who: Who, root: string, kind = "player") => {
    const body = await (await who.api.get(`${root}/records/${kind}`)).json();
    return (Array.isArray(body) ? body : (body.records ?? [])) as {
      id: string;
      name?: string;
    }[];
  };

  // ---- 1. another academy's owner: every read and write is refused ----------
  const reads = (root: string, pid: string, inv: string) => [
    root,
    `${root}/bootstrap`,
    `${root}/home`,
    `${root}/records/player`,
    `${root}/records/report`,
    `${root}/records/session`,
    `${root}/records/conversation`,
    `${root}/records/player/${pid}`,
    `${root}/finance`,
    `${root}/finance/invoice/${inv}/pdf`,
    `${root}/communication`,
    `${root}/communication/announcements`,
    `${root}/announcements`,
    `${root}/player-messages?player=${pid}`,
    `${root}/trials`,
    `${root}/training`,
  ];
  for (const path of reads(rb, b1, invB.id))
    expect(await code(ownerA.api.get(path)), `ownerA reads ${path}`).toBe(403);
  for (const path of reads(ra, p1, invA1.id))
    expect(await code(ownerB.api.get(path)), `ownerB reads ${path}`).toBe(403);
  for (const path of reads(ra, p1, invA1.id))
    expect(await code(stranger.api.get(path)), `stranger reads ${path}`).toBe(
      403,
    );
  for (const [path, data] of [
    [
      `${rb}/records/player`,
      { birthDate: "2015-05-05", name: "Intruder", squad: "U12", coachId: ownerA.id },
    ],
    [
      `${rb}/finance`,
      {
        requestId: crypto.randomUUID(),
        action: "invoice",
        data: {
          playerId: b1,
          label: "x",
          chargeMinor: 1,
          currency: "INR",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          dueDate: "2026-10-20",
        },
      },
    ],
    [
      `${rb}/actions`,
      {
        action: "invite",
        data: { email: "intruder@example.test", role: "COACH" },
      },
    ],
    [
      `${rb}/communication/announcements`,
      {
        requestId: crypto.randomUUID(),
        action: "save",
        data: {},
        expectedVersion: 0,
      },
    ],
    [
      `${rb}/training`,
      {
        requestId: crypto.randomUUID(),
        action: "squad",
        data: { name: "Intruder", branchId: branchB, playerIds: [b1] },
      },
    ],
  ] as const)
    expect(
      await code(ownerA.api.post(path, { data })),
      `ownerA writes ${path}`,
    ).toBe(403);
  expect(
    await code(ownerA.api.patch(rb, { data: { name: "Hijacked" } })),
    "ownerA patches B",
  ).toBe(403);
  // ...and the victim's data is exactly as it was.
  expect((await names(ownerB, rb)).map((p) => p.name)).toEqual([
    "Fictional Iso Bravo",
  ]);
  const bFinance = await (await ownerB.api.get(`${rb}/finance`)).json();
  expect(bFinance.invoices).toHaveLength(1);
  expect(bFinance.invoices[0].chargeMinor).toBe(777700);
  expect(bFinance.invoices[0].paidMinor).toBe(0);

  // ---- 2. identifiers from another academy, used inside one's own academy ----
  expect([403, 404]).toContain(
    await code(ownerA.api.get(`${ra}/records/player/${b1}`)),
  );
  expect([403, 404, 409, 400]).toContain(
    await code(
      ownerA.api.put(`${ra}/records/player/${b1}`, {
        data: { name: "Renamed", squad: "U12", coachId: ownerA.id },
      }),
    ),
  );
  expect([403, 404, 400]).toContain(
    await code(
      ownerA.api.post(`${ra}/finance`, {
        data: {
          requestId: crypto.randomUUID(),
          action: "reference",
          data: {
            invoiceId: invB.id,
            amountMinor: 777700,
            currency: "INR",
            reference: "ISO-CROSS",
            method: "CASH",
            paidOn: "2026-10-15",
          },
        },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(ownerA.api.get(`${ra}/finance/invoice/${invB.id}/pdf`)),
  );
  expect([403, 404, 400]).toContain(
    await code(
      ownerA.api.post(`${ra}/communication/announcements`, {
        data: {
          requestId: crypto.randomUUID(),
          action: "save",
          expectedVersion: 0,
          data: {
            kind: "OPERATIONAL",
            urgency: "NORMAL",
            batchIds: [batchB],
            body: "Cross academy batch",
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        },
      }),
    ),
  );
  expect((await names(ownerB, rb)).map((p) => p.name)).toEqual([
    "Fictional Iso Bravo",
  ]);
  expect(
    (await (await ownerB.api.get(`${rb}/finance`)).json()).invoices[0]
      .paidMinor,
  ).toBe(0);

  // ---- 3. coaches see and change only their own batches ----------------------
  expect((await names(coach2, ra)).map((p) => p.id).sort()).toEqual([p2]);
  expect((await names(coach1, ra)).map((p) => p.id).sort()).toEqual(
    [p1, p3].sort(),
  );
  expect([403, 404]).toContain(
    await code(coach2.api.get(`${ra}/records/player/${p1}`)),
  );
  expect([403, 404]).toContain(
    await code(
      coach2.api.put(`${ra}/records/player/${p1}`, {
        data: { name: "Coach edit", squad: "U12", coachId: coach2.id },
      }),
    ),
  );
  expect((await names(ownerA, ra)).find((p) => p.id === p1)!.name).toBe(
    "Fictional Iso One",
  );
  const draft = (batchIds: string[]) => ({
    requestId: crypto.randomUUID(),
    action: "save",
    expectedVersion: 0,
    data: {
      kind: "OPERATIONAL",
      urgency: "NORMAL",
      batchIds,
      body: "Generic practice reminder for the batch.",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  expect(
    await code(
      coach2.api.post(`${ra}/communication/announcements`, {
        data: draft([batchX]),
      }),
    ),
    "coach2 uses batch X",
  ).toBe(403);
  expect(
    await code(
      coach1.api.post(`${ra}/communication/announcements`, {
        data: draft([batchX]),
      }),
    ),
    "coach1 uses own batch",
  ).toBe(200);
  expect(
    await code(
      coach1.api.post(`${ra}/communication/announcements`, {
        data: draft([batchX, batchY]),
      }),
    ),
    "coach1 adds batch Y",
  ).toBe(403);
  for (const path of [`${ra}/finance`])
    expect(await code(coach1.api.get(path)), `coach reads ${path}`).toBe(403);
  expect(
    await code(
      coach1.api.post(`${ra}/actions`, {
        data: {
          action: "invite",
          data: { email: "x@example.test", role: "COACH" },
        },
      }),
    ),
  ).toBe(403);
  expect(
    await code(coach1.api.patch(ra, { data: { name: "Coach rename" } })),
  ).toBe(403);
  expect(
    await code(
      coach1.api.post(`${ra}/finance`, {
        data: {
          requestId: crypto.randomUUID(),
          action: "invoice",
          data: {
            playerId: p1,
            label: "x",
            chargeMinor: 1,
            currency: "INR",
            periodStart: "2026-10-01",
            periodEnd: "2026-10-31",
            dueDate: "2026-10-20",
          },
        },
      }),
    ),
  ).toBe(403);

  // ---- 4. parents see only their own children --------------------------------
  expect((await names(parentA1, ra)).map((p) => p.id)).toEqual([p1]);
  expect((await names(parentA2, ra)).map((p) => p.id)).toEqual([p2]);
  expect([403, 404]).toContain(
    await code(parentA1.api.get(`${ra}/records/player/${p2}`)),
  );
  const fin1 = await (await parentA1.api.get(`${ra}/finance`)).json();
  expect(fin1.invoices.map((i: { id: string }) => i.id)).toEqual([invA1.id]);
  expect(JSON.stringify(fin1)).not.toContain(String(invA2.id));
  expect([403, 404]).toContain(
    await code(parentA1.api.get(`${ra}/finance?player=${p2}`)),
  );
  expect(
    (await parentA1.api.get(`${ra}/finance/invoice/${invA1.id}/pdf`)).status(),
  ).toBe(200);
  expect([403, 404]).toContain(
    await code(parentA1.api.get(`${ra}/finance/invoice/${invA2.id}/pdf`)),
  );
  expect([403, 404]).toContain(
    await code(parentB.api.get(`${ra}/finance/invoice/${invA1.id}/pdf`)),
  );
  for (const [path, data] of [
    [
      `${ra}/finance`,
      {
        requestId: crypto.randomUUID(),
        action: "invoice",
        data: {
          playerId: p1,
          label: "x",
          chargeMinor: 1,
          currency: "INR",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          dueDate: "2026-10-20",
        },
      },
    ],
    [
      `${ra}/records/player`,
      { birthDate: "2015-05-05", name: "Parent created", squad: "U12", coachId: parentA1.id },
    ],
    [
      `${ra}/actions`,
      { action: "invite", data: { email: "p@example.test", role: "COACH" } },
    ],
    [`${ra}/communication/announcements`, draft([batchX])],
    [
      `${ra}/training`,
      {
        requestId: crypto.randomUUID(),
        action: "squad",
        data: { name: "P", branchId: branchA, playerIds: [p1] },
      },
    ],
  ] as const)
    expect(
      await code(parentA1.api.post(path, { data })),
      `parent writes ${path} ${JSON.stringify((data as { action?: string }).action)}`,
    ).toBe(403);
  expect(
    await code(parentA1.api.get(`${ra}/communication/announcements`)),
    "parent reads staff announcements",
  ).toBe(403);
  expect(
    await code(parentA1.api.patch(ra, { data: { name: "Parent rename" } })),
  ).toBe(403);
  // P1-09: the one finance write a parent has is REPORTING a payment reference
  // for their own child's invoice. It stays pending, so nothing is credited
  // (checked below); another family's parent and an outsider cannot reach it.
  const referenceFor = (reference: string) => ({
    requestId: crypto.randomUUID(),
    action: "reference",
    data: {
      invoiceId: invA1.id,
      amountMinor: 100000,
      currency: "INR",
      reference,
      method: "CASH",
      paidOn: "2026-10-15",
    },
  });
  expect(
    await code(parentA2.api.post(`${ra}/finance`, { data: referenceFor("OTHER-FAMILY") })),
  ).toBe(404);
  expect(
    await code(parentB.api.post(`${ra}/finance`, { data: referenceFor("OTHER-ACADEMY") })),
  ).toBe(403);
  const reported = await parentA1.api.post(`${ra}/finance`, {
    data: referenceFor("PARENT-REPORTED"),
  });
  expect(reported.status()).toBe(200);
  expect((await reported.json()).status).toBe("PENDING");
  expect(
    (await (await ownerA.api.get(`${ra}/finance`)).json()).invoices.find(
      (i: { id: string }) => i.id === invA1.id,
    ).paidMinor,
  ).toBe(0);

  // ---- 5. private messages never cross a family or an academy ----------------
  expect([403, 404]).toContain(
    await code(parentA1.api.get(`${ra}/records/conversation/${convA2.id}`)),
  );
  expect(
    JSON.stringify(
      await (await parentA1.api.get(`${ra}/records/conversation`)).json(),
    ),
  ).not.toContain("Private A2 text");
  expect([403, 404]).toContain(
    await code(
      parentA1.api.post(`${ra}/actions`, {
        data: { action: "reply", id: convA2.id, data: { body: "Intrusion" } },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(
      parentB.api.post(`${rb}/actions`, {
        data: { action: "reply", id: convA2.id, data: { body: "Intrusion" } },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(
      parentB.api.post(`${ra}/actions`, {
        data: { action: "reply", id: convA2.id, data: { body: "Intrusion" } },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(
      parentA1.api.post(`${rb}/actions`, {
        data: { action: "reply", id: convB.id, data: { body: "Intrusion" } },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(
      parentA1.api.post(`${ra}/records/conversation`, {
        data: {
          playerId: p2,
          guardianId: parentA1.id,
          subject: "About another child",
        },
      }),
    ),
  );
  expect([403, 404]).toContain(
    await code(
      parentA1.api.post(`${ra}/records/conversation`, {
        data: {
          playerId: p1,
          guardianId: parentA2.id,
          subject: "As another guardian",
        },
      }),
    ),
  );
  const convoText = JSON.stringify(
    await (await ownerA.api.get(`${ra}/records/conversation`)).json(),
  );
  expect(convoText).toContain("Private A2 text");
  expect(convoText).not.toContain("Intrusion");
  expect(
    JSON.stringify(
      await (await ownerB.api.get(`${rb}/records/conversation`)).json(),
    ),
  ).not.toContain("Intrusion");
  expect(convoText).not.toContain("Private B text");

  // ---- 6. an announcement reaches only its intended guardians -----------------
  const announced = draft([batchX]);
  const saved = await post<{ id: string; version: number }>(
    ownerA,
    `${ra}/communication/announcements`,
    announced,
  );
  const submitted = await post<{ id: string; version: number }>(
    ownerA,
    `${ra}/communication/announcements`,
    {
      requestId: crypto.randomUUID(),
      action: "submit",
      id: saved.id,
      expectedVersion: saved.version,
      data: {},
    },
  );
  const preview = await post<{ fingerprint: string; inAppCount: number }>(
    ownerA,
    `${ra}/communication/announcements`,
    {
      requestId: crypto.randomUUID(),
      action: "preview",
      data: announced.data,
    },
  );
  expect(preview.inAppCount).toBe(1);
  // The coach holds the current version and the right preview, and is still refused.
  expect(
    await code(
      coach1.api.post(`${ra}/communication/announcements`, {
        data: {
          requestId: crypto.randomUUID(),
          action: "approve",
          id: saved.id,
          expectedVersion: submitted.version,
          data: {
            verified: true,
            genericPrivacyConfirmed: true,
            fingerprint: preview.fingerprint,
          },
        },
      }),
    ),
    "coach cannot approve",
  ).toBe(403);
  await post(ownerA, `${ra}/communication/announcements`, {
    requestId: crypto.randomUUID(),
    action: "approve",
    id: submitted.id,
    expectedVersion: submitted.version,
    data: {
      verified: true,
      genericPrivacyConfirmed: true,
      fingerprint: preview.fingerprint,
    },
  });
  const seen = async (who: Who, root: string) =>
    (
      (await (await who.api.get(`${root}/announcements`)).json()) as {
        announcements: { id: string }[];
      }
    ).announcements;
  expect((await seen(parentA1, ra)).map((a) => a.id)).toEqual([saved.id]);
  expect(await seen(parentA2, ra)).toEqual([]);
  expect(await seen(parentB, rb)).toEqual([]);
  expect(await code(parentB.api.get(`${ra}/announcements`))).toBe(403);
  expect(await code(parentA2.api.get(`${rb}/announcements`))).toBe(403);
  expect(
    await code(ownerA.api.get(`${ra}/announcements`)),
    "staff use the staff route",
  ).toBe(403);

  // ---- 7. the platform role is not an academy role ----------------------------
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!);
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare(
    "INSERT OR IGNORE INTO platform_administrators(userId) VALUES(?)",
  ).run(admin.id);
  db.close();
  for (const who of [ownerA, parentA1, coach1, stranger]) {
    expect(
      await code(who.api.get("/api/platform/accounts")),
      "non-admin lists accounts",
    ).toBe(403);
    expect(
      await code(
        who.api.patch("/api/platform/accounts", {
          data: { academyId: A, status: "PAUSED", tier: "PILOT", modules: [] },
        }),
      ),
    ).toBe(403);
  }
  const listed = await (await admin.api.get("/api/platform/accounts")).json();
  expect((listed as { id: string }[]).map((a) => a.id)).toEqual(
    expect.arrayContaining([A, B]),
  );
  expect(
    await code(admin.api.get(ra)),
    "an administrator holds no academy membership",
  ).toBe(403);
  expect(await code(admin.api.get(`${ra}/records/player`))).toBe(403);
  expect(
    await code(
      admin.api.patch("/api/platform/accounts", {
        data: {
          academyId: A,
          status: "PAUSED",
          tier: "PILOT",
          modules: ["development"],
        },
        headers: { Origin: "https://evil.example" },
      }),
    ),
  ).toBe(403);
  expect(
    await code(
      admin.api.patch("/api/platform/accounts", {
        data: { academyId: A, status: "BANNED" },
      }),
    ),
  ).toBe(400);
  expect(
    await code(
      admin.api.patch("/api/platform/accounts", {
        data: {
          academyId: "no-such-academy",
          status: "PAUSED",
          tier: "PILOT",
          modules: [],
        },
      }),
    ),
  ).toBe(404);
  // Pausing is a suspension: a recorded decision with a written reason (the
  // entitlement route no longer accepts a status change).
  const decide = async (decision: string, reason?: string) => {
    const detail = await (
      await admin.api.get(`/api/platform/applications/${A}`)
    ).json();
    return code(
      admin.api.post(`/api/platform/applications/${A}/decision`, {
        data: { decision, reason, expectedVersion: detail.version },
      }),
    );
  };
  expect(
    await code(
      admin.api.patch("/api/platform/accounts", {
        data: {
          academyId: A,
          status: "PAUSED",
          tier: "PILOT",
          modules: ["development", "reports", "communication", "fees"],
        },
      }),
    ),
    "the entitlement route no longer pauses",
  ).toBe(400);
  expect(await decide("suspend")).toBe(400); // a reason is required
  expect(
    await decide("suspend", "Suspended while the isolation check runs"),
  ).toBe(200);
  for (const who of [ownerA, parentA1, coach1])
    expect(await code(who.api.get(ra)), "paused academy is closed").toBe(403);
  expect(await code(ownerB.api.get(rb)), "other academy unaffected").toBe(200);
  expect(await decide("reactivate", "The isolation check is finished")).toBe(
    200,
  );
  expect(await code(ownerA.api.get(ra))).toBe(200);

  // ---- 8. anonymous callers and forged origins --------------------------------
  const anon = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  for (const path of [
    ...reads(ra, p1, invA1.id),
    "/api/platform/accounts",
    "/api/workspaces",
  ])
    expect(await code(anon.get(path)), `anonymous reads ${path}`).toBe(401);
  expect(await code(anon.post(`${ra}/records/player`, { data: {} }))).toBe(401);
  const before = (await names(ownerA, ra)).length;
  for (const headers of [
    { Origin: "https://evil.example" },
    { Origin: "null" },
  ]) {
    expect(
      await code(
        ownerA.api.post(`${ra}/records/player`, {
          data: { birthDate: "2015-05-05", name: "Forged", squad: "U12", coachId: ownerA.id },
          headers,
        }),
      ),
      JSON.stringify(headers),
    ).toBe(403);
    expect(
      await code(
        parentA1.api.post(`${ra}/actions`, {
          data: { action: "reply", id: convA1.id, data: { body: "Forged" } },
          headers,
        }),
      ),
    ).toBe(403);
  }
  expect((await names(ownerA, ra)).length).toBe(before);

  // ---- 9. invitation tokens belong to their invitee ---------------------------
  const token = (
    await invite(ownerA, ra, `iso-late-${suffix}@example.test`, "PARENT", [p3])
  ).token;
  expect([400, 403, 404, 409]).toContain(
    await code(
      stranger.api.post("/api/invitations/accept", { data: { token } }),
    ),
  );
  expect([400, 403, 404, 409]).toContain(
    await code(ownerB.api.post("/api/invitations/accept", { data: { token } })),
  );
  expect([400, 403, 404, 409]).toContain(
    await code(
      stranger.api.post("/api/invitations/accept", {
        data: { token: "not-a-token" },
      }),
    ),
  );
  expect(await code(parentA1.api.get(`${ra}/records/player/${p3}`))).not.toBe(
    200,
  );

  // ---- 10. errors do not leak internals ---------------------------------------
  for (const r of [
    await ownerA.api.get(`${ra}/records/nonsense`),
    await ownerA.api.post(`${ra}/finance`, { data: { garbage: true } }),
    await parentA1.api.get(`${rb}/finance`),
  ]) {
    const text = await r.text();
    expect(text).not.toMatch(
      /SELECT |sqlite|node_modules|at .*\.(ts|js):\d+|stack/i,
    );
    expect(r.headers()["cache-control"]).toMatch(/no-store/);
  }
  for (const who of [
    ownerA,
    coach1,
    coach2,
    parentA1,
    parentA2,
    ownerB,
    parentB,
    stranger,
    admin,
  ])
    await who.api.dispose();
  await anon.dispose();
  await new Promise((resolve) => setTimeout(resolve, 11000));
});
