import { test, expect, type APIRequestContext } from "@playwright/test";
// Football sprint: the new workflows through the real HTTP API and the real
// screens, in one fictional academy: player lifecycle, batch placement as the
// source of truth, parent payment references, all-day closures, coach hand-over.
// Every person, address and amount here is fictional.
test.use({ actionTimeout: 15000 });
test("lifecycle, placement, parent payment reference, closures and coach hand-over work end to end", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(300000);
  // Sign-up is limited to 3 per 10 s: leave a clear window first.
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8);
  type Who = { api: APIRequestContext; email: string; id: string };
  const pageErrors: string[] = [];
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
  const statusOf = async (who: Who, path: string, data: unknown, method = "POST") =>
    (
      await (method === "PUT"
        ? who.api.put(path, { data })
        : who.api.post(path, { data }))
    ).status();
  const owner = await account("SprintOwner");
  const coach = await account("SprintCoach");
  const parent1 = await account("SprintParent1");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const parent2 = await account("SprintParent2");
  const academy = await call<{ id: string }>(
    owner,
    "/api/workspaces",
    {
      name: "Sprint Check Academy",
      contactEmail: "sprint@example.test",
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
  const invite = async (who: Who, role: string, playerIds: string[] = []) => {
    const made = await call<{ token: string }>(owner, `${root}/actions`, {
      action: "invite",
      data: {
        email: who.email,
        role,
        playerIds,
        guardianVerified: role === "PARENT",
      },
    });
    await call(who, "/api/invitations/accept", { token: made.token });
  };
  await invite(coach, "COACH");
  type Player = { id: string; recordVersion: number; status?: string; squadId?: string; coachId: string };
  const player = async (name: string, coachId: string) =>
    call<Player>(owner, `${root}/records/player`, { name, squad: "", coachId }, 201);
  const p1 = await player("Fictional Sprint One", coach.id);
  const p2 = await player("Fictional Sprint Two", coach.id);
  const p3 = await player("Fictional Sprint Three", owner.id);
  await invite(parent1, "PARENT", [p1.id]);
  await invite(parent2, "PARENT", [p3.id]);
  const branch = await call<{ id: string }>(
    owner,
    `${root}/records/branch`,
    { name: "Sprint Branch", timezone: "Asia/Kolkata" },
    201,
  );
  const train = (action: string, data: unknown, extra: object = {}) => ({
    requestId: crypto.randomUUID(),
    action,
    data,
    ...extra,
  });
  const players = async (who: Who = owner) =>
    (await (await who.api.get(`${root}/records/player`)).json()) as Player[];
  const one = async (id: string) => (await players()).find((p) => p.id === id)!;

  // ---- placement: the roster is applied to the players ----------------------
  const batch = await call<{ id: string }>(
    owner,
    `${root}/training`,
    train("squad", { birthDate: "2015-05-05", name: "Sprint U12", branchId: branch.id, playerIds: [p1.id, p2.id] }),
  );
  expect((await one(p1.id)).squadId).toBe(batch.id);
  expect((await one(p2.id)).squadId).toBe(batch.id);
  const other = await call<{ id: string }>(
    owner,
    `${root}/training`,
    train("squad", { name: "Sprint U14", branchId: branch.id, playerIds: [p2.id] }),
  );
  expect((await one(p2.id)).squadId).toBe(other.id);
  const squads = (await (await owner.api.get(`${root}/records/squad`)).json()) as {
    id: string;
    playerIds: string[];
  }[];
  expect(squads.find((s) => s.id === batch.id)!.playerIds).toEqual([p1.id]);
  expect(squads.find((s) => s.id === other.id)!.playerIds).toEqual([p2.id]);

  // ---- lifecycle ---------------------------------------------------------------
  const save = (who: Who, p: Player, status: string, name: string) =>
    statusOf(
      who,
      `${root}/records/player/${p.id}`,
      { name, coachId: p.coachId, status, expectedVersion: p.recordVersion },
      "PUT",
    );
  expect(await save(coach, await one(p1.id), "ARCHIVED", "Fictional Sprint One")).toBe(403);
  expect(await save(owner, await one(p1.id), "ARCHIVED", "Fictional Sprint One")).toBe(200);
  expect((await one(p1.id)).status).toBe("ARCHIVED");
  const invoiceFor = (playerId: string, label: string) =>
    train("invoice", {
      playerId,
      label,
      chargeMinor: 50000,
      currency: "INR",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      dueDate: "2026-11-20",
    });
  expect(await statusOf(owner, `${root}/finance`, invoiceFor(p1.id, "Archived charge"))).toBe(409);
  expect(await save(coach, await one(p1.id), "ACTIVE", "Fictional Sprint One")).toBe(403);
  expect(await save(owner, await one(p1.id), "ACTIVE", "Fictional Sprint One")).toBe(200);
  expect(await statusOf(owner, `${root}/finance`, invoiceFor(p1.id, "Restored charge"))).toBe(200);

  // ---- parent payment reference ------------------------------------------------
  const finance = (await (await owner.api.get(`${root}/finance`)).json()) as {
    invoices: { id: string; playerId: string }[];
  };
  const invoice = finance.invoices.find((i) => i.playerId === p1.id)!;
  const reference = (id: string, text: string) =>
    train("reference", {
      invoiceId: id,
      amountMinor: 20000,
      currency: "INR",
      reference: text,
      method: "UPI",
      paidOn: "2026-11-10",
    });
  expect(await statusOf(parent2, `${root}/finance`, reference(invoice.id, `SPRINT-${suffix}-X`))).toBe(404);
  const reported = await call<{ id: string; status: string; submittedBy: string }>(
    parent1,
    `${root}/finance`,
    reference(invoice.id, `SPRINT-${suffix}-A`),
  );
  expect(reported).toMatchObject({ status: "PENDING", submittedBy: parent1.id });
  expect(
    await statusOf(
      parent1,
      `${root}/finance`,
      train("verify", { reviewed: true, note: "Approving my own payment." }, { id: reported.id, expectedVersion: 1 }),
    ),
  ).toBe(403);
  expect(
    await statusOf(parent1, `${root}/finance`, invoiceFor(p1.id, "Self-issued charge")),
  ).toBe(403);
  const queue = (await (await owner.api.get(`${root}/finance`)).json()) as {
    payments: { id: string; status: string }[];
  };
  expect(queue.payments.find((p) => p.id === reported.id)?.status).toBe("PENDING");

  // ---- closures ------------------------------------------------------------------
  const closure = await call<{ id: string; version: number }>(
    owner,
    `${root}/training`,
    train("closure", {
      branchId: "",
      startDate: "2026-12-24",
      endDate: "2026-12-26",
      reason: "SECRET internal reason: ground dispute",
      publicNote: "Holiday break: no training.",
    }),
  );
  const sessionOn = (date: string) =>
    train("session", {
      branchId: branch.id,
      squadId: batch.id,
      coachIds: [coach.id],
      timezone: "Asia/Kolkata",
      location: "Synthetic pitch",
      startLocal: `${date}T17:00`,
      endLocal: `${date}T18:00`,
    });
  expect(await statusOf(owner, `${root}/training`, sessionOn("2026-12-25"))).toBe(409);
  expect(await statusOf(owner, `${root}/training`, sessionOn("2026-12-28"))).toBe(200);
  expect(
    await statusOf(coach, `${root}/training`, train("closure", { branchId: "", startDate: "2026-12-30", endDate: "2026-12-30", reason: "Coach attempt" })),
  ).toBe(403);
  const parentPayload = await (await parent1.api.get(`${root}`)).text();
  expect(parentPayload).toContain("Holiday break: no training.");
  expect(parentPayload).not.toContain("SECRET internal reason");

  // ---- enquiries ------------------------------------------------------------------
  const enquiryBody = {
    childName: "Fictional Prospect Child",
    guardianName: "Fictional Prospect Guardian",
    contact: "+910000000000",
    source: "Website",
    followUpDate: "2026-11-01",
    notes: "Asked about weekend batches.",
  };
  expect(await statusOf(coach, `${root}/records/enquiry`, enquiryBody)).toBe(403);
  const enquiry = await call<{ id: string }>(owner, `${root}/records/enquiry`, enquiryBody, 201);
  expect(await (await coach.api.get(`${root}/records/enquiry`)).text()).not.toContain("Prospect");
  expect(await (await parent1.api.get(`${root}`)).text()).not.toContain("Prospect");
  const converted = await call<{ created: boolean; player: { id: string; status: string } }>(
    owner,
    `${root}/actions`,
    { action: "convertEnquiry", id: enquiry.id, data: { coachId: owner.id, squadId: batch.id } },
  );
  expect(converted).toMatchObject({ created: true, player: { status: "TRIAL" } });
  const again = await call<{ created: boolean; player: { id: string } }>(
    owner,
    `${root}/actions`,
    { action: "convertEnquiry", id: enquiry.id, data: { coachId: owner.id } },
  );
  expect(again).toMatchObject({ created: false, player: { id: converted.player.id } });
  expect((await players()).filter((p) => (p as unknown as { name: string }).name === enquiryBody.childName)).toHaveLength(1);
  const pending = await call<{ id: string }>(
    owner,
    `${root}/records/enquiry`,
    { ...enquiryBody, childName: "Fictional Waiting Child" },
    201,
  );
  expect(pending.id).not.toBe(enquiry.id);

  // ---- coach hand-over -------------------------------------------------------------
  const coachMembership = (
    (await (await owner.api.get(`${root}`)).json()) as {
      members: { id: string; userId: string; role: string }[];
    }
  ).members.find((m) => m.userId === coach.id)!;
  const revokeNow = (data?: object) =>
    owner.api.post(`${root}/actions`, {
      data: { action: "revoke", id: coachMembership.id, ...(data ? { data } : {}) },
    });
  const refused = await revokeNow();
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toMatch(/Choose a replacement coach/);
  expect((await one(p1.id)).coachId).toBe(coach.id);

  // ---- screens ---------------------------------------------------------------------
  const ownerContext = await browser.newContext({
    storageState: await owner.api.storageState(),
    viewport: { width: 1536, height: 1024 },
  });
  const ownerPage = await ownerContext.newPage();
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  await ownerPage.goto(`/workspace/${academy.id}?section=players&player=${p1.id}`);
  await ownerPage.getByRole("button", { name: "Edit Fictional Sprint One" }).click();
  const statusOptions = ownerPage
    .getByRole("dialog")
    .getByRole("combobox", { name: "Status", exact: true })
    .locator("option");
  await expect(statusOptions).toHaveText(["Active", "Trial", "Paused", "Inactive", "Archived"]);
  await ownerPage.keyboard.press("Escape");
  await ownerPage.goto(`/workspace/${academy.id}?section=players`);
  await ownerPage.getByRole("button", { name: /^Enquiries/ }).click();
  await expect(ownerPage.getByRole("list", { name: "Recorded enquiries" })).toContainText("Fictional Waiting Child");
  await expect(ownerPage.getByRole("list", { name: "Recorded enquiries" })).toContainText("follow up");
  await ownerPage.keyboard.press("Escape");
  await ownerPage.goto(`/workspace/${academy.id}?section=calendar&date=2026-12-24`);
  await expect(ownerPage.getByRole("list", { name: "Closed days" })).toContainText("Whole academy");
  await ownerPage.getByRole("button", { name: "Closed days" }).click();
  await expect(ownerPage.getByRole("dialog")).toContainText("Lift closure");
  await ownerPage.keyboard.press("Escape");
  await ownerPage.goto(`/workspace/${academy.id}?section=settings&tab=team`);
  await ownerPage.getByRole("button", { name: /Revoke/ }).first().waitFor();
  const parentContext = await browser.newContext({
    storageState: await parent1.api.storageState(),
    viewport: { width: 390, height: 1024 },
  });
  const parentPage = await parentContext.newPage();
  parentPage.on("pageerror", (error) => pageErrors.push(error.message));
  await parentPage.goto(`/workspace/${academy.id}?section=calendar`);
  await expect(parentPage.getByRole("region", { name: "Closed days" })).toContainText("Holiday break: no training.");
  await expect(parentPage.getByText("SECRET internal reason")).toHaveCount(0);
  await parentPage.goto(`/workspace/${academy.id}?section=fees`);
  await parentPage.getByRole("button", { name: /I have paid/ }).click();
  const dialog = parentPage.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Report a payment" })).toBeVisible();
  await dialog.getByLabel("Payment reference").fill(`SPRINT-${suffix}-B`);
  await dialog.getByLabel("Amount", { exact: false }).first().fill("100");
  await dialog.getByRole("button", { name: "Send payment reference" }).click();
  await expect(dialog).toBeHidden();
  const after = (await (await owner.api.get(`${root}/finance`)).json()) as {
    payments: { reference: string; status: string; submittedBy: string }[];
  };
  expect(
    after.payments.find((p) => p.reference === `SPRINT-${suffix}-B`),
  ).toMatchObject({ status: "PENDING", submittedBy: parent1.id });

  // ---- hand-over completes with a replacement ------------------------------------------
  const done = await revokeNow({ replacementCoachId: owner.id });
  expect(done.status(), await done.text()).toBe(200);
  expect((await done.json()).handover).toMatchObject({ players: 2, replacementCoachId: owner.id });
  expect((await one(p1.id)).coachId).toBe(owner.id);
  expect((await one(p2.id)).coachId).toBe(owner.id);
  expect(await statusOf(coach, `${root}/training`, sessionOn("2026-12-29"))).toBe(403);
  expect(closure.version).toBe(1);
  expect(pageErrors).toEqual([]);
});
