// WP2.5: the academy-scoped store in a real browser. Cached data is reused
// only for the same academy and the same signed-in user, and it never outlives
// a refusal from the server: a revoked membership or an ended session empties
// it, and nothing private stays on screen afterwards.
import { test, expect, type APIRequestContext } from "@playwright/test";

test("WP2.5 the store reuses fresh data, drops it on 401/403 and never crosses academies", async ({
  playwright,
  browser,
}, testInfo) => {
  test.setTimeout(300000);
  const origin = String(testInfo.project.use.baseURL),
    suffix = crypto.randomUUID();
  let registrations = 0;
  async function account(name: string) {
    if (registrations++) await new Promise((r) => setTimeout(r, 11000));
    const api = await playwright.request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Origin: origin },
      }),
      email = `${name}-${suffix}@example.test`;
    const response = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { api, email, id: (await response.json()).user.id as string };
  }
  async function post<T>(
    api: APIRequestContext,
    path: string,
    data: unknown,
    expected = 200,
  ) {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(expected);
    return (await response.json()) as T;
  }
  const owner = await account("StoreOwner"),
    coach = await account("StoreCoach");
  const config = (name: string) => ({
    name,
    contactEmail: "store-qa@example.test",
    country: "IN",
    language: "English",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    ageGroups: ["U12"],
    demo: false,
  });
  const one = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      config("Store Academy One"),
      201,
    ),
    two = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      config("Store Academy Two"),
      201,
    );
  const rootOne = `/api/workspaces/${one.id}`;
  const invitation = await post<{ token: string }>(
    owner.api,
    `${rootOne}/actions`,
    {
      action: "invite",
      data: { email: coach.email, role: "COACH", playerIds: [] },
      verified: true,
    },
  );
  await post(coach.api, "/api/invitations/accept", { token: invitation.token });
  await post(
    owner.api,
    `${rootOne}/records/player`,
    { birthDate: "2015-05-05", name: "Store Secret Player", squad: "Store Batch", coachId: coach.id },
    201,
  );
  const coachMembership = (
    await (await coach.api.get(`${rootOne}/bootstrap`)).json()
  ).membership as { id: string };

  const requests = (page: import("@playwright/test").Page) => {
    const calls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.startsWith("/api/") &&
        !url.pathname.includes("/api/auth")
      )
        calls.push(
          `${request.method()} ${url.pathname.replace(one.id, "ONE").replace(two.id, "TWO")}${url.search}`,
        );
    });
    return {
      calls,
      count: (text: string) => calls.filter((c) => c === text).length,
    };
  };
  const settle = async (page: import("@playwright/test").Page) => {
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
  };
  const nav = (page: import("@playwright/test").Page, name: string) =>
    page
      .getByRole("navigation", { name: "Academy navigation" })
      .getByRole("button", { name, exact: true })
      .click();

  // Fresh data is reused: Home → Calendar → Home asks for the summary once.
  const coachContext = await browser.newContext({
      storageState: await coach.api.storageState(),
      viewport: { width: 1536, height: 1024 },
    }),
    page = await coachContext.newPage(),
    log = requests(page);
  await page.goto(`/workspace/${one.id}`);
  await expect(page.getByText("Active players")).toBeVisible();
  await expect(
    page.locator(".portal-stat").filter({ hasText: "Active players" }),
  ).toContainText("1");
  await nav(page, "Calendar");
  await settle(page);
  await nav(page, "Overview");
  await expect(page.getByText("Active players")).toBeVisible();
  await settle(page);
  expect(log.count("GET /api/workspaces/ONE/bootstrap")).toBe(0);
  expect(log.count("GET /api/workspaces/ONE/home")).toBe(1);

  // Access revoked: the next request is refused, the store is emptied and the
  // refusal is shown instead of any previously loaded data.
  await post(owner.api, `${rootOne}/actions`, {
    action: "revoke",
    id: coachMembership.id,
    // P1-04: the coach still has players, so the revoke names its decision.
    data: { leaveUnassigned: true },
    verified: true,
  });
  expect((await coach.api.get(`${rootOne}/home`)).status()).toBe(403);
  await nav(page, "Players");
  await expect(
    page
      .locator("main [role=alert], .notice[role=alert], p[role=alert]")
      .first(),
  ).toContainText("No active membership in this academy.");
  await expect(page.locator("body")).not.toContainText("Store Secret Player");
  await expect(page.getByText("Active players")).toHaveCount(0);
  await coachContext.close();

  // Session ended: the next request is refused with 401 and nothing stays.
  const ownerContext = await browser.newContext({
      storageState: await owner.api.storageState(),
      viewport: { width: 1536, height: 1024 },
    }),
    ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`/workspace/${one.id}`);
  await expect(ownerPage.getByText("Active players")).toBeVisible();
  await ownerContext.clearCookies();
  await nav(ownerPage, "Players");
  // Every section change re-checks access on the server, so a dead session
  // lands on the sign-in page; nothing private remains on screen.
  await expect(
    ownerPage.getByRole("heading", { name: "Sign in" }),
  ).toBeVisible();
  await expect(ownerPage.locator("body")).not.toContainText(
    "Store Secret Player",
  );
  await expect(ownerPage.getByText("Active players")).toHaveCount(0);
  // A request the page makes by itself after that is refused as well.
  expect(
    (await ownerPage.request.get(`/api/workspaces/${one.id}/home`)).status(),
  ).toBe(401);

  // A 403 is not always ended access (a role limit, a business rule on one
  // action). A refused request must not blank the portal, destroy what is open
  // on other screens or make the refused screen ask again in a loop.
  const refusedContext = await browser.newContext({
      storageState: await owner.api.storageState(),
      viewport: { width: 1536, height: 1024 },
    }),
    refusedPage = await refusedContext.newPage(),
    refusedLog = requests(refusedPage);
  await refusedPage.route(
    `**/api/workspaces/${one.id}/records/report?view=summary*`,
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "That is not allowed for your role." }),
      }),
  );
  await refusedPage.goto(`/workspace/${one.id}`);
  await expect(refusedPage.getByText("Active players")).toBeVisible();
  await nav(refusedPage, "Reports");
  await settle(refusedPage);
  await expect(
    refusedPage.getByRole("navigation", { name: "Academy navigation" }),
  ).toBeVisible();
  await expect(
    refusedPage.getByRole("heading", { name: "Loading your academy…" }),
  ).toHaveCount(0);
  const summaryReads = () =>
    refusedLog.count("GET /api/workspaces/ONE/records/report?view=summary");
  expect(summaryReads()).toBe(1);
  // Access still stands: the bootstrap check found nothing to revoke.
  expect(
    refusedLog.count("GET /api/workspaces/ONE/bootstrap"),
  ).toBeLessThanOrEqual(1);
  await nav(refusedPage, "Overview");
  await expect(refusedPage.getByText("Active players")).toBeVisible();
  await expect(
    refusedPage.locator(".portal-stat").filter({ hasText: "Active players" }),
  ).toContainText("1");
  await refusedContext.close();

  // Academies never share data: the second academy's portal asks only for its
  // own records and shows none of the first academy's.
  const freshContext = await browser.newContext({
      storageState: await owner.api.storageState(),
      viewport: { width: 1536, height: 1024 },
    }),
    otherPage = await freshContext.newPage(),
    otherLog = requests(otherPage);
  await otherPage.goto(`/workspace/${one.id}`);
  await expect(
    otherPage.locator(".portal-stat").filter({ hasText: "Active players" }),
  ).toContainText("1");
  await otherPage.goto(`/workspace/${two.id}`);
  await expect(
    otherPage.locator(".portal-stat").filter({ hasText: "Active players" }),
  ).toContainText("0");
  await nav(otherPage, "Players");
  await settle(otherPage);
  await expect(otherPage.locator("body")).not.toContainText(
    "Store Secret Player",
  );
  expect(
    otherLog.calls.filter((c) => c.includes("/ONE/")).length,
  ).toBeGreaterThan(0);
  const afterSwitch = otherLog.calls.slice(
    otherLog.calls.findIndex((c) => c.includes("/TWO/")),
  );
  expect(afterSwitch.every((c) => !c.includes("/ONE"))).toBe(true);
  await freshContext.close();
  await ownerContext.close();
  await owner.api.dispose();
  await coach.api.dispose();
});
