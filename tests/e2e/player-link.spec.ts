import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// "Add player with invitation link": the owner makes one link; a player opens it with any email address, signs up, fills in their
// own details; the academy confirms them (with a parent or guardian's agreement); the link then works for nobody else. Run against the real server in a real browser.
const SHOTS = process.env.W24_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
};

test("owner makes a player link; the player signs up with their own email, fills in their details; the link works once", async ({
  playwright,
  browser,
  baseURL,
}) => {
  test.setTimeout(420000);
  const origin = new URL(baseURL ?? "http://127.0.0.1:3001").origin;
  const suffix = crypto.randomUUID();
  const apis: APIRequestContext[] = [];
  const api = async () => {
    const client = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    apis.push(client);
    return client;
  };
  try {
    // The owner and the academy (set up through the API, as the other specs do).
    const ownerEmail = `linkowner-${suffix}@example.test`;
    const ownerApi = await api();
    const signUp = await ownerApi.post("/api/auth/sign-up/email", {
      data: { name: "Link Owner", email: ownerEmail, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(signUp.status(), await signUp.text()).toBe(200);
    const created = await ownerApi.post("/api/workspaces", {
      data: {
        name: "Link Academy",
        contactEmail: "link-qa@example.test",
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
    });
    expect(created.status(), await created.text()).toBe(201);
    const aid = ((await created.json()) as { id: string }).id;

    // 1. The owner: "Add player" is still there, and so is the new "Add player with invitation link".
    const ownerContext = await browser.newContext({
      baseURL: origin,
      storageState: await ownerApi.storageState(),
      viewport: { width: 1440, height: 900 },
    });
    const owner = await ownerContext.newPage();
    await owner.goto(`/workspace/${aid}?section=players`);
    await expect(owner.getByRole("button", { name: "Add player", exact: true }).first()).toBeVisible();
    await owner.getByRole("button", { name: "Add player with invitation link" }).click();
    const dialog = owner.getByRole("dialog", { name: "Add player with invitation link" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create invitation link" }).click();
    const linkBox = dialog.getByLabel("Player invitation link");
    await expect(linkBox).toBeVisible();
    const link = await linkBox.inputValue();
    expect(link).toMatch(/\/join\/[0-9a-f]{64}$/);
    await shot(owner, "link-owner-dialog");
    await dialog.getByRole("button", { name: "Done" }).click();

    // 2. The link is a player link in the owner's waiting list, not tied to an address.
    const list = await ownerApi.get(`/api/workspaces/${aid}/invitations`);
    const listed = ((await list.json()) as { invitations: { role: string; open: boolean; email: string; state: string }[] })
      .invitations;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ role: "PLAYER", open: true, email: "", state: "PENDING" });
    expect(JSON.stringify(listed)).not.toContain(link.split("/join/")[1]);

    // 3. The player opens it with no account: it says so, and the email field is theirs to type.
    await new Promise((resolve) => setTimeout(resolve, 11000));
    const playerContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
    const player = await playerContext.newPage();
    const errors: string[] = [];
    player.on("pageerror", (error) => errors.push(error.message));
    await player.goto(link);
    await expect(player.getByRole("heading", { name: "Join Link Academy" })).toBeVisible();
    await expect(player.getByText("You are invited as a player.")).toBeVisible();
    const email = player.getByLabel("Email");
    await expect(email).toBeEditable();
    await expect(email).toHaveValue("");
    await shot(player, "link-player-join-390");
    const playerEmail = `young-${suffix}@example.test`;
    const password = `Synthetic-only-${crypto.randomUUID()}`;
    await player.getByLabel("Your name", { exact: true }).fill("Kiran Kumar");
    await email.fill(playerEmail);
    await player.getByLabel("Password", { exact: true }).fill(password);
    await player.getByLabel("Confirm password").fill(password);
    await player.getByRole("button", { name: "Create account" }).click();

    // 4. Signed in and inside the academy, they are asked for their own details; nothing else is shown yet.
    await expect(player.getByRole("heading", { name: "Tell Link Academy about yourself" })).toBeVisible({ timeout: 30000 });
    await expect(player.getByText("No linked child")).toHaveCount(0);
    await player.getByRole("button", { name: "Send my details" }).click();
    await expect(player.getByText("Enter your name.")).toBeVisible();
    await expect(player.getByText("Enter your date of birth.")).toBeVisible();
    await expect(player.getByText("Confirm that a parent or guardian knows you are joining.")).toBeVisible();
    await expect(player.getByLabel("Your name", { exact: true })).toBeFocused();
    await shot(player, "link-player-details-errors-390");
    await player.getByLabel("Your name", { exact: true }).fill("Kiran Kumar");
    await player.getByLabel(/Date of birth/).fill("2099-01-01");
    await player.getByRole("checkbox").check();
    await player.getByRole("button", { name: "Send my details" }).click();
    await expect(player.getByText("Choose a valid date of birth.")).toBeVisible();
    await player.getByLabel(/Date of birth/).fill("1990-01-01");
    await player.getByRole("button", { name: "Send my details" }).click();
    await expect(player.getByText(/must be under 18/).first()).toBeVisible();
    await player.getByLabel(/Date of birth/).fill("2014-03-03");
    await player.getByLabel("Position (optional)").fill("Midfield");
    await player.getByRole("button", { name: "Send my details" }).click();

    // 5. They now wait for the academy: no player exists, no home screen, nothing of the academy's is shown.
    await expect(player.getByRole("heading", { name: "Thank you. Your details are with Link Academy." })).toBeVisible({
      timeout: 30000,
    });
    // Before the academy confirms, only Home is offered: no Progress, no Messages.
    expect(await player.getByRole("navigation", { name: "Parent navigation" }).getByRole("button").allInnerTexts()).toEqual(["Home"]);
    await shot(player, "link-player-waiting-390");
    const playerApi = playerContext.request;
    const before = await playerApi.get(`/api/workspaces/${aid}/records/player`);
    expect(before.status()).toBe(200);
    const rowsOf = async (response: Awaited<ReturnType<typeof playerApi.get>>) => {
      const body = (await response.json()) as { id: string; name: string }[] | { records: { id: string; name: string }[] };
      return Array.isArray(body) ? body : body.records;
    };
    expect(await rowsOf(before)).toEqual([]);

    // 6. The link has been used: it works for nobody else, and for the same person again.
    const stranger = await browser.newContext({ baseURL: origin });
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(link);
    await expect(strangerPage.getByRole("heading", { name: "This link cannot be used" })).toBeVisible();
    await expect(strangerPage.getByText("This invitation has already been used.")).toBeVisible();
    await stranger.close();

    // 7. The owner sees the request on Players, cannot confirm without the consent statement, then confirms.
    await owner.goto(`/workspace/${aid}?section=players`);
    const waiting = owner.getByRole("region", { name: "Players waiting for your confirmation" });
    await expect(waiting).toBeVisible();
    await expect(waiting.getByText("Kiran Kumar", { exact: true })).toBeVisible();
    await expect(waiting.getByText(/born/)).toBeVisible();
    const confirm = waiting.getByRole("button", { name: "Confirm Kiran Kumar" });
    await expect(confirm).toBeDisabled();
    // The server refuses it too, with the exact status, when the statement is missing.
    const noConsent = await ownerApi.post(`/api/workspaces/${aid}/actions`, {
      headers: { Origin: origin },
      data: {
        action: "selfPlayerDecide",
        data: { userId: ((await (await playerApi.get("/api/auth/get-session")).json()) as { user: { id: string } }).user.id, decision: "approve" },
      },
    });
    expect(noConsent.status()).toBe(400);
    await shot(owner, "link-owner-approval");
    await waiting.getByRole("checkbox").check();
    await confirm.click();
    await expect(waiting).toHaveCount(0);
    await expect(owner.getByText("Kiran Kumar").first()).toBeVisible();
    await expect(owner.getByRole("button", { name: "Add player", exact: true }).first()).toBeVisible();
    await shot(owner, "link-owner-players-after");

    // 8. The player reloads and has a player's home: Home, Schedule, More. No fees, no messages, no parent wording.
    await player.reload();
    await expect(player.getByRole("heading", { name: "Hi Kiran" })).toBeVisible({ timeout: 30000 });
    const nav = player.getByRole("navigation", { name: "Player navigation" });
    await expect(nav).toBeVisible();
    expect(await nav.getByRole("button").allInnerTexts()).toEqual(["Home", "Schedule", "More"]);
    expect(await player.locator("body").innerText()).not.toMatch(/your child|Message coach|Fee due/i);
    await shot(player, "link-player-home-390");
    await player.goto(`/workspace/${aid}?section=fees`);
    await expect(player.getByRole("heading", { name: "This section is unavailable for your role" })).toBeVisible();
    await player.goto(`/workspace/${aid}?section=messages`);
    await expect(player.getByRole("heading", { name: "This section is unavailable for your role" })).toBeVisible();
    await player.goto(`/workspace/${aid}?section=calendar`);
    await expect(player.getByRole("heading", { name: "Training schedule" })).toBeVisible();
    await expect(player.getByText("Your confirmed academy sessions")).toBeVisible();

    // 9. What the player's own login can reach on the server: their own record only, no staff powers, no fees, no private chat.
    const rows = await rowsOf(await playerApi.get(`/api/workspaces/${aid}/records/player`));
    expect(rows.map((r) => r.name)).toEqual(["Kiran Kumar"]);
    const refused = await playerApi.post(`/api/workspaces/${aid}/records/player`, {
      headers: { Origin: origin },
      data: { name: "Sneaky Kid", birthDate: "2014-03-03", coachId: "x" },
    });
    expect(refused.status()).toBe(403);
    const me = (await (await playerApi.get("/api/auth/get-session")).json()) as { user: { id: string } };
    const chat = await playerApi.post(`/api/workspaces/${aid}/records/conversation`, {
      headers: { Origin: origin },
      data: { playerId: rows[0].id, guardianId: me.user.id, subject: "Hello coach" },
    });
    expect(chat.status()).toBe(403);
    expect((await playerApi.get(`/api/workspaces/${aid}/finance`)).status()).toBe(403);
    // What is written for parents is refused by the server, not only hidden: every such list is empty for this login.
    for (const kind of ["report", "plan", "weekly", "update", "conversation", "dietary"])
      expect(await rowsOf(await playerApi.get(`/api/workspaces/${aid}/records/${kind}`)), kind).toEqual([]);
    expect((await playerApi.get(`/api/workspaces/${aid}/invitations`)).status()).toBe(403);
    for (const action of [
      { action: "playerLink", data: {} },
      { action: "selfPlayerList" },
      { action: "selfPlayerDecide", data: { userId: me.user.id, decision: "approve", consentOnFile: true } },
    ])
      expect(
        (await playerApi.post(`/api/workspaces/${aid}/actions`, { headers: { Origin: origin }, data: action })).status(),
        action.action,
      ).toBe(403);
    expect(
      (
        await playerApi.post(`/api/workspaces/${aid}/actions`, {
          headers: { Origin: origin },
          data: { action: "selfPlayerSubmit", data: { name: "Again", birthDate: "2014-03-03", guardianAware: true } },
        })
      ).status(),
    ).toBe(409);
    expect(errors).toEqual([]);
    await playerContext.close();
    await ownerContext.close();
  } finally {
    await Promise.all(apis.map((client) => client.dispose()));
  }
});
