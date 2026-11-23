import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
// Drill library: the authenticated catalogue, the library tab inside Training
// (search, the seven categories, detail, customise, create, archive, restore),
// and the picker in the session plan editor. One fictional academy; every
// person and address is fictional.
test.use({ actionTimeout: 15000 });
test("the drill library works end to end for staff and stays closed to everyone else", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(420000);
  // Sign-up is limited to 3 per 10 s: leave a clear window first.
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8);
  type Who = { api: APIRequestContext; email: string; id: string };
  const pageErrors: string[] = [];
  async function account(name: string): Promise<Who> {
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name}-${suffix}@example.test`;
    const r = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(r.status(), await r.text()).toBe(200);
    return { api, email, id: (await r.json()).user.id };
  }
  const call = async <T>(who: Who, path: string, data: unknown, want = 200) => {
    const r = await who.api.post(path, { data });
    expect(r.status(), `${path} ${await r.text()}`).toBe(want);
    return r.json() as Promise<T>;
  };
  const owner = await account("DrillOwner");
  const coach = await account("DrillCoach");
  const parent = await account("DrillParent");
  const academy = await call<{ id: string }>(
    owner,
    "/api/workspaces",
    {
      name: "Drill Check Academy",
      contactEmail: "drills@example.test",
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
    201,
  );
  const root = `/api/workspaces/${academy.id}`;
  const invite = async (who: Who, role: string, playerIds: string[] = []) => {
    const made = await call<{ token: string }>(owner, `${root}/actions`, {
      action: "invite",
      data: {
        email: who.email,
        role,
        playerIds,
        guardianVerified: role === "PARENT",
      },
    });
    await call(who, "/api/invitations/accept", { token: made.token });
  };
  await invite(coach, "COACH");
  const child = await call<{ id: string }>(
    owner,
    `${root}/records/player`,
    { birthDate: "2015-05-05", name: "Fictional Drill Child", squad: "", coachId: coach.id },
    201,
  );
  await invite(parent, "PARENT", [child.id]);
  const branch = await call<{ id: string }>(
    owner,
    `${root}/records/branch`,
    { name: "Drill Branch", timezone: "Asia/Kolkata" },
    201,
  );
  const train = (action: string, data: unknown, extra: object = {}) => ({
    requestId: crypto.randomUUID(),
    action,
    data,
    ...extra,
  });
  const squad = await call<{ id: string }>(
    owner,
    `${root}/training`,
    train("squad", {
      name: "Drill U12",
      branchId: branch.id,
      playerIds: [child.id],
    }),
  );

  // ---- the catalogue route: closed to everyone except staff ---------------------
  const stranger = await playwright.request.newContext({ baseURL: origin });
  expect((await stranger.get(`${root}/drills/catalogue`)).status()).toBe(401);
  expect((await parent.api.get(`${root}/drills/catalogue`)).status()).toBe(403);
  for (const who of [owner, coach]) {
    const response = await who.api.get(`${root}/drills/catalogue`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      drills: { id: string; number: number }[];
      headingPolicy: { headingEnabled: boolean };
    };
    expect(body.drills).toHaveLength(49);
    expect(body.drills.map((d) => d.id)).not.toContain("uni-049");
    expect(body.headingPolicy.headingEnabled).toBe(false);
  }
  // Nobody can write a catalogue id.
  const hijack = await owner.api.put(`${root}/records/drill/uni-008`, {
    data: {
      name: "Hijack",
      category: "passing-combination-play",
      focusArea: "Passing",
      purpose: "Hijack.",
      cue: "Hijack.",
    },
  });
  expect([403, 404]).toContain(hijack.status());

  // ---- the library tab ------------------------------------------------------------
  const newPage = async (who: Who, width = 1440, height = 1000) => {
    const context = await browser.newContext({
      baseURL: origin,
      storageState: await who.api.storageState(),
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height });
    return page;
  };
  const overflow = (page: Page) =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
  const openLibrary = async (page: Page) => {
    await page.goto(`/workspace/${academy.id}?section=training`);
    await page
      .getByRole("navigation", { name: "Training sections" })
      .getByRole("button", { name: "Drill library", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Drill library" })).toBeVisible();
  };
  const cards = (page: Page) => page.locator("article.dl-card");
  const ownerPage = await newPage(owner);
  await openLibrary(ownerPage);
  // The library is a tab inside Training, not a sidebar item.
  await expect(
    ownerPage.getByRole("link", { name: "Drill library", exact: true }),
  ).toHaveCount(0);
  await expect(ownerPage.getByRole("status").filter({ hasText: "Showing 49 of 49" })).toBeVisible();
  await expect(cards(ownerPage)).toHaveCount(49);
  const chips = ownerPage.getByRole("group", { name: "Drill categories" });
  for (const name of [
    "Warm-Up & Activation",
    "Ball Control & Dribbling",
    "Passing & Combination Play",
    "Possession & Small-Sided Games",
    "Shooting, Crossing & Finishing",
    "Defending & Pressing",
    "Fitness, Speed & Goalkeeping",
  ])
    await expect(chips.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  await expect(
    ownerPage.getByText("1 original universal drill is under review and not yet available."),
  ).toBeVisible();

  // Category filter and search.
  await chips.getByRole("button", { name: /Defending & Pressing/ }).click();
  await expect(cards(ownerPage)).toHaveCount(5);
  await chips.getByRole("button", { name: /Warm-Up & Activation/ }).click();
  await expect(cards(ownerPage)).toHaveCount(7);
  await chips.getByRole("button", { name: "All categories" }).click();
  await ownerPage.getByLabel("Search drills").fill("rondo");
  await expect(cards(ownerPage).filter({ hasText: "4v2 Rondos" })).toHaveCount(1);
  await ownerPage.getByLabel("Search drills").fill("heading");
  await expect(ownerPage.getByText("No drills match these filters.")).toBeVisible();
  await ownerPage.getByLabel("Search drills").fill("");
  await ownerPage.getByLabel("Source").selectOption("ACADEMY");
  await expect(cards(ownerPage)).toHaveCount(0);
  await ownerPage.getByLabel("Source").selectOption("all");

  // Detail of the safety-critical drill.
  await ownerPage
    .getByRole("button", { name: "View details for 3-Team Transition Game (2v4 Intense Pressing)" })
    .click();
  const detail = ownerPage.getByRole("dialog");
  await expect(
    detail.getByRole("heading", { name: "3-Team Transition Game (2v4 Intense Pressing)" }),
  ).toBeVisible();
  await expect(detail.getByText("High-intensity group press.")).toBeVisible();
  await expect(detail.getByRole("img").first()).toBeVisible();
  for (const heading of ["Instructions", "Coaching points", "Common mistakes", "Progressions", "Safety", "References"])
    await expect(detail.getByRole("heading", { name: heading })).toBeVisible();
  await expect(detail.getByText(/no sliding tackles/i)).toBeVisible();
  await expect(detail.getByText("for authorised staff only", { exact: false })).toBeVisible();
  expect(await overflow(ownerPage)).toBe(false);
  await ownerPage.screenshot({ path: "docs/screenshots/drill-library-detail-desktop.png" });
  await detail.getByRole("button", { name: "Close drill details" }).click();

  // Drill 13 states its internal minimum age.
  await ownerPage.getByRole("button", { name: "View details for Blindfold Soccer Movements" }).click();
  await expect(ownerPage.getByRole("dialog").getByText(/Minimum age 12/)).toBeVisible();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();

  // Customise a universal drill: one academy copy, never a duplicate.
  await ownerPage.getByRole("button", { name: "View details for Wall-Kicks / Wall Passing" }).click();
  await ownerPage.getByRole("button", { name: "Customise for your academy" }).click();
  await expect(ownerPage.getByRole("dialog").getByText("Academy copy").first()).toBeVisible();
  await expect(ownerPage.getByRole("dialog").getByText(/universal drill is unchanged/)).toBeVisible();
  await ownerPage.getByRole("button", { name: "Edit drill" }).click();
  const form = ownerPage.getByRole("dialog", { name: "Edit academy drill" });
  await form.getByLabel("Drill name").fill("Our wall passing routine");
  await form.getByRole("button", { name: "Save drill" }).click();
  await expect(ownerPage.getByRole("dialog").getByRole("heading", { name: "Our wall passing routine" })).toBeVisible();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();
  const drills = async (who: Who) =>
    (await (await who.api.get(`${root}/records/drill`)).json()) as {
      id: string;
      name: string;
      templateId?: string;
      createdBy?: string;
      status?: string;
      recordVersion: number;
    }[];
  let list = await drills(owner);
  expect(list.filter((d) => d.templateId === "uni-008")).toHaveLength(1);
  expect(list.find((d) => d.templateId === "uni-008")!.name).toBe("Our wall passing routine");
  const catalogueAfter = (await (await owner.api.get(`${root}/drills/catalogue`)).json()) as {
    drills: { id: string; name: string }[];
  };
  expect(catalogueAfter.drills.find((d) => d.id === "uni-008")!.name).toBe("Wall-Kicks / Wall Passing");
  // The universal drill now offers the copy instead of making another.
  await ownerPage.getByRole("button", { name: "View details for Wall-Kicks / Wall Passing" }).click();
  await expect(ownerPage.getByRole("button", { name: "Open your academy copy" })).toBeVisible();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();

  // Create an academy drill; the category is required.
  await ownerPage.getByRole("button", { name: "New academy drill" }).click();
  const create = ownerPage.getByRole("dialog", { name: "New academy drill" });
  await create.getByLabel("Drill name").fill("Fictional corner game");
  await create.getByLabel("Purpose (shown to families)").fill("Practise quick decisions in a small game.");
  await create.getByLabel("Coaching cue (shown to families)").fill("Look up and decide early.");
  // Safety guidance is required for a new drill (Stage 1).
  await create.getByLabel("Safety guidance").fill("Keep the area clear of equipment.");
  await create.getByRole("button", { name: "Create drill" }).click();
  // The browser's own validation stops a missing category.
  await expect(create).toBeVisible();
  await create.getByLabel("Category").selectOption({ label: "Possession & Small-Sided Games" });
  await create.getByRole("button", { name: "Create drill" }).click();
  await expect(
    ownerPage.getByRole("dialog").getByRole("heading", { name: "Fictional corner game" }),
  ).toBeVisible();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();
  await ownerPage.getByLabel("Search drills").fill("corner game");
  await expect(cards(ownerPage)).toHaveCount(1);

  // Archive and restore.
  await ownerPage.getByRole("button", { name: "View details for Fictional corner game" }).click();
  await ownerPage.getByRole("button", { name: "Archive drill" }).click();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();
  await expect(cards(ownerPage)).toHaveCount(0);
  await ownerPage.getByLabel("Show archived").check();
  await expect(cards(ownerPage)).toHaveCount(1);
  await expect(cards(ownerPage).getByText("Archived")).toBeVisible();
  await ownerPage.getByRole("button", { name: "View details for Fictional corner game" }).click();
  await ownerPage.getByRole("button", { name: "Restore drill" }).click();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();
  await ownerPage.getByLabel("Show archived").uncheck();
  await expect(cards(ownerPage)).toHaveCount(1);
  list = await drills(owner);
  const corner = list.find((d) => d.name === "Fictional corner game")!;
  expect(corner.status).toBe("ACTIVE");

  // A coach sees the library but cannot change drills they did not create.
  const coachPage = await newPage(coach);
  await openLibrary(coachPage);
  await expect(cards(coachPage)).toHaveCount(49 + 2);
  await coachPage.getByLabel("Search drills").fill("corner game");
  await coachPage.getByRole("button", { name: "View details for Fictional corner game" }).click();
  await expect(
    coachPage.getByRole("dialog").getByText(/Only the academy owner, an admin, or the coach who created this drill/),
  ).toBeVisible();
  await expect(coachPage.getByRole("button", { name: "Edit drill" })).toHaveCount(0);
  await expect(coachPage.getByRole("button", { name: "Archive drill" })).toHaveCount(0);
  // ... and the server agrees.
  const refused = await coach.api.post(`${root}/actions`, {
    data: { action: "archiveDrill", id: corner.id },
  });
  expect(refused.status()).toBe(403);
  await coachPage.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();

  // ---- the picker in the session plan editor -----------------------------------
  const session = await call<{ id: string; agenda: unknown[] }>(
    owner,
    `${root}/training`,
    train("session", {
      branchId: branch.id,
      squadId: squad.id,
      coachIds: [coach.id],
      timezone: "Asia/Kolkata",
      location: "Synthetic pitch",
      startLocal: "2026-12-20T17:00",
      endLocal: "2026-12-20T18:00",
      agenda: [],
    }),
  );
  await ownerPage.goto(`/workspace/${academy.id}?section=training&session=${session.id}`);
  await ownerPage.getByRole("button", { name: "Add activities", exact: true }).click();
  const planning = ownerPage.getByRole("dialog", { name: "Edit training plan", exact: true });
  await planning.getByRole("button", { name: "Add drills from library" }).click();
  const picker = ownerPage.getByRole("dialog", { name: "Choose drills" });
  await picker.getByLabel("Search drills").fill("wall");
  await picker.getByLabel("Select Wall-Kicks / Wall Passing").check();
  await picker.getByRole("button", { name: "Preview Wall-Kicks / Wall Passing" }).click();
  await expect(picker.getByRole("img").first()).toBeVisible();
  await picker.getByLabel("Search drills").fill("triangles");
  await picker.getByLabel("Select Three-Player Passing Triangles").check();
  await expect(picker.getByRole("status").filter({ hasText: "2 selected" })).toBeVisible();
  await picker.getByRole("button", { name: "Add 2 selected drills" }).click();
  await expect(picker).not.toBeVisible();
  await expect(planning.getByText(/^1\. Wall-Kicks \/ Wall Passing/)).toBeVisible();
  await expect(planning.getByText(/^2\. Three-Player Passing Triangles/)).toBeVisible();
  await expect(planning.getByRole("status").filter({ hasText: /Total drill time: \d+ minutes/ })).toBeVisible();
  await planning.getByRole("button", { name: "Move drill 2 up" }).click();
  await expect(planning.getByText(/^1\. Three-Player Passing Triangles/)).toBeVisible();
  await expect(planning.getByRole("button", { name: "Move drill 1 up" })).toBeDisabled();
  await planning.getByRole("button", { name: "Save session draft", exact: true }).click();
  await expect(planning).not.toBeVisible();
  const saved = (await (await owner.api.get(`${root}/records/session`)).json()) as {
    id: string;
    agenda: { drill: { id: string; ownership: string; content?: unknown }; duration: number; drillVersion: number }[];
  }[];
  const agenda = saved.find((s) => s.id === session.id)!.agenda;
  expect(agenda.map((a) => a.drill.id)).toEqual(["uni-016", "uni-008"]);
  expect(agenda.every((a) => a.drill.ownership === "UNIVERSAL_CATALOGUE")).toBe(true);
  // Stage 1: a saved session holds the COMPLETE drill, not just a reference.
  expect(
    agenda.every(
      (a) =>
        !!(a.drill.content as { steps?: string[] } | undefined)?.steps?.length &&
        !!(a.drill as { snapshot?: unknown }).snapshot,
    ),
  ).toBe(true);
  // The plan list draws each drill's own diagram.
  await expect(ownerPage.locator(".dl-agenda-thumb")).toHaveCount(2);
  await ownerPage.screenshot({ path: "docs/screenshots/drill-library-session-plan.png" });

  // ---- mobile ------------------------------------------------------------------------
  const phone = await newPage(owner, 390, 844);
  await openLibrary(phone);
  expect(await overflow(phone), "library overflows on a phone").toBe(false);
  await phone.getByRole("button", { name: "View details for Shielding the Ball" }).click();
  expect(await overflow(phone), "detail overflows on a phone").toBe(false);
  expect(
    await phone.getByRole("dialog").evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    "dialog overflows on a phone",
  ).toBe(false);
  await phone.screenshot({ path: "docs/screenshots/drill-library-detail-mobile.png" });
  await phone.getByRole("dialog").getByRole("button", { name: "Close drill details" }).click();
  await phone.screenshot({ path: "docs/screenshots/drill-library-list-mobile.png" });

  expect(pageErrors).toEqual([]);
});
