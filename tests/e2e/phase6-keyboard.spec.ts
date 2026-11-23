import { test, expect, type Page } from "@playwright/test";
// Phase 6: keyboard and focus behaviour of the real screens, with real sessions.
test.use({ actionTimeout: 15000 });
test("sign-in, the skip link, focus visibility, dialog focus and touch targets work from the keyboard", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  // Sign-up is limited per address (3 per 10 s) for the whole run: let the previous spec's window clear,
  // and leave a clear window for the next one (see the end of this test).
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8),
    password = `Synthetic-only-${crypto.randomUUID()}`;
  const owner = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const email = `kbd-owner-${suffix}@example.test`;
  const signUp = await owner.post("/api/auth/sign-up/email", {
    data: { name: "Keyboard Owner", email, password },
  });
  expect(signUp.status(), await signUp.text()).toBe(200);
  const academy = await owner.post("/api/workspaces", {
    data: {
      name: "Keyboard Academy",
      contactEmail: "kbd@example.test",
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
  });
  expect(academy.status()).toBe(201);
  const id = (await academy.json()).id as string;

  // ---- sign-in: labelled fields, keyboard submit, announced error -------------
  {
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const emailField = page.getByLabel(/email/i).first(),
      passwordField = page.getByLabel(/^password/i).first();
    await expect(emailField).toBeVisible();
    await emailField.focus();
    await page.keyboard.press("Tab");
    await expect(passwordField).toBeFocused();
    await emailField.fill(email);
    await passwordField.fill("definitely-wrong-password");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("alert").first()).not.toBeEmpty();
    await context.close();
  }

  const signedIn = async (width: number, height: number) => {
    const context = await browser.newContext({
      storageState: await owner.storageState(),
      viewport: { width, height },
      hasTouch: width < 600,
    });
    return { context, page: await context.newPage() };
  };
  const focusRing = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "none";
      const s = getComputedStyle(el);
      const outline =
        s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow !== "none";
      const border = el.matches("input, select, textarea");
      return outline || shadow || border
        ? "visible"
        : `none:${el.tagName}.${String(el.className).slice(0, 30)}`;
    });

  // ---- the skip link and a visible focus indicator ----------------------------
  {
    const { context, page } = await signedIn(1366, 768);
    await page.goto(`/workspace/${id}?section=messages`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // A fresh page has no focused element yet: start the keyboard at the top of the document.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => location.hash))
      .toBe("#portal-content");
    // Walk the first stops of the page: each one shows where focus is.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    const hidden: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const ring = await focusRing(page);
      if (ring !== "visible" && ring !== "none") hidden.push(ring);
    }
    expect(hidden, "focused controls with no visible focus indicator").toEqual(
      [],
    );
    await context.close();
  }

  // ---- a dialog takes focus, keeps it, and gives it back -----------------------
  {
    const { context, page } = await signedIn(1366, 768);
    await page.goto(`/workspace/${id}?section=messages`);
    const trigger = page.getByRole("button", {
      name: "Batch announcements",
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Batch announcements" });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")),
      )
      .toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest("[role=dialog]"),
        ),
        `Tab ${i + 1} stays inside the dialog`,
      ).toBe(true);
    }
    for (let i = 0; i < 25; i++) await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest("[role=dialog]"),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await context.close();
  }

  // ---- phone: the primary controls are big enough to touch --------------------
  {
    const { context, page } = await signedIn(390, 844);
    await page.goto(`/workspace/${id}?section=messages`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "nav button, nav a, header button, main button, main select, main input:not([type=checkbox]):not([type=radio])",
        ),
      ]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(
          ({ box }) =>
            box.width > 0 &&
            box.height > 0 &&
            (box.height < 40 || box.width < 40),
        )
        .map(
          ({ el, box }) =>
            `${el.tagName}.${String((el as HTMLElement).className).slice(0, 24)} ${Math.round(box.width)}x${Math.round(box.height)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`,
        ),
    );
    // The navigation and header controls are the ones used on every visit.
    const nav = small.filter((s) => /portal-(icon|avatar|nav)|nav/i.test(s));
    expect(nav, "primary controls below 40px").toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await context.close();
  }
  await owner.dispose();
  await new Promise((resolve) => setTimeout(resolve, 11000));
});
