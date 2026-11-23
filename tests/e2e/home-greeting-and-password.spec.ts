// Two small things in a real browser: the Home greeting follows the ACADEMY's
// clock (India time for an Asia/Kolkata academy, whatever the device's time zone
// is), and the password fields have a show / hide button.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const ORIGIN = "http://127.0.0.1:3001";
const PASSWORD = `Synthetic-only-${randomUUID()}`;

test.describe("password show / hide", () => {
  const field = (page: Page) => page.getByLabel("Password", { exact: true });
  const toggle = (page: Page, name: "Show password" | "Hide password") =>
    page.getByRole("button", { name }).first();

  test("works on sign-in and on registration, keeps what was typed, and does not rename the field", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    for (const registering of [false, true]) {
      if (registering)
        await page.getByRole("button", { name: "Create an account" }).click();
      // One field named exactly "Password": the button does not join its label.
      await expect(field(page)).toHaveCount(1);
      await expect(field(page)).toHaveAttribute("type", "password");
      await field(page).fill("a very long synthetic secret");
      await expect(toggle(page, "Show password")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await toggle(page, "Show password").click();
      await expect(field(page)).toHaveAttribute("type", "text");
      await expect(field(page)).toHaveValue("a very long synthetic secret");
      await expect(toggle(page, "Hide password")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await toggle(page, "Hide password").click();
      await expect(field(page)).toHaveAttribute("type", "password");
      await expect(field(page)).toHaveValue("a very long synthetic secret");
    }
  });
  test("is reachable and operable from the keyboard", async ({ page }) => {
    await page.goto("/sign-in");
    await field(page).focus();
    await page.keyboard.press("Tab");
    await expect(toggle(page, "Show password")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(field(page)).toHaveAttribute("type", "text");
    // The button keeps focus and now offers to hide.
    await expect(toggle(page, "Hide password")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveAttribute("type", "password");
    // Pressing Enter on the button did not submit the form.
    await expect(page).toHaveURL(/\/sign-in$/);
  });
  test("does not change signing in: a typed password still signs in, and the eye is on the phone layout too", async ({
    page,
    request,
  }) => {
    const email = `eye.${randomUUID().slice(0, 8)}@example.test`;
    const made = await request.post("/api/auth/sign-up/email", {
      headers: { origin: ORIGIN },
      data: { name: "Eye Tester", email, password: PASSWORD },
    });
    expect(made.ok()).toBeTruthy();
    await page.context().clearCookies();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await field(page).fill(PASSWORD);
    await toggle(page, "Show password").click();
    await expect(field(page)).toHaveValue(PASSWORD);
    const sideways = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(sideways).toBe(false);
    // The button sits inside the field, at its right edge.
    const [input, button] = await Promise.all([
      field(page).boundingBox(),
      toggle(page, "Hide password").boundingBox(),
    ]);
    expect(button!.x).toBeGreaterThan(input!.x + input!.width / 2);
    expect(button!.x + button!.width).toBeLessThanOrEqual(
      input!.x + input!.width + 1,
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace/);
  });
});

test.describe("Home greeting", () => {
  // The device is deliberately NOT in India: the greeting must follow the academy.
  test.use({ timezoneId: "America/Los_Angeles" });

  test("follows the academy's clock (India time), at every boundary", async ({
    page,
  }) => {
    test.setTimeout(120000);
    const made = await page.request.post("/api/auth/sign-up/email", {
      headers: { origin: ORIGIN },
      data: {
        name: "Greeting Tester",
        email: `greeting.${randomUUID().slice(0, 8)}@example.test`,
        password: PASSWORD,
      },
    });
    expect(made.ok()).toBeTruthy();
    const created = await page.request.post("/api/workspaces", {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: {
        name: "Kolkata Greeting Academy",
        contactEmail: "office@example.test",
        country: "IN",
        language: "English",
        currency: "INR",
        timezone: "Asia/Kolkata",
        dateLocale: "en-IN",
        measurementSystem: "METRIC",
        brandAccent: "#008463",
        sportIds: ["football"],
        ageGroups: [],
        reviewFrequency: "Monthly",
        modules: ["development", "reports", "communication", "fees"],
        demo: false,
      },
    });
    expect(created.status()).toBe(201);
    const id = String((await created.json()).id);
    const heading = page.getByRole("heading", { level: 1 }).first();
    for (const [utc, greeting, ist] of [
      ["2026-11-03T18:35:00Z", "Good evening", "00:05"],
      ["2026-11-03T23:25:00Z", "Good evening", "04:55"],
      ["2026-11-03T23:35:00Z", "Good morning", "05:05"],
      ["2026-11-04T06:25:00Z", "Good morning", "11:55"],
      ["2026-11-04T06:40:00Z", "Good afternoon", "12:10"],
      ["2026-11-04T11:25:00Z", "Good afternoon", "16:55"],
      ["2026-11-04T11:40:00Z", "Good evening", "17:10"],
    ] as const) {
      await page.clock.setFixedTime(new Date(utc));
      await page.goto(`/workspace/${id}`);
      await expect(heading, `${ist} IST`).toContainText(
        `${greeting}, Greeting`,
      );
    }
    // The date beside it is the academy's date too: 00:05 IST on 4 November.
    await page.clock.setFixedTime(new Date("2026-11-03T18:35:00Z"));
    await page.goto(`/workspace/${id}`);
    await expect(page.locator("time").first()).toHaveText("4 Nov 2026");
    await expect(page.locator("time").first()).toHaveAttribute(
      "datetime",
      "2026-11-04",
    );
  });
});
