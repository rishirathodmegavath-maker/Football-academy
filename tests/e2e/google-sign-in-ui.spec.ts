// "Continue with Google" on the sign-in / registration screen, in a real browser.
// Project "enabled" (placeholder Google settings) and project "disabled" (none);
// see playwright.google-ui.config.ts. The one request the button makes is
// intercepted, so no Google account is contacted and nothing is authenticated
// by anything but Better Auth.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const PASSWORD = `Synthetic-only-${randomUUID()}`;
const SOCIAL = "**/api/auth/sign-in/social";
// Scoped to the screen: Next.js adds its own role="alert" route announcer.
const alert = (page: Page) => page.locator("main").getByRole("alert");
const google = (page: Page) =>
  page.getByRole("button", { name: "Continue with Google" });

test.describe("button enabled", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "enabled", "enabled server only");
  });

  test("sits above the e-mail form, separated by OR, on sign-in and registration", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const button = google(page);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button.locator("svg.google-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const email = page.getByLabel("Email");
    const divider = page.getByRole("separator", { name: "or" });
    await expect(divider).toContainText("OR");
    const [b, d, e] = await Promise.all([
      button.boundingBox(),
      divider.boundingBox(),
      email.boundingBox(),
    ]);
    expect(b!.y + b!.height).toBeLessThan(d!.y);
    expect(d!.y + d!.height).toBeLessThan(e!.y);
    expect(b!.height).toBeGreaterThanOrEqual(44);
    // The existing controls are all still there.
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Forgot your password?" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Create an account" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(google(page)).toBeVisible();
    await expect(page.getByLabel("Your name")).toBeVisible();
    await expect(
      page.getByText("Access to an academy still comes from"),
    ).toBeVisible();
  });

  test("is not offered while resetting a password", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    await expect(google(page)).toHaveCount(0);
    await expect(page.getByRole("separator")).toHaveCount(0);
  });

  test("is the first control reached by keyboard and has a visible focus ring", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.keyboard.press("Tab"); // the Sportozen wordmark link
    await page.keyboard.press("Tab");
    await expect(google(page)).toBeFocused();
    const outline = await google(page).evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(outline).not.toBe("none");
  });

  test("sends only the provider and the fixed landing page, waits visibly, and recovers from an error", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bodies: unknown[] = [];
    await page.route(SOCIAL, async (route) => {
      bodies.push(route.request().postDataJSON());
      await gate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "stand-in failure" }),
      });
    });
    await google(page).click();
    // Loading: the label changes, the button and the e-mail form wait.
    const waiting = page.getByRole("button", { name: "Opening Google…" });
    await expect(waiting).toBeDisabled();
    await expect(waiting).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
    release();
    // Error: shown beside the button; the form works again.
    await expect(alert(page)).toContainText(
      "Google sign-in could not be started",
    );
    await expect(google(page)).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    // Nothing a browser could use to pick a role or an academy.
    expect(bodies).toEqual([{ provider: "google", callbackURL: "/workspace" }]);
    expect(JSON.stringify(bodies)).not.toMatch(/role|academy|redirect/i);
  });

  test("explains rate limiting", async ({ page }) => {
    await page.goto("/sign-in");
    await page.route(SOCIAL, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ message: "slow down" }),
      }),
    );
    await google(page).click();
    await expect(alert(page)).toContainText("Too many attempts");
  });

  test("shows a connection error if the request cannot be made", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await page.route(SOCIAL, (route) => route.abort("failed"));
    await google(page).click();
    await expect(alert(page)).toContainText("Check your connection");
    await expect(google(page)).toBeEnabled();
  });

  test("loads nothing from Google until the button is used", async ({
    page,
  }) => {
    const external: string[] = [];
    const violations: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        !/^(127\.0\.0\.1|localhost)$/.test(url.hostname) &&
        url.protocol.startsWith("http")
      )
        external.push(url.hostname);
    });
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text()))
        violations.push(message.text());
    });
    await page.goto("/sign-in", { waitUntil: "networkidle" });
    await expect(google(page)).toBeVisible();
    expect(external).toEqual([]);
    expect(violations).toEqual([]);
  });

  for (const [label, size] of [
    ["phone", { width: 360, height: 640 }],
    ["tablet", { width: 768, height: 1024 }],
  ] as const)
    test(`fits a ${label} screen without sideways scrolling`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      for (const registering of [false, true]) {
        await page.goto("/sign-in");
        if (registering)
          await page.getByRole("button", { name: "Create an account" }).click();
        const scroll = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          view: document.documentElement.clientWidth,
        }));
        expect(scroll.page).toBeLessThanOrEqual(scroll.view);
        const [button, input] = await Promise.all([
          google(page).boundingBox(),
          page.getByLabel("Email").boundingBox(),
        ]);
        // Same width as the form fields: it is part of the card, not a stray element.
        expect(Math.abs(button!.width - input!.width)).toBeLessThan(2);
      }
    });

  test("email and password still register and sign in", async ({
    page,
    context,
  }) => {
    const email = `google-ui.${randomUUID()}@example.test`;
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Your name").fill("Google UI Check");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/workspace/);
    await context.clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace/);
    // A wrong password is still refused and Google does not change that.
    await context.clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(`${PASSWORD}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert(page)).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe("button disabled (Google not configured)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "disabled", "disabled server only");
  });

  test("is visible, disabled and explained, and makes no request", async ({
    page,
  }) => {
    let requests = 0;
    await page.route(SOCIAL, (route) => {
      requests++;
      return route.abort();
    });
    await page.goto("/sign-in");
    const button = google(page);
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(
      "Google sign-in is not switched on for this deployment yet.",
    );
    await button.click({ force: true });
    expect(requests).toBe(0);
    await expect(alert(page)).toHaveCount(0);
    // The rest of the screen is unaffected.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
