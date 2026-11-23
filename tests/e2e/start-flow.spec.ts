// The first-run path of a new academy owner: create an account (the password is
// typed twice, with a guide), start an academy from a short form, land in the
// academy, and on the next sign-in go straight back to it. The academy list
// stays available from every other visit.
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("a new owner creates an account, starts an academy from two fields, and signing in again opens it", async ({
  page,
}) => {
  test.setTimeout(240000);
  const email = `start.${randomUUID()}@example.test`,
    password = `Opening-day-${randomUUID()}`;

  // 1. Create an account: the password guide shows, and a mismatch is refused.
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Pat Starter");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await expect(page.getByText("Password strength")).toBeVisible();
  await expect(
    page.getByText("At least 12 characters", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Confirm password").fill(`${password}-typo`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The two passwords do not match." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  // 2. No academy yet: the start page shows the short form.
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByText("One account, every")).toBeVisible();
  await expect(page.getByLabel("Academy name", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Academy contact email", { exact: true }),
  ).toBeVisible();
  // Country, city and currency are chosen up front; the rest is under "More settings".
  const country = page.getByLabel("Country", { exact: true });
  const currency = page.getByLabel("Currency", { exact: true });
  await expect(country).toHaveValue("IN");
  await expect(currency).toHaveValue("INR");
  await expect(page.getByLabel("City", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Default branch time zone")).toBeHidden();
  // Choosing another country fills in its currency and time zone.
  await country.selectOption("GB");
  await expect(currency).toHaveValue("GBP");
  await page.getByText("More settings (optional)").click();
  await expect(page.getByLabel("Default branch time zone")).toHaveValue(
    "Europe/London",
  );
  await page.getByText("More settings (optional)").click();
  await country.selectOption("IN");
  await expect(currency).toHaveValue("INR");
  await page
    .getByLabel("Academy name", { exact: true })
    .fill("Opening Day Football Academy");
  await page
    .getByLabel("Academy contact email", { exact: true })
    .fill("office@openingday.example.test");
  // A city is needed before the academy can be created.
  await page.getByRole("button", { name: "Create empty academy" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  expect(
    await page
      .getByLabel("City", { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
  ).toBe(true);
  await page.getByLabel("City", { exact: true }).fill("Mandi");
  await page.getByRole("button", { name: "Create empty academy" }).click();

  // 3. The academy opens.
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}/);
  const academyUrl = page.url();
  await expect(page.getByText("Opening Day Football Academy")).toBeVisible();

  // 4. Signing in again goes straight to the academy.
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(academyUrl);

  // 5. The academy list is still reachable on purpose.
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Your academy workspaces" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open academy" })).toBeVisible();
});
