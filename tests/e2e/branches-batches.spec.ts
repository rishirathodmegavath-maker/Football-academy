import { test, expect } from "@playwright/test";

// Settings → Sessions: "Branches & batches" with Create branch / Create batch,
// a searchable table for each, and an edit dialog per row.
test("Settings → Sessions creates and edits branches and batches, and refuses duplicates", async ({
  playwright,
  browser,
}, testInfo) => {
  test.setTimeout(180000);
  const origin = String(testInfo.project.use.baseURL);
  const api = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const registration = await api.post("/api/auth/sign-up/email", {
    data: {
      name: "Alex Morgan",
      email: `branches-${crypto.randomUUID()}@example.test`,
      password: `Test-only-${crypto.randomUUID()}`,
    },
  });
  expect(registration.status(), await registration.text()).toBe(200);
  const created = await api.post("/api/workspaces", {
    data: {
      name: "Riverside Football Academy",
      contactEmail: "info@riversidefa.example.test",
      country: "IN",
      language: "English",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      ageGroups: ["U8", "U10", "U12"],
      demo: true,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const academy = await created.json();

  const context = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto(`/workspace/${academy.id}?section=settings`);
  await page
    .getByRole("tab", { name: "Sessions", exact: true })
    .or(page.getByRole("button", { name: "Sessions", exact: true }))
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Branches & batches", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No branches yet.")).toBeVisible();
  // A batch needs a branch.
  await expect(
    page.getByRole("button", { name: "Create batch" }).first(),
  ).toBeDisabled();

  // Create a branch.
  await page.getByRole("button", { name: "Create branch" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Branch name").fill("Raise");
  await dialog.getByRole("button", { name: "Create branch" }).click();
  await expect(dialog).toBeHidden();
  const branches = page.getByRole("region", { name: "Branches table" }).or(
    page.locator("[aria-label='Branches table']"),
  );
  await expect(branches.getByRole("cell", { name: "Raise", exact: true })).toBeVisible();

  // The same branch again is refused, whatever the letter case.
  await page.getByRole("button", { name: "Create branch" }).first().click();
  await dialog.getByLabel("Branch name").fill("raise");
  await dialog.getByRole("button", { name: "Create branch" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await page.getByRole("button", { name: "Close branch editor" }).click();
  await expect(dialog).toBeHidden();
  await expect(branches.getByRole("cell", { name: "Raise", exact: true })).toHaveCount(1);

  // Create a batch under it.
  await page.getByRole("button", { name: "Create batch" }).first().click();
  await dialog.getByLabel("Batch name").fill("Under 10");
  await dialog
    .getByRole("combobox", { name: "Branch", exact: true })
    .selectOption({ label: "Raise" });
  await dialog.getByRole("button", { name: "Create batch" }).click();
  await expect(dialog).toBeHidden();
  const batches = page.locator("[aria-label='Batches table']");
  await expect(batches.getByRole("cell", { name: "Under 10", exact: true })).toBeVisible();
  await expect(batches.getByRole("cell", { name: "Raise", exact: true })).toBeVisible();

  // Edit it.
  await batches.getByRole("button", { name: /Edit batch/ }).click();
  await dialog.getByLabel("Batch name").fill("Under 12");
  await dialog.getByRole("button", { name: "Save batch" }).click();
  await expect(dialog).toBeHidden();
  await expect(batches.getByRole("cell", { name: "Under 12", exact: true })).toBeVisible();
  await expect(batches.getByRole("cell", { name: "Under 10", exact: true })).toHaveCount(0);

  // Edit the branch, then search.
  await branches.getByRole("button", { name: /Edit branch/ }).click();
  await dialog.getByLabel("Branch name").fill("Raise North");
  await dialog.getByRole("button", { name: "Save branch" }).click();
  await expect(dialog).toBeHidden();
  await expect(batches.getByRole("cell", { name: "Raise North", exact: true })).toBeVisible();
  await page.getByPlaceholder("Search branches…").fill("zzz");
  await expect(page.getByText("No branch matches your search.")).toBeVisible();
  await page.getByPlaceholder("Search branches…").fill("");
  await page.screenshot({ path: testInfo.outputPath("branches-batches.png"), fullPage: true });

  // It survives a reload.
  await page.reload();
  await page
    .getByRole("tab", { name: "Sessions", exact: true })
    .or(page.getByRole("button", { name: "Sessions", exact: true }))
    .first()
    .click();
  await expect(batches.getByRole("cell", { name: "Under 12", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
