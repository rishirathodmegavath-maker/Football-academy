import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Waves 3 and 4, in a real browser against the real server: the first-run setup checklist, field-linked errors on the player form,
// an empty list versus a list that a filter emptied (with "Clear filters"), and the Training empty state and its setup address.
const SHOTS = process.env.W24_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test("states and first run: setup checklist, player form errors, empty versus no results, training setup address", async ({
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(420000);
  const origin = new URL(baseURL ?? "http://127.0.0.1:3001").origin;
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
  try {
    const owner = await account("StatesOwner");
    const coach = await account("StatesCoach");
    const academy = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      {
        name: "States Academy",
        contactEmail: "states-qa@example.test",
        country: "IN",
        language: "English",
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
    const aid = academy.id,
      root = `/api/workspaces/${aid}`;
    const invite = await post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      verified: true,
      data: { email: coach.email, role: "COACH" },
    });
    await post(coach.api, "/api/invitations/accept", { token: invite.token });

    const open = async (who: { api: APIRequestContext }, width = 1440, height = 900) => {
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

    // 1. A new academy: the owner sees the checklist with nothing done; a coach does not see it.
    const o = await open(owner);
    await o.page.goto(`/workspace/${aid}`);
    const checklist = o.page.getByRole("region", { name: "Set up your academy" });
    await expect(checklist).toBeVisible();
    await expect(checklist.getByText("0 of 3 steps done.")).toBeVisible();
    for (const step of ["Add your first player", "Set up a batch and venue", "Create your first session"])
      await expect(checklist.getByRole("button", { name: step, exact: true })).toBeVisible();
    await shot(o.page, "states-owner-checklist");
    const c = await open(coach);
    await c.page.goto(`/workspace/${aid}`);
    await expect(c.page.getByRole("navigation", { name: "Academy navigation" })).toBeVisible();
    await expect(c.page.getByRole("heading", { name: "Set up your academy" })).toHaveCount(0);
    // A coach who types the setup address is not given the owner's dialog.
    await c.page.goto(`/workspace/${aid}?section=training&create=setup`);
    await expect(c.page.getByRole("dialog", { name: "Set up batch and venue" })).toHaveCount(0);
    await c.context.close();

    // 2. Nothing in the academy yet is an empty state with its call to action, not a "no results" state.
    await o.page.goto(`/workspace/${aid}?section=players`);
    await expect(o.page.getByRole("heading", { name: "Add your first football player" })).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);

    // 3. The player form: errors belong to their fields, focus goes to the first one, and they clear as the person fixes them.
    await o.page.getByRole("button", { name: "Add player", exact: true }).first().click();
    const dialog = o.page.getByRole("dialog", { name: "Add player" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Add player", exact: true }).click();
    const name = dialog.getByLabel("Player name");
    const birth = dialog.getByLabel(/Date of birth/);
    await expect(dialog.getByText("Enter the player's name.")).toBeVisible();
    await expect(dialog.getByText("Enter the player's date of birth.")).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAttribute("aria-describedby", "player-name-error");
    await expect(birth).toHaveAttribute("aria-describedby", "player-birth-error");
    await shot(o.page, "states-player-form-errors");
    await name.fill("Inline Error Kid");
    await expect(dialog.getByText("Enter the player's name.")).toHaveCount(0);
    await expect(dialog.getByText("Enter the player's date of birth.")).toBeVisible();
    await birth.fill("2099-01-01");
    await dialog.getByRole("button", { name: "Add player", exact: true }).click();
    await expect(dialog.getByText("The date of birth cannot be in the future.")).toBeVisible();
    await expect(birth).toBeFocused();
    await birth.fill("2015-05-05");
    await dialog.getByRole("button", { name: "Add player", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(o.page.getByText("Inline Error Kid").first()).toBeVisible();

    // 4. A filter that matches nothing is a "no results" state with its own action; clearing it brings the list back.
    await post(owner.api, `${root}/records/player`, {
        name: "Second Listed Kid",
        ageCategory: "",
        birthDate: "2016-06-06",
        position: "",
        squadId: "",
        coachId: owner.id,
        status: "ACTIVE",
        placementReviewed: false,
        sportIds: ["football"],
      }, 201);
    await o.page.goto(`/workspace/${aid}?section=players`);
    await expect(o.page.getByText("Second Listed Kid").first()).toBeVisible();
    await o.page.getByLabel("Search player directory").fill("zzzz-no-such-player");
    const empty = o.page.getByRole("status").filter({ hasText: "No players match these filters" });
    await expect(empty).toBeVisible();
    await expect(empty.getByText("Each academy starts empty")).toHaveCount(0);
    await expect(empty.getByRole("button", { name: "Add player" })).toHaveCount(0);
    await shot(o.page, "states-players-no-results");
    await empty.getByRole("button", { name: "Clear filters" }).click();
    await expect(empty).toHaveCount(0);
    await expect(o.page.getByLabel("Search player directory")).toHaveValue("");
    await expect(o.page.getByText("Second Listed Kid").first()).toBeVisible();
    await expect(o.page.getByText("Inline Error Kid").first()).toBeVisible();

    // 5. Training: an empty month says so (no filters to clear), and the setup address opens the owner's setup dialog.
    await o.page.goto(`/workspace/${aid}?section=training`);
    await expect(o.page.getByText("No sessions are planned for this month.")).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    await o.page.goto(`/workspace/${aid}?section=training&create=setup`);
    await expect(o.page.getByRole("dialog", { name: "Set up batch and venue" })).toBeVisible();
    await shot(o.page, "states-training-setup");

    // 5b. Fees: no invoice has ever been issued, so it says that (and offers the first one), not "no matching invoices".
    await o.page.goto(`/workspace/${aid}?section=fees`);
    await expect(o.page.getByRole("heading", { name: "No invoices yet" })).toBeVisible();
    await expect(o.page.getByRole("heading", { name: "No matching invoices" })).toHaveCount(0);
    await expect(o.page.getByRole("button", { name: "Issue first invoice" })).toBeVisible();
    await expect(o.page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    await shot(o.page, "states-fees-empty");

    // 5c. Reports: a batch filter that matches no player is a "no results" state with its own action; clearing it removes the filter from the address.
    await o.page.goto(`/workspace/${aid}?section=reports&reportBatch=No%20Such%20Batch`);
    const noReports = o.page.getByRole("status").filter({ hasText: "No players match this filter" });
    await expect(noReports).toBeVisible();
    await shot(o.page, "states-reports-no-results");
    await noReports.getByRole("button", { name: "Clear filters" }).click();
    await expect(o.page).not.toHaveURL(/reportBatch=/);
    await expect(noReports).toHaveCount(0);

    // 6. Back on Overview the checklist keeps count: one step done, and the done step is no longer a button.
    await o.page.goto(`/workspace/${aid}`);
    await expect(checklist.getByText("1 of 3 steps done.")).toBeVisible();
    await expect(checklist.getByRole("button", { name: "Add your first player" })).toHaveCount(0);
    await expect(checklist.getByText("Done", { exact: true })).toBeVisible();
    await checklist.getByRole("button", { name: "Create your first session" }).click();
    await expect(o.page).toHaveURL(/section=training/);
    expect(o.errors).toEqual([]);
    await o.context.close();
  } finally {
    await Promise.all(apis.map((api) => api.dispose()));
  }
});
