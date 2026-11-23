import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
// Drill library, Stage 1 corrections, in the browser: the coach's session view
// (desktop, tablet, phone), Drill 13 enforced over the API, a legacy snapshot
// labelled and not filled in, the development plan screen without the old copy
// button, locked safety and family-text counters in the form, the explicit
// "this removes content" step, and the revision history. Fictional data only.
test.use({ actionTimeout: 15000 });
test("session drill instructions, the age rule, safety protection and history", async ({
  playwright,
  browser,
}, testInfo) => {
  test.setTimeout(420000);
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
  const owner = await account("FixOwner");
  const coach = await account("FixCoach");
  const parent = await account("FixParent");
  const academy = await call<{ id: string }>(
    owner,
    "/api/workspaces",
    {
      name: "Correction Check Academy",
      contactEmail: "fixes@example.test",
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
      data: { email: who.email, role, playerIds, guardianVerified: role === "PARENT" },
    });
    await call(who, "/api/invitations/accept", { token: made.token });
  };
  await invite(coach, "COACH");
  const player = (name: string, birthDate: string) =>
    call<{ id: string }>(
      owner,
      `${root}/records/player`,
      { name, squad: "", coachId: coach.id, birthDate },
      201,
    );
  const older = await player("Fictional Older Child", "2013-05-01");
  const younger = await player("Fictional Younger Child", "2016-05-01");
  await invite(parent, "PARENT", [older.id]);
  const branch = await call<{ id: string }>(
    owner,
    `${root}/records/branch`,
    { name: "Correction Branch", timezone: "Asia/Kolkata" },
    201,
  );
  const train = (action: string, data: unknown, extra: object = {}) => ({
    requestId: crypto.randomUUID(),
    action,
    data,
    ...extra,
  });
  const squadOf = (name: string, playerIds: string[]) =>
    call<{ id: string }>(owner, `${root}/training`, train("squad", { name, branchId: branch.id, playerIds }));
  const olderSquad = await squadOf("Older group", [older.id]);
  const youngerSquad = await squadOf("Younger group", [younger.id]);
  const sessionBody = (squadId: string, day: string, agenda: unknown[]) =>
    train("session", {
      branchId: branch.id,
      squadId,
      coachIds: [coach.id],
      timezone: "Asia/Kolkata",
      location: "Synthetic pitch",
      startLocal: `2026-12-${day}T17:00`,
      endLocal: `2026-12-${day}T18:30`,
      agenda,
    });

  // ---- Drill 13 is enforced by the server, whatever the screen does ---------------------
  const blocked = await owner.api.post(`${root}/training`, {
    data: sessionBody(youngerSquad.id, "21", [{ drillId: "uni-013", duration: 10 }]),
  });
  expect(blocked.status()).toBe(409);
  const reason = ((await blocked.json()) as { error: string }).error;
  expect(reason).toContain("Blindfold Soccer Movements is for players aged 12 or over");
  expect(reason).toContain("Fictional Younger Child (age 10)");
  expect(reason).toContain("not an association rule");
  // The same refusal when a coach tries it directly.
  const coachBlocked = await coach.api.post(`${root}/training`, {
    data: sessionBody(youngerSquad.id, "22", [{ drillId: "uni-013", duration: 10 }]),
  });
  expect(coachBlocked.status()).toBe(409);
  const session = await call<{ id: string }>(
    owner,
    `${root}/training`,
    sessionBody(olderSquad.id, "20", [
      { drillId: "uni-013", duration: 10 },
      { drillId: "uni-016", duration: 15 },
    ]),
  );

  // ---- the coach's session view, desktop / tablet / phone -----------------------------
  const newPage = async (who: Who, width: number, height: number) => {
    const context = await browser.newContext({
      baseURL: origin,
      storageState: await who.api.storageState(),
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height });
    return page;
  };
  const overflow = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
  for (const [label, width, height] of [
    ["desktop", 1440, 1000],
    ["tablet", 820, 1180],
    ["phone", 390, 844],
  ] as const) {
    const page = await newPage(coach, width, height);
    await page.goto(`/workspace/${academy.id}?section=training&session=${session.id}`);
    const instructions = page.getByRole("region", { name: "Drill instructions" });
    await expect(instructions).toBeVisible();
    const drills = instructions.locator("details[data-testid=session-drill]");
    await expect(drills).toHaveCount(2);
    await drills.first().locator("summary").click();
    const first = drills.first();
    for (const heading of ["Equipment", "Setup", "Instructions", "Coaching points", "Progressions", "Safety"])
      await expect(first.getByRole("heading", { name: heading })).toBeVisible();
    await expect(first.getByText(/Minimum age 12/)).toBeVisible();
    await expect(first.getByRole("img").first()).toBeVisible();
    await expect(first.getByText(/Saved with this session/)).toBeVisible();
    await expect(first.getByText(/Later changes to the library do not change this plan/)).toBeVisible();
    expect(await overflow(page), `${label}: the session view overflows`).toBe(false);
    expect(
      await first.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      `${label}: a drill panel overflows`,
    ).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`session-drills-${label}.png`) });
    await page.context().close();
  }

  // ---- an older session snapshot is labelled, never filled from today's library ----------
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!);
  try {
    const row = db
      .prepare("SELECT body FROM workspace_records WHERE academyId=? AND kind='session' AND id=?")
      .get(academy.id, session.id) as { body: string };
    const stored = JSON.parse(row.body);
    const legacy = stored.agenda[1].drill;
    for (const key of ["content", "snapshot", "lockedSafety", "minimumAge"]) delete legacy[key];
    db.prepare("UPDATE workspace_records SET body=? WHERE academyId=? AND kind='session' AND id=?").run(
      JSON.stringify(stored),
      academy.id,
      session.id,
    );
  } finally {
    db.close();
  }
  const ownerPage = await newPage(owner, 1440, 1000);
  await ownerPage.goto(`/workspace/${academy.id}?section=training&session=${session.id}`);
  const second = ownerPage
    .getByRole("region", { name: "Drill instructions" })
    .locator("details[data-testid=session-drill]")
    .nth(1);
  await second.locator("summary").click();
  await expect(second.getByTestId("historical-content-unavailable")).toBeVisible();
  await expect(second.getByText(/Historical content unavailable/)).toBeVisible();
  await expect(second.getByRole("heading", { name: "Instructions" })).toHaveCount(0);
  await expect(second.getByRole("img")).toHaveCount(0);

  // ---- a parent never receives the session or its drills ---------------------------------
  const parentSessions = (await (await parent.api.get(`${root}/records/session`)).json()) as unknown[];
  expect(parentSessions).toEqual([]);
  expect((await parent.api.get(`${root}/records/drill`)).status()).toBe(200);
  expect(await (await parent.api.get(`${root}/records/drill`)).json()).toEqual([]);

  // ---- the development plan screen no longer copies templates -----------------------------
  await ownerPage.goto(`/workspace/${academy.id}?section=development&player=${older.id}`);
  await expect(ownerPage.getByText("Academy-owned drill library")).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: "Copy drill template" })).toHaveCount(0);
  await ownerPage.getByText("Academy-owned drill library").click();
  await expect(ownerPage.getByText(/so no duplicate drills are created/)).toBeVisible();

  // ---- the form: locked safety, minimum age, family-text counters, explicit removal ------------
  const customised = await call<{ drill: { id: string; recordVersion: number } }>(owner, `${root}/actions`, {
    action: "customiseDrill",
    id: "uni-013",
  });
  expect(customised.drill.id).toBe("from-uni-013");
  await ownerPage.goto(`/workspace/${academy.id}?section=training`);
  await ownerPage
    .getByRole("navigation", { name: "Training sections" })
    .getByRole("button", { name: "Drill library", exact: true })
    .click();
  await ownerPage.getByLabel("Search drills").fill("Blindfold");
  await ownerPage.getByRole("button", { name: "View details for Blindfold Soccer Movements" }).first().click();
  await ownerPage.getByRole("button", { name: "Open your academy copy" }).click();
  await ownerPage.getByRole("button", { name: "Edit drill" }).click();
  const form = ownerPage.getByRole("dialog", { name: "Edit academy drill" });
  await expect(form.getByText(/Minimum age 12/)).toBeVisible();
  await expect(form.getByRole("group", { name: "Safety lines from the library" })).toBeVisible();
  await expect(form.getByText("Safety lines from the library (cannot be removed)")).toBeVisible();
  // Family-text counter and limit: nothing is cut, saving is held back.
  await form.getByLabel("Purpose (shown to families)").fill("p".repeat(161));
  await expect(form.getByText(/161\/160: too long/)).toBeVisible();
  await expect(form.getByRole("button", { name: "Save drill" })).toBeDisabled();
  await form.getByLabel("Purpose (shown to families)").fill("Builds balance and awareness of body position.");
  await expect(form.getByRole("button", { name: "Save drill" })).toBeEnabled();
  // Emptying a box is a different act from saving: it must be acknowledged.
  await form.getByLabel("Description").fill("");
  await expect(form.getByText(/Saving will remove what was in: Description/)).toBeVisible();
  await expect(form.getByRole("button", { name: "Save drill" })).toBeDisabled();
  await form.getByLabel(/I understand that leaving a box empty removes that content/).check();
  await expect(form.getByRole("button", { name: "Save drill" })).toBeEnabled();
  await form.getByRole("button", { name: "Save drill" }).click();
  await expect(ownerPage.getByRole("dialog").getByRole("heading", { name: "Blindfold Soccer Movements" })).toBeVisible();
  // The saved copy still has every library safety line and the age rule.
  const after = (await (await owner.api.get(`${root}/records/drill/from-uni-013`)).json()) as {
    content: { safety: string[]; description?: string; steps: string[] };
    minimumAge?: { years: number };
    lockedSafety: string[];
    purpose: string;
  };
  expect(after.content.description).toBe("");
  expect(after.content.steps.length).toBeGreaterThan(0);
  expect(after.lockedSafety.length).toBeGreaterThan(0);
  for (const line of after.lockedSafety) expect(after.content.safety).toContain(line);
  expect(after.minimumAge?.years).toBe(12);
  expect(after.purpose).toBe("Builds balance and awareness of body position.");
  // A copy of Drill 13 is held to the same age rule.
  const copyBlocked = await owner.api.post(`${root}/training`, {
    data: sessionBody(youngerSquad.id, "23", [{ drillId: "from-uni-013", duration: 10 }]),
  });
  expect(copyBlocked.status()).toBe(409);

  // ---- the revision history -----------------------------------------------------------------
  await ownerPage.getByRole("dialog").getByRole("button", { name: "History" }).click();
  const history = ownerPage.getByRole("dialog", { name: /History of Blindfold Soccer Movements/ });
  await expect(history.getByText(/Revision 2: Edited/)).toBeVisible();
  await expect(history.getByText(/Revision 1: Customised from universal Drill 13/)).toBeVisible();
  await expect(history.getByText(/Earlier revisions are never rewritten/)).toBeVisible();
  const revisions = (await (await owner.api.get(`${root}/drills/from-uni-013/revisions`)).json()) as {
    revisions: { revision: number }[];
  };
  expect(revisions.revisions.map((r) => r.revision)).toEqual([2, 1]);
  // Only the owner, an admin or the creator may read it; nobody can write it.
  expect((await coach.api.get(`${root}/drills/from-uni-013/revisions`)).status()).toBe(403);
  expect((await parent.api.get(`${root}/drills/from-uni-013/revisions`)).status()).toBe(403);
  expect((await owner.api.post(`${root}/drills/from-uni-013/revisions`, { data: {} })).status()).toBe(405);
  expect((await owner.api.get(`${root}/records/drillrevision`)).status()).toBe(404);
  // A stale archive is refused; a missing version is refused.
  expect(
    (await owner.api.post(`${root}/actions`, { data: { action: "archiveDrill", id: "from-uni-013" } })).status(),
  ).toBe(400);
  expect(
    (
      await owner.api.post(`${root}/actions`, {
        data: { action: "archiveDrill", id: "from-uni-013", data: { expectedVersion: 1 } },
      })
    ).status(),
  ).toBe(409);

  // ---- recovery: a failed catalogue load can be retried ---------------------------------------
  const retryPage = await newPage(owner, 1440, 1000);
  let failing = true;
  await retryPage.route(`**/api/workspaces/${academy.id}/drills/catalogue`, (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Library temporarily unavailable." }),
        })
      : route.continue(),
  );
  await retryPage.goto(`/workspace/${academy.id}?section=training`);
  await retryPage
    .getByRole("navigation", { name: "Training sections" })
    .getByRole("button", { name: "Drill library", exact: true })
    .click();
  const retryButton = retryPage.getByRole("button", { name: "Try again" });
  await expect(retryButton).toBeVisible();
  await expect(retryPage.locator("article.dl-card").filter({ hasText: "Dynamic Mobility Circuit" })).toHaveCount(0);
  failing = false;
  await retryButton.click();
  await expect(retryPage.locator("article.dl-card").filter({ hasText: "Dynamic Mobility Circuit" })).toHaveCount(1);
  await expect(retryButton).toHaveCount(0);

  expect(pageErrors.filter((m) => !/500|Internal Server/i.test(m))).toEqual([]);
});
