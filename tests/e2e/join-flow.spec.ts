// Inviting people by link: the owner creates a link, the invited person opens it,
// sets up their sign-in once and lands inside the academy, and later signs in
// the normal way (the link is not needed again). A player can have their own
// login, limited to their own record.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.use({ actionTimeout: 15000 });
const origin = "http://127.0.0.1:3001";

test("an owner creates a link, a parent joins with it, signs out and signs in again", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  const suffix = randomUUID();
  const ownerApi = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const signUp = await ownerApi.post("/api/auth/sign-up/email", {
    data: {
      name: "Link Owner",
      email: `link-owner-${suffix}@example.test`,
      password: `Synthetic-only-${randomUUID()}`,
    },
  });
  expect(signUp.status(), await signUp.text()).toBe(200);
  const ownerId = (await signUp.json()).user.id as string;
  const academyResponse = await ownerApi.post("/api/workspaces", {
    data: {
      name: "Link Test Academy",
      contactEmail: "link@example.test",
      country: "IN",
      language: "en",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      modules: ["development", "reports", "communication"],
      demo: false,
    },
  });
  expect(academyResponse.status(), await academyResponse.text()).toBe(201);
  const academy = (await academyResponse.json()) as { id: string };
  const child = await ownerApi.post(
    `/api/workspaces/${academy.id}/records/player`,
    {
      data: { birthDate: "2015-05-05", name: "Fictional Link Child", squad: "U12", coachId: ownerId },
    },
  );
  expect(child.status(), await child.text()).toBe(201);

  // 1. The owner creates a parent link in Settings, with copy and WhatsApp buttons.
  const ownerContext = await browser.newContext({
    storageState: await ownerApi.storageState(),
    viewport: { width: 1366, height: 900 },
  });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`/workspace/${academy.id}?section=settings&tab=team`);
  await expect(
    ownerPage.getByRole("heading", { name: "Invite people" }),
  ).toBeVisible();
  await ownerPage.getByLabel("Parent", { exact: false }).first().check();
  const parentEmail = `link-parent-${suffix}@example.test`;
  await ownerPage.getByLabel("Their email address").fill(parentEmail);
  await ownerPage.getByLabel("Fictional Link Child").check();
  await ownerPage
    .getByLabel("I confirm this person is the child’s parent or guardian")
    .check();
  await ownerPage
    .getByRole("button", { name: "Create invitation link" })
    .click();
  const linkField = ownerPage.getByRole("textbox", { name: "Invitation link" });
  await expect(linkField).toHaveValue(
    new RegExp(`${origin}/join/[0-9a-f]{64}$`),
  );
  const link = await linkField.inputValue();
  await expect(
    ownerPage.getByRole("button", { name: "Copy link" }),
  ).toBeVisible();
  const whatsapp = ownerPage.getByRole("link", { name: "Share on WhatsApp" });
  await expect(whatsapp).toHaveAttribute(
    "href",
    new RegExp(`^https://wa\\.me/\\?text=.*${encodeURIComponent(link)}`),
  );
  // The pending list shows who has not joined yet.
  await expect(ownerPage.getByText("Waiting to join")).toBeVisible();
  await expect(
    ownerPage.locator(".ps-pending strong", { hasText: parentEmail }),
  ).toBeVisible();

  // 2. The parent opens the link: the address is fixed, no token to paste.
  const parentContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const parentPage = await parentContext.newPage();
  await parentPage.goto(link);
  await expect(
    parentPage.getByRole("heading", { name: "Join Link Test Academy" }),
  ).toBeVisible();
  await expect(
    parentPage.getByText("Fictional Link Child").first(),
  ).toBeVisible();
  await expect(parentPage.getByLabel("Email")).toHaveValue(parentEmail);
  await expect(parentPage.getByLabel("Email")).toHaveAttribute("readonly", "");
  const password = `Opening-day-${randomUUID()}`;
  await parentPage.getByLabel("Your name").fill("Asha Parent");
  // The WhatsApp number is taken here, once, and kept with the membership.
  await parentPage
    .getByLabel("Your WhatsApp number (optional)")
    .fill("98765 43210");
  await parentPage.getByLabel("Password", { exact: true }).fill(password);
  await parentPage.getByLabel("Confirm password").fill(password);
  await parentPage.getByRole("button", { name: "Create account" }).click();
  await expect(parentPage).toHaveURL(new RegExp(`/workspace/${academy.id}`));
  const academyUrl = parentPage.url();
  // The number given while joining is already saved: the Account tab shows it and nobody asks again.
  await parentPage.goto(`/workspace/${academy.id}?section=settings&tab=Account`);
  await expect(parentPage.getByText(/Saved \(ending 3210\)/)).toBeVisible();

  // 3. Signing out and in again is the ordinary sign-in; no link needed.
  await parentContext.clearCookies();
  await parentPage.goto("/sign-in");
  await parentPage.getByLabel("Email").fill(parentEmail);
  await parentPage.getByLabel("Password", { exact: true }).fill(password);
  await parentPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(parentPage).toHaveURL(academyUrl);

  // 4. The link works once.
  const stranger = await browser.newContext();
  const again = await stranger.newPage();
  await again.goto(link);
  await expect(again.getByText("This link cannot be used")).toBeVisible();
  await expect(again.getByText(/already been used/)).toBeVisible();
  // The old emailed address format still opens the same page.
  await again.goto(`/workspace?invitation=${link.split("/join/")[1]}`);
  await expect(again).toHaveURL(/\/join\/[0-9a-f]{64}$/);
  await stranger.close();
  await parentContext.close();
  await ownerContext.close();
  await ownerApi.dispose();
});

test("players are under 18 and cannot be given a login of their own", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  // Sign-up is limited per address: leave the limiter window after the first test.
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const suffix = randomUUID();
  const api = async (name: string) => {
    const client = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const response = await client.post("/api/auth/sign-up/email", {
      data: {
        name,
        email: `${name.toLowerCase().replace(/\W/g, "")}-${suffix}@example.test`,
        password: `Synthetic-only-${randomUUID()}`,
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { client, id: (await response.json()).user.id as string };
  };
  const owner = await api("Player Link Owner");
  const post = async (
    client: APIRequestContext,
    path: string,
    data: unknown,
  ) => {
    const response = await client.post(path, { data });
    expect([200, 201], await response.text()).toContain(response.status());
    return response.json();
  };
  const academy = (await post(owner.client, "/api/workspaces", {
    name: "Player Link Academy",
    contactEmail: "player-link@example.test",
    country: "IN",
    language: "en",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    modules: ["development", "reports", "communication"],
    demo: false,
  })) as { id: string };
  const root = `/api/workspaces/${academy.id}`;
  const mine = (await post(owner.client, `${root}/records/player`, {
    name: "Fictional Own Login",
    birthDate: "2015-05-05",
    squad: "U16",
    coachId: owner.id,
  })) as { id: string };
  await post(owner.client, `${root}/records/player`, {
    name: "Fictional Teammate",
    birthDate: "2015-05-05",
    squad: "U16",
    coachId: owner.id,
  });
  // Players do not sign in: a player-login invitation is refused and creates nothing.
  const refused = await owner.client.post(`${root}/actions`, {
    data: {
      action: "invite",
      data: {
        email: `own-login-${suffix}@example.test`,
        role: "PLAYER",
        playerIds: [mine.id],
        guardianVerified: true,
      },
    },
  });
  expect(refused.status()).toBe(400);
  const invitations = (await (
    await owner.client.get(`${root}/invitations`)
  ).json()) as { invitations: unknown[] };
  expect(invitations.invitations).toHaveLength(0);
  await owner.client.dispose();
});

test("someone already signed in (for example back from Google) joins with one press and the number is saved", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const suffix = randomUUID();
  const api = async (name: string) => {
    const client = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name.toLowerCase().replace(/\W/g, "")}-${suffix}@example.test`;
    const response = await client.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${randomUUID()}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { client, email, id: (await response.json()).user.id as string };
  };
  const owner = await api("Signed In Owner");
  const academy = (await (
    await owner.client.post("/api/workspaces", {
      data: {
        name: "Signed In Academy",
        contactEmail: "signed-in@example.test",
        country: "IN",
        language: "en",
        currency: "INR",
        timezone: "Asia/Kolkata",
        dateLocale: "en-IN",
        measurementSystem: "METRIC",
        brandAccent: "#008463",
        modules: ["development", "reports", "communication"],
        demo: false,
      },
    })
  ).json()) as { id: string };
  const root = `/api/workspaces/${academy.id}`;
  const child = (await (
    await owner.client.post(`${root}/records/player`, {
      data: { name: "Fictional Signed Child", birthDate: "2015-05-05", squad: "U12", coachId: owner.id },
    })
  ).json()) as { id: string };
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const parent = await api("Signed In Parent");
  const invited = await owner.client.post(`${root}/actions`, {
    data: {
      action: "invite",
      data: { email: parent.email, role: "PARENT", playerIds: [child.id], guardianVerified: true },
    },
  });
  expect(invited.status(), await invited.text()).toBe(200);
  const { token } = (await invited.json()) as { token: string };
  const context = await browser.newContext({
    storageState: await parent.client.storageState(),
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`/join/${token}`);
  await expect(page.getByRole("heading", { name: "Join Signed In Academy" })).toBeVisible();
  // A number that cannot be read joins nobody and the link stays usable.
  await page.getByLabel("Your WhatsApp number (optional)").fill("12");
  await page.getByRole("button", { name: "Join the academy" }).click();
  await expect(page.getByText(/with its country code/)).toBeVisible();
  await page.getByLabel("Your WhatsApp number (optional)").fill("+44 7700 900123");
  await page.getByRole("button", { name: /Join the academy|Try again/ }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${academy.id}`));
  await page.goto(`/workspace/${academy.id}?section=settings&tab=Account`);
  await expect(page.getByText(/Saved \(ending 0123\)/)).toBeVisible();
  await context.close();
  await owner.client.dispose();
  await parent.client.dispose();
});
