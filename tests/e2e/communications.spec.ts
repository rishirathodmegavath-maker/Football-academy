import { test, expect, type APIRequestContext } from "@playwright/test";
import type { WorkspacePlayer } from "../../src/domain/workspace";

// The Communications screen, in a real browser against the real server: write an announcement, choose who and how,
// approve, send now, then use the free "Ready to send" buttons; the parent reads the Portal message in the app.
test("communications: write, approve, send now, ready to send, delivery log, parent app", async ({
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(420000);
  const origin = new URL(baseURL ?? "http://127.0.0.1:3012").origin;
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
    const owner = await account("ComOwner");
    const coach = await account("ComCoach");
    const parent = await account("ComParent");
    const academy = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      {
        name: "Synthetic Communications Academy",
        contactEmail: "communications-academy@example.test",
        country: "IN",
        language: "English",
        currency: "INR",
        timezone: "Asia/Kolkata",
        dateLocale: "en-IN",
        measurementSystem: "METRIC",
        brandAccent: "#008463",
        modules: ["development", "reports", "communication"],
        demo: false,
      },
      201,
    );
    const aid = academy.id,
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
      {
        name: "Zorro Messagekid",
        squad: "U10 Messages",
        coachId: coach.id,
        ageCategory: "U10",
        birthDate: "2015-05-05",
        sportIds: ["football"],
      },
      201,
    );
    const invitation = await post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      verified: true,
      data: { email: parent.email, role: "PARENT", playerIds: [player.id], guardianVerified: true },
    });
    await post(parent.api, "/api/invitations/accept", { token: invitation.token });

    const context = await browser.newContext({ baseURL: origin, storageState: await owner.api.storageState() });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`/workspace/${aid}?section=messages`);
    await expect(page.getByRole("heading", { name: "Communications", exact: true })).toBeVisible();
    for (const tab of ["Announcements", "Private conversations", "Templates", "Scheduled outbox", "Ready to send", "Delivery log"])
      await expect(page.getByRole("tab", { name: tab, exact: true })).toBeVisible();

    // 1. Write it, choose how, and see who it reaches before saving anything.
    await page.getByLabel("Subject", { exact: true }).fill("Friday training time");
    await page.getByRole("textbox", { name: /^Message/ }).fill("Friday training starts at 6 pm at the main ground.");
    await page.getByLabel(/^Email/).check();
    await page.getByLabel(/^WhatsApp/).check();
    await expect(page.getByText("1 family will receive this")).toBeVisible();
    await expect(page.getByText(/Portal 1 · Email 1 · WhatsApp 1/)).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    const row = page.getByRole("row", { name: /Friday training time/ });
    await expect(row.getByText("Draft", { exact: true })).toBeVisible();

    // 2. Approve: the dialog says who gets it first.
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Approve announcement" });
    await expect(dialog.getByText("1 family will receive this")).toBeVisible();
    await dialog.getByRole("button", { name: "Approve exact message & recipients" }).click();
    await expect(row.getByText("Approved", { exact: true })).toBeVisible();

    // 3. Send now: Portal is in the app; Email and WhatsApp wait in Ready to send.
    await row.getByRole("button", { name: "Send now" }).click();
    await expect(row.getByText("Processed", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Ready to send" }).click();
    const mail = page.getByRole("row", { name: /ComParent/ }).filter({ hasText: "@example.test" });
    await expect(mail.getByRole("link", { name: "Open mail app" })).toHaveAttribute("href", /^mailto:.*Friday%20training%20time/);
    await expect(mail.getByRole("link", { name: "Gmail" })).toHaveAttribute("href", /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
    await page.getByLabel(/WhatsApp number for/).fill("+91 98765 43210");
    await page.getByRole("button", { name: "Save number" }).click();
    await expect(page.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/919876543210\?text=/);
    await mail.getByRole("link", { name: "Open mail app" }).evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
    await mail.getByRole("link", { name: "Open mail app" }).click();
    await expect(mail.getByRole("link", { name: "Opened mail app" })).toBeVisible();

    // 4. The delivery log shows each channel, and "opened" is only that.
    await page.getByRole("tab", { name: "Delivery log" }).click();
    await expect(page.getByRole("row", { name: /Portal.*In the app/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Email.*Opened/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /WhatsApp.*Ready to share/ })).toBeVisible();

    // 5. Wording stays generic; the owner can save a template that then fills the form.
    const rejected = await owner.api.post(`${root}/actions`, {
      data: {
        action: "messagingSave",
        data: {
          action: "save",
          scheduledAt: null,
          data: {
            subject: "About Zorro",
            body: "Zorro Messagekid was late today.",
            playerIds: [],
            batchIds: [],
            allBatches: true,
            channels: ["PORTAL"],
            templateId: null,
          },
        },
      },
    });
    expect(rejected.status()).toBe(400);
    await page.getByRole("tab", { name: "Templates" }).click();
    await page.getByRole("button", { name: "Create template" }).click();
    await page.getByLabel("Template name").fill("Rain stop");
    await page.getByRole("dialog").getByLabel("Subject", { exact: true }).fill("Training cancelled today");
    await page.getByRole("dialog").getByRole("textbox", { name: /^Message/ }).fill("Training is cancelled today because of rain.");
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("cell", { name: "Rain stop" })).toBeVisible();
    await page.getByRole("tab", { name: "Announcements" }).click();
    await page.getByLabel("Saved template").selectOption({ label: "Rain stop" });
    await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Training cancelled today");

    // 6. The parent reads it in the app; the private conversation tab is still there for staff.
    const parentContext = await browser.newContext({ baseURL: origin, storageState: await parent.api.storageState() });
    const parentPage = await parentContext.newPage();
    await parentPage.goto(`/workspace/${aid}?section=messages&player=${player.id}`);
    await expect(parentPage.getByText("Friday training time")).toBeVisible();
    await expect(parentPage.getByText("Friday training starts at 6 pm at the main ground.")).toBeVisible();
    await parentContext.close();
    await page.getByRole("tab", { name: "Private conversations" }).click();
    await expect(page.getByText(/Choose a player to open their private conversation|Private conversations/).first()).toBeVisible();
    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    await Promise.all(apis.map((api) => api.dispose()));
  }
});
