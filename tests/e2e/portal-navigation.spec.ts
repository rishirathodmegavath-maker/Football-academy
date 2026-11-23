import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspacePlayer } from "../../src/domain/workspace";

// Wave 2 (navigation), in a real browser against the real server: the approved names and order for each role, nothing shown
// disabled, one short message for a section the role cannot open, `?section=` addresses with back and forward, and the shell at
// desktop, tablet and phone widths. Hiding a menu item is never the permission check, so the same roles are also refused by the
// API for what they are not offered.
const SHOTS = process.env.W24_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test("navigation: names and order by role, hidden sections, typed addresses, back and forward, and widths", async ({
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(480000);
  const origin = new URL(baseURL ?? "http://127.0.0.1:3031").origin;
  const suffix = crypto.randomUUID();
  const apis: APIRequestContext[] = [];
  let registrations = 0;
  async function account(name: string) {
    if (registrations++) await new Promise((resolve) => setTimeout(resolve, 11000));
    const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    apis.push(api);
    const email = `${name}-${suffix}@example.test`;
    const password = `Synthetic-only-${crypto.randomUUID()}`;
    const response = await api.post("/api/auth/sign-up/email", { data: { name, email, password } });
    expect(response.status(), await response.text()).toBe(200);
    return { api, name, email, id: (await response.json()).user.id as string };
  }
  async function post<T>(api: APIRequestContext, path: string, data: unknown, status = 200): Promise<T> {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(status);
    return response.json() as Promise<T>;
  }
  const config = (name: string, modules: string[]) => ({
    name,
    contactEmail: "navigation-qa@example.test",
    country: "IN",
    language: "English",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    modules,
    demo: false,
  });
  const staffNav = (page: Page) => page.getByRole("navigation", { name: "Academy navigation" });
  const labels = (page: Page) => staffNav(page).getByRole("button").allInnerTexts();
  const current = (page: Page) => staffNav(page).locator("button[aria-current=page]");
  const unavailable = (page: Page) => page.getByRole("heading", { name: "This section is unavailable for your role" });
  const noOverflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const STAFF = ["Overview", "Players", "Calendar", "Training", "Reports", "Fees", "Communications", "Settings"];

  try {
    const owner = await account("NavOwner");
    const coach = await account("NavCoach");
    const parent = await account("NavParent");
    const withFees = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      config("Navigation Academy", ["development", "reports", "communication", "fees"]),
      201,
    );
    const withoutFees = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      config("Navigation Academy No Fees", ["development", "reports", "communication"]),
      201,
    );
    const aid = withFees.id,
      root = `/api/workspaces/${aid}`;
    const coachInvite = await post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      verified: true,
      data: { email: coach.email, role: "COACH" },
    });
    await post(coach.api, "/api/invitations/accept", { token: coachInvite.token });
    const player = await post<WorkspacePlayer>(
      owner.api,
      `${root}/records/player`,
      { name: "Nav Kid", squad: "U10 Navigation", coachId: coach.id, ageCategory: "U10", birthDate: "2015-05-05", sportIds: ["football"] },
      201,
    );
    const parentInvite = await post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      verified: true,
      data: { email: parent.email, role: "PARENT", playerIds: [player.id], guardianVerified: true },
    });
    await post(parent.api, "/api/invitations/accept", { token: parentInvite.token });

    const open = async (who: { api: APIRequestContext }, width: number, height = 900) => {
      const context = await browser.newContext({
        baseURL: origin,
        storageState: await who.api.storageState(),
        viewport: { width, height },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      return { context, page, errors };
    };

    // 1. The owner at desktop width: the approved names in the approved order, no dead bell, Overview is the current page.
    const o = await open(owner, 1440);
    await o.page.goto(`/workspace/${aid}`);
    await expect(staffNav(o.page)).toBeVisible();
    expect(await labels(o.page)).toEqual(STAFF);
    await expect(current(o.page)).toHaveText("Overview");
    await expect(o.page.getByRole("button", { name: "Messages requiring attention" })).toHaveCount(0);
    await expect(o.page.getByRole("button", { name: "Search academy players" }).first()).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Help and academy access" })).toBeVisible();
    await expect(staffNav(o.page).getByRole("button", { name: "More" })).toHaveCount(0);
    await expect(staffNav(o.page).getByRole("button", { name: "Home" })).toHaveCount(0);
    expect(await noOverflow(o.page)).toBe(true);
    await shot(o.page, "nav-owner-1440");

    // 2. `?section=` addresses with the browser's back and forward buttons.
    await staffNav(o.page).getByRole("button", { name: "Players", exact: true }).click();
    await expect(o.page).toHaveURL(/section=players/);
    await expect(current(o.page)).toHaveText("Players");
    await staffNav(o.page).getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(o.page).toHaveURL(/section=calendar/);
    await expect(current(o.page)).toHaveText("Calendar");
    await staffNav(o.page).getByRole("button", { name: "Training", exact: true }).click();
    await expect(o.page).toHaveURL(/section=training/);
    await expect(current(o.page)).toHaveText("Training");
    await o.page.goBack();
    await expect(o.page).toHaveURL(/section=calendar/);
    await expect(current(o.page)).toHaveText("Calendar");
    await o.page.goBack();
    await expect(o.page).toHaveURL(/section=players/);
    await expect(current(o.page)).toHaveText("Players");
    await o.page.goBack();
    await expect(o.page).not.toHaveURL(/section=/);
    await expect(current(o.page)).toHaveText("Overview");
    await o.page.goForward();
    await expect(o.page).toHaveURL(/section=players/);
    await expect(current(o.page)).toHaveText("Players");
    // Settings keeps its tab in the address, and the sidebar item says Settings (the family's item is still "More").
    await staffNav(o.page).getByRole("button", { name: "Settings", exact: true }).click();
    await expect(o.page).toHaveURL(/section=settings/);
    await expect(current(o.page)).toHaveText("Settings");
    await expect(o.page.getByRole("heading", { name: "Settings", exact: true }).first()).toBeVisible();
    // A reload of a deep address lands on the same section.
    await o.page.reload();
    await expect(current(o.page)).toHaveText("Settings");

    // 3. Typed addresses. An unknown section opens Overview; a section the role cannot open gets one short message and a way back.
    await o.page.goto(`/workspace/${aid}?section=bogus`);
    await expect(current(o.page)).toHaveText("Overview");
    await o.page.goto(`/workspace/${aid}?section=practice`);
    await expect(unavailable(o.page)).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Go to Overview" })).toBeVisible();
    await shot(o.page, "nav-owner-unavailable");
    await o.page.getByRole("button", { name: "Go to Overview" }).click();
    await expect(current(o.page)).toHaveText("Overview");
    await expect(unavailable(o.page)).toHaveCount(0);
    expect(o.errors).toEqual([]);

    // 4. The owner of an academy whose fees module is off is not offered Fees (nothing disabled), and a typed address gets the same message.
    await o.page.goto(`/workspace/${withoutFees.id}`);
    await expect(staffNav(o.page)).toBeVisible();
    expect(await labels(o.page)).toEqual(STAFF.filter((label) => label !== "Fees"));
    await o.page.goto(`/workspace/${withoutFees.id}?section=fees`);
    await expect(unavailable(o.page)).toBeVisible();
    await expect(o.page.locator(".portal-fees")).toHaveCount(0);
    await o.context.close();

    // 5. The coach: no Fees item, the same message for a typed address, and the server still refuses the finance data and fee writes.
    const c = await open(coach, 1440);
    await c.page.goto(`/workspace/${aid}`);
    await expect(staffNav(c.page)).toBeVisible();
    expect(await labels(c.page)).toEqual(STAFF.filter((label) => label !== "Fees"));
    await expect(current(c.page)).toHaveText("Overview");
    await c.page.goto(`/workspace/${aid}?section=fees`);
    await expect(unavailable(c.page)).toBeVisible();
    await expect(c.page.locator(".portal-fees")).toHaveCount(0);
    expect(await c.page.locator("body").innerText()).not.toContain("₹");
    await shot(c.page, "nav-coach-fees-unavailable");
    await c.page.getByRole("button", { name: "Go to Overview" }).click();
    await expect(current(c.page)).toHaveText("Overview");
    expect((await coach.api.get(`${root}/finance`)).status()).toBe(403);
    expect(
      (
        await coach.api.post(`${root}/records/fee`, {
          data: { playerId: player.id, amountMinor: 100, currency: "INR", label: "x" },
        })
      ).status(),
    ).toBe(403);
    expect(c.errors).toEqual([]);
    await c.context.close();

    // 6. The family: four items, a bottom bar on a phone, no staff navigation, and the staff-only sections refused by the server.
    const p = await open(parent, 390, 844);
    await p.page.goto(`/workspace/${aid}`);
    const family = p.page.getByRole("navigation", { name: "Parent navigation" });
    await expect(family).toBeVisible();
    expect(await family.getByRole("button").allInnerTexts()).toEqual(["Home", "Progress", "Messages", "More"]);
    await expect(p.page.getByRole("navigation", { name: "Academy navigation" })).toHaveCount(0);
    await expect(p.page.getByRole("button", { name: "Open academy navigation" })).toHaveCount(0);
    expect(await noOverflow(p.page)).toBe(true);
    await shot(p.page, "nav-parent-390");
    await p.page.goto(`/workspace/${aid}?section=players`);
    await expect(unavailable(p.page)).toBeVisible();
    await expect(p.page.getByRole("button", { name: "Go to Home" })).toBeVisible();
    await p.page.goto(`/workspace/${aid}?section=training`);
    await expect(unavailable(p.page)).toBeVisible();
    await p.page.getByRole("button", { name: "Go to Home" }).click();
    await expect(family.locator("button[aria-current=page]")).toHaveText("Home");
    expect(
      (await parent.api.post(`${root}/records/player`, { data: { name: "Not allowed", birthDate: "2015-05-05" } })).status(),
    ).toBe(403);
    expect(p.errors).toEqual([]);
    await p.context.close();

    // 7. The owner at tablet and phone widths: the same items, the sidebar at 820, a menu dialog at 390, no sideways scrolling.
    const t = await open(owner, 820, 1000);
    await t.page.goto(`/workspace/${aid}`);
    await expect(staffNav(t.page)).toBeVisible();
    expect(await labels(t.page)).toEqual(STAFF);
    expect(await noOverflow(t.page)).toBe(true);
    await shot(t.page, "nav-owner-820");
    await t.context.close();

    const m = await open(owner, 390, 844);
    await m.page.goto(`/workspace/${aid}`);
    await expect(m.page.locator(".portal-sidebar")).toBeHidden();
    await m.page.getByRole("button", { name: "Open academy navigation" }).click();
    const dialog = m.page.getByRole("dialog", { name: "Academy navigation" });
    await expect(dialog).toBeVisible();
    expect(await dialog.getByRole("navigation", { name: "Academy navigation" }).getByRole("button").allInnerTexts()).toEqual(STAFF);
    await shot(m.page, "nav-owner-390-menu");
    await dialog.getByRole("button", { name: "Players", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(m.page).toHaveURL(/section=players/);
    expect(await noOverflow(m.page)).toBe(true);
    // Back on a phone returns to the previous section too.
    await m.page.goBack();
    await expect(m.page).not.toHaveURL(/section=/);
    expect(m.errors).toEqual([]);
    await m.context.close();
  } finally {
    await Promise.all(apis.map((api) => api.dispose()));
  }
});
