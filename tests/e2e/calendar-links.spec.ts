import { test, expect, type APIRequestContext } from "@playwright/test";
import type { WorkspacePlayer } from "../../src/domain/workspace";
import type { FootballSession, FootballSquad } from "../../src/domain/training";

// Free calendar links and "tell everyone", in a real browser against the real server. A private calendar link shows each
// person only their own sessions with the drills; a parent cannot ask who to tell; the screens offer the free buttons.
test("calendar links follow the sessions, and the session panel offers the free send buttons", async ({
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
    return { api, name, email, password, id: (await response.json()).user.id as string };
  }
  async function post<T>(api: APIRequestContext, path: string, data: unknown, status = 200): Promise<T> {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(status);
    return response.json() as Promise<T>;
  }
  try {
    const owner = await account("CalOwner");
    const coach = await account("CalCoach");
    const parent = await account("CalParent");
    const academy = await post<{ id: string }>(
      owner.api,
      "/api/workspaces",
      {
        name: "Synthetic Calendar Academy",
        contactEmail: "calendar-academy@example.test",
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
    const save = <T>(kind: string, data: unknown) => post<T>(owner.api, `${root}/records/${kind}`, data, 201);
    const command = <T>(action: string, data: unknown, id?: string, expectedVersion = 0) =>
      post<T>(owner.api, `${root}/training`, { requestId: crypto.randomUUID(), action, data, id, expectedVersion });
    const invite = async (who: typeof coach, data: Record<string, unknown>) => {
      const invitation = await post<{ token: string }>(owner.api, `${root}/actions`, {
        action: "invite",
        verified: true,
        data: { email: who.email, ...data },
      });
      await post(who.api, "/api/invitations/accept", { token: invitation.token });
    };
    await invite(coach, { role: "COACH" });
    const branch = await save<{ id: string }>("branch", { name: "Calendar Branch", timezone: "Asia/Kolkata" });
    const drill = await save<{ id: string }>("drill", {
      sportId: "football",
      name: "Synthetic passing squares",
      category: "ball-control-dribbling",
      focusArea: "Passing",
      purpose: "Pass accurately under light pressure",
      cue: "Open body, first touch away from pressure",
    });
    const player = await save<WorkspacePlayer>("player", {
      name: "Zorro Calendarkid",
      squad: "U10 Calendar",
      coachId: coach.id,
      ageCategory: "U10",
      birthDate: "2015-05-05",
      sportIds: ["football"],
    });
    const batch = await command<FootballSquad>("squad", {
      name: "U10 Calendar",
      branchId: branch.id,
      playerIds: [player.id],
    });
    await invite(parent, { role: "PARENT", playerIds: [player.id], guardianVerified: true });
    const draft = await command<FootballSession>("session", {
      branchId: branch.id,
      squadId: batch.id,
      timezone: "Asia/Kolkata",
      startLocal: "2032-10-20T16:15",
      endLocal: "2032-10-20T17:45",
      coachIds: [coach.id],
      location: "Synthetic calendar ground",
      theme: "",
      agenda: [{ drillId: drill.id, duration: 20 }],
    });
    const session = await command<FootballSession>("status", { status: "SCHEDULED" }, draft.id, draft.version);

    // 1. Each person's private link shows only what the app already shows them.
    const link = async (who: { api: APIRequestContext }) =>
      (await post<{ token: string }>(who.api, `${root}/actions`, { action: "calendarLink" })).token;
    const anonymous = await playwright.request.newContext({ baseURL: origin });
    apis.push(anonymous);
    const read = async (token: string) => anonymous.get(`/api/calendar/${token}.ics`);
    const coachFeed = await read(await link(coach));
    expect(coachFeed.status()).toBe(200);
    expect(coachFeed.headers()["content-type"]).toContain("text/calendar");
    // Long lines are wrapped in a calendar file (RFC 5545): join them again before reading.
    const unfold = (text: string) => text.split(String.fromCharCode(13, 10, 32)).join("");
    const coachText = unfold(await coachFeed.text());
    expect(coachText).toContain(`UID:${session.id}@sportozen`);
    expect(coachText).toContain("Synthetic passing squares (20 min)");
    expect(coachText).toContain("Synthetic calendar ground");
    expect(coachText).not.toContain("Zorro");
    const parentText = unfold(await (await read(await link(parent))).text());
    expect(parentText).toContain(`UID:${session.id}@sportozen`);
    expect(parentText).toContain("Zorro");
    expect(parentText).not.toContain("Calendarkid");
    expect((await read("x".repeat(43))).status()).toBe(404);
    const stale = await link(owner),
      fresh = await link(owner);
    expect((await read(stale)).status()).toBe(404);
    expect((await read(fresh)).status()).toBe(200);

    // 2. Who to tell: the coach and the parent; a parent cannot ask.
    type Share = { people: { role: string; email: string; phone: string | null }[] };
    const share = await post<Share>(owner.api, `${root}/actions`, { action: "sessionShare", id: session.id });
    expect(share.people.map((p) => p.role)).toEqual(["COACH", "PARENT"]);
    expect(share.people.every((p) => p.email.includes("@"))).toBe(true);
    await post(parent.api, `${root}/actions`, { action: "sessionShare", id: session.id }, 403);

    // 3. The screens: the calendar link card, the add-to-calendar buttons and the free send list.
    const context = await browser.newContext({ baseURL: origin, storageState: await owner.api.storageState() });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`/workspace/${aid}?section=calendar&date=2032-10-20&view=Week&session=${session.id}`);
    await page.getByText("My calendar link (free)").click();
    await page.getByRole("button", { name: "Make my calendar link" }).click();
    await expect(page.getByLabel("Calendar link")).toHaveValue(/\/api\/calendar\/[\w-]{43}\.ics$/);
    await expect(page.getByRole("link", { name: "Open in my calendar app" })).toHaveAttribute("href", /^webcal:\/\//);
    await expect(page.getByRole("link", { name: "Add to Google Calendar", exact: true })).toHaveAttribute("href", /calendar\.google\.com\/calendar\/r\?cid=webcal/);
    await expect(page.getByRole("link", { name: "Google Calendar", exact: true })).toHaveAttribute("href", /calendar\.google\.com\/calendar\/render/);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Apple \/ Outlook file/ }).click();
    expect((await download).suggestedFilename()).toBe("training-session.ics");
    await page.getByRole("button", { name: "Show who to tell" }).click();
    await expect(page.getByRole("link", { name: "Mail" }).first()).toHaveAttribute("href", /^mailto:.*Synthetic%20calendar%20ground/);
    await expect(page.getByRole("button", { name: "Save number" }).first()).toBeVisible();
    expect(pageErrors).toEqual([]);
    await context.close();
  } finally {
    await Promise.all(apis.map((api) => api.dispose()));
  }
});
