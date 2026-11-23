// WP2.1: request counts for representative saves. A "full-workspace request" is
// GET /api/workspaces/:academy. Each action records the API requests it makes
// and asserts which reloads remain justified and which were removed.
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { operationalSports } from "../../src/config/sports/workspace-sports";
import type { WorkspacePlayer } from "../../src/domain/workspace";
import type { FootballSession } from "../../src/domain/training";
import type { FinancePayload } from "../../src/domain/finance";
import type { TrialPayload } from "../../src/domain/trial";

type Call = { method: string; path: string };
function recorder(page: Page, academyId: string) {
  const calls: Call[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/") || url.pathname.includes("/api/auth"))
      return;
    calls.push({
      method: request.method(),
      path:
        url.pathname
          .replace(academyId, ":academy")
          .replace(/\/[0-9a-f-]{36}$/, "/:id") +
        url.search.replace(/[0-9a-f-]{36}/, ":id"),
    });
  });
  return {
    async during(action: () => Promise<void>) {
      await page.waitForLoadState("networkidle");
      const start = calls.length;
      await action();
      await page.waitForLoadState("networkidle");
      // A refetch triggered by the response can start after networkidle.
      await page.waitForTimeout(1200);
      return calls.slice(start);
    },
    /** Reduced-payload reads (GET ...?kinds=a,b), by path. */
    profileLoads: (made: Call[]) =>
      made
        .filter(
          (c) =>
            c.method === "GET" &&
            c.path.startsWith("/api/workspaces/:academy?kinds="),
        )
        .map((c) => c.path),
    /** Reads of the academy payload, whole or reduced to some record kinds. */
    payloadReads: (made: Call[]) =>
      made.filter(
        (c) =>
          c.method === "GET" &&
          (c.path === "/api/workspaces/:academy" ||
            c.path.startsWith("/api/workspaces/:academy?kinds=")),
      ).length,
    fullReloads: (made: Call[]) =>
      made.filter(
        (c) => c.method === "GET" && c.path === "/api/workspaces/:academy",
      ).length,
    count: (made: Call[], method: string, path: string) =>
      made.filter((c) => c.method === method && c.path === path).length,
  };
}

test("WP2.1/WP2.3 saves reload the workspace only when it changed; Home needs no full payload", async ({
  playwright,
  browser,
}, testInfo) => {
  test.setTimeout(300000);
  const origin = String(testInfo.project.use.baseURL),
    suffix = crypto.randomUUID(),
    password = `Synthetic-only-${crypto.randomUUID()}`;
  const api = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const signUp = await api.post("/api/auth/sign-up/email", {
    data: {
      name: "Wp2 Request Owner",
      email: `wp2-${suffix}@example.test`,
      password,
    },
  });
  expect(signUp.status(), await signUp.text()).toBe(200);
  const ownerId = (await signUp.json()).user.id as string;
  async function post<T>(
    api: APIRequestContext,
    path: string,
    data: unknown,
    expected = 200,
  ) {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(expected);
    return (await response.json()) as T;
  }
  const academy = await post<{ id: string }>(
    api,
    "/api/workspaces",
    {
      name: "WP2 Request QA Academy",
      contactEmail: "wp2-requests@example.test",
      country: "IN",
      language: "English",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      ageGroups: ["U12"],
      demo: false,
    },
    201,
  );
  const root = `/api/workspaces/${academy.id}`;
  const branch = await post<{ id: string }>(
    api,
    `${root}/records/branch`,
    { name: "WP2 Branch", timezone: "Asia/Kolkata" },
    201,
  );
  const drill = await post<{ id: string }>(
    api,
    `${root}/records/drill`,
    {
      ...operationalSports.football.templates[0],
      category: "ball-control-dribbling",
      sportId: "football",
    },
    201,
  );
  const players: WorkspacePlayer[] = [];
  for (const name of ["Wp2 Player One", "Wp2 Player Two"])
    players.push(
      await post<WorkspacePlayer>(
        api,
        `${root}/records/player`,
        { name, birthDate: "2015-05-05", squad: "WP2 Batch", coachId: ownerId },
        201,
      ),
    );
  const squad = await post<{ id: string }>(api, `${root}/training`, {
    requestId: crypto.randomUUID(),
    action: "squad",
    data: {
      name: "WP2 Batch",
      branchId: branch.id,
      playerIds: players.map((p) => p.id),
    },
  });
  for (const player of players) {
    const current = (await (
      await api.get(`${root}/records/player/${player.id}`)
    ).json()) as WorkspacePlayer;
    const placed = await api.put(`${root}/records/player/${player.id}`, {
      data: {
        ...current,
        squadId: squad.id,
        squad: "WP2 Batch",
        placementReviewed: true,
        expectedVersion: current.recordVersion,
      },
    });
    expect(placed.status(), await placed.text()).toBe(200);
  }
  // A scheduled session two days ago in the academy's time zone, so the
  // attendance desk can be used.
  const local = (offsetDays: number, time: string) => {
    const day = new Date(Date.now() + offsetDays * 86400000);
    return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(day)}T${time}`;
  };
  let session = await post<FootballSession>(api, `${root}/training`, {
    requestId: crypto.randomUUID(),
    action: "session",
    data: {
      branchId: branch.id,
      squadId: squad.id,
      location: "WP2 ground",
      coachIds: [ownerId],
      timezone: "Asia/Kolkata",
      startLocal: local(-2, "17:00"),
      endLocal: local(-2, "18:00"),
      theme: "WP2 passing",
      agenda: [{ drillId: drill.id, duration: 15 }],
    },
  });
  session = await post<FootballSession>(api, `${root}/training`, {
    requestId: crypto.randomUUID(),
    action: "status",
    id: session.id,
    expectedVersion: session.version,
    data: { status: "SCHEDULED" },
  });

  const context = await browser.newContext({
      storageState: await api.storageState(),
      viewport: { width: 1536, height: 1024 },
    }),
    page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A screen that reads a record kind its payload did not load logs this.
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("did not load"))
      errors.push(message.text());
  });
  const log = recorder(page, academy.id);
  const route = `/workspace/${academy.id}`;
  const results: Record<string, Call[]> = {};
  const profileLoads = log.profileLoads;
  const dialog = () => page.getByRole("dialog");

  // WP2.3: Home opens from the bootstrap and the Home summary. The full
  // academy payload is not requested.
  results.homeOpen = await log.during(async () => {
    await page.goto(route);
    await page.locator(".portal-home-page h1").waitFor();
    await expect(page.getByText("Active players")).toBeVisible();
  });
  expect(log.fullReloads(results.homeOpen)).toBe(0);
  // The server page already authorised the viewer and hands the portal its
  // bootstrap, so there is no bootstrap request at all.
  expect(
    log.count(results.homeOpen, "GET", "/api/workspaces/:academy/bootstrap"),
  ).toBe(0);
  expect(
    log.count(results.homeOpen, "GET", "/api/workspaces/:academy/home"),
  ).toBe(1);
  expect(
    log.count(results.homeOpen, "GET", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  await expect(
    page.locator(".portal-stat").filter({ hasText: "Active players" }),
  ).toContainText("2");
  await expect(
    page.locator(".portal-stat").filter({ hasText: "Active batches" }),
  ).toContainText("1");

  // Another screen needs the full payload: it is requested then, once.
  results.openPlayers = await log.during(async () => {
    await page
      .getByRole("navigation", { name: "Academy navigation" })
      .getByRole("button", { name: "Players", exact: true })
      .click();
    await page.getByRole("heading", { name: "Players", exact: true }).waitFor();
  });
  expect(log.payloadReads(results.openPlayers)).toBe(1);
  expect(
    log.count(results.openPlayers, "GET", "/api/workspaces/:academy/bootstrap"),
  ).toBe(0);

  // Player edit: the player is workspace data, so one reload is justified.
  await page.goto(`${route}?section=players&player=${players[0].id}`);
  await page.locator(".portal-player-detail").waitFor();
  results.editPlayer = await log.during(async () => {
    await page
      .locator(".portal-player-detail")
      .getByRole("button", { name: "Edit player", exact: true })
      .click();
    await dialog()
      .getByLabel("Player name", { exact: true })
      .fill("Wp2 Player One Edited");
    await dialog()
      .getByRole("button", { name: "Save player", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
  });
  expect(log.payloadReads(results.editPlayer)).toBe(1);
  expect(
    log.count(
      results.editPlayer,
      "PUT",
      "/api/workspaces/:academy/records/player/:id",
    ),
  ).toBe(1);
  await expect(page.locator(".portal-player-detail")).toContainText(
    "Wp2 Player One Edited",
  );

  // The fee account depends on players, sessions and trials, so after that
  // save the in-app move to Fees refetches it; moving between unchanged
  // screens reuses what is fresh.
  const goTo = (name: string) =>
    page
      .getByRole("navigation", { name: "Academy navigation" })
      .getByRole("button", { name, exact: true })
      .click();
  results.feesAfterSave = await log.during(async () => {
    await goTo("Fees");
    await page
      .getByRole("button", { name: "Fee plans", exact: true })
      .waitFor();
  });
  expect(
    log.count(results.feesAfterSave, "GET", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  expect(profileLoads(results.feesAfterSave)).toEqual([
    "/api/workspaces/:academy?kinds=player,squad",
  ]);
  results.feesAgain = await log.during(async () => {
    await goTo("More");
    await page.getByRole("tabpanel").waitFor();
    await goTo("Fees");
    await page
      .getByRole("button", { name: "Fee plans", exact: true })
      .waitFor();
  });
  // Money data is fetched again whenever Fees reopens (sensitive); the
  // players and batches it lists are reused, so only finance is requested.
  expect(
    log.count(results.feesAgain, "GET", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  expect(
    profileLoads(results.feesAgain).filter((p) => p.endsWith("player,squad")),
  ).toEqual([]);

  // Opening a session reads its attendance and evidence once each; they are
  // not part of the academy payload.
  results.openSession = await log.during(async () => {
    await page.goto(`${route}?section=training&session=${session.id}`);
    await page.locator(".pt-actions").waitFor();
  });
  const attendancePath =
      "/api/workspaces/:academy/records/attendance?session=:id",
    evidencePath =
      "/api/workspaces/:academy/records/evidence?session=:id&compare=1";
  expect(log.count(results.openSession, "GET", attendancePath)).toBe(1);
  expect(log.count(results.openSession, "GET", evidencePath)).toBe(1);
  expect(profileLoads(results.openSession).join()).not.toMatch(
    /attendance|evidence/,
  );
  // Attendance: session data changes, so one reload is justified.
  results.attendance = await log.during(async () => {
    await page
      .locator(".pt-actions")
      .getByRole("button", { name: "Mark attendance", exact: true })
      .click();
    const desk = page.getByRole("dialog", {
      name: "Session desk",
      exact: true,
    });
    await desk
      .getByRole("combobox", { name: /attendance/ })
      .first()
      .selectOption("PRESENT");
    await desk
      .getByRole("button", { name: "Save attendance", exact: true })
      .click();
  });
  expect(log.payloadReads(results.attendance)).toBe(1);
  // The saved mark is read again for the open session, once, and the mark is
  // the one that was saved.
  expect(log.count(results.attendance, "GET", attendancePath)).toBe(1);
  const saved = (await (
    await api.get(`${root}/records/attendance?session=${session.id}`)
  ).json()) as { status: string }[];
  expect(saved.some((mark) => mark.status === "PRESENT")).toBe(true);

  // Session creation: one reload.
  await page.goto(`${route}?section=training&create=session`);
  await dialog().waitFor();
  results.createSession = await log.during(async () => {
    await dialog()
      .getByLabel("Training batch", { exact: true })
      .selectOption(squad.id);
    await dialog()
      .getByLabel("Session date", { exact: true })
      .fill(local(10, "17:00").slice(0, 10));
    await dialog().getByLabel("Start time", { exact: true }).fill("17:00");
    await dialog()
      .getByRole("button", { name: "Save session draft", exact: true })
      .click();
  });
  expect(log.payloadReads(results.createSession)).toBe(1);

  // Finance plan: finance tables only. No workspace reload; the fee account
  // is refetched and shows the new plan.
  // Fees reads only players and batches: it loads those two kinds, not the
  // academy payload.
  results.openFees = await log.during(async () => {
    await page.goto(`${route}?section=fees`);
    await page
      .getByRole("button", { name: "Fee plans", exact: true })
      .waitFor();
  });
  expect(log.fullReloads(results.openFees)).toBe(0);
  expect(profileLoads(results.openFees)).toEqual([
    "/api/workspaces/:academy?kinds=player,squad",
  ]);
  expect(
    log.count(results.openFees, "GET", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  await page.getByRole("button", { name: "Fee plans", exact: true }).click();
  results.financePlan = await log.during(async () => {
    await page
      .getByRole("button", { name: "Create fee plan", exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "Create fee plan",
      exact: true,
    });
    await form
      .getByLabel("Plan name", { exact: true })
      .fill("WP2 monthly plan");
    await form
      .getByLabel("Billing frequency", { exact: true })
      .selectOption("MONTHLY");
    await form
      .getByLabel("Applicable start date", { exact: true })
      .fill(local(0, "00:00").slice(0, 10));
    await form.getByLabel(/^Amount/).fill("1500");
    await form
      .getByRole("button", { name: "Save fee plan", exact: true })
      .click();
    await form.waitFor({ state: "hidden" });
  });
  expect(log.fullReloads(results.financePlan)).toBe(0);
  expect(profileLoads(results.financePlan)).toEqual([]);
  expect(
    log.count(results.financePlan, "POST", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  expect(
    log.count(results.financePlan, "GET", "/api/workspaces/:academy/finance"),
  ).toBe(1);
  expect(
    ((await (await api.get(`${root}/finance`)).json()) as FinancePayload).plans,
  ).toHaveLength(1);
  await expect(page.getByText("WP2 monthly plan").first()).toBeVisible();

  // Trial rules: trial data only.
  await page.goto(`${route}?section=players&player=${players[1].id}`);
  const region = page.getByRole("region", {
    name: "Trial enrolment",
    exact: true,
  });
  await region.waitFor();
  results.trialRules = await log.during(async () => {
    await region
      .getByRole("button", { name: "Academy trial rules", exact: true })
      .click();
    const rules = page.getByRole("dialog", {
      name: "Academy trial rules",
      exact: true,
    });
    await rules
      .getByLabel("Default trial duration in days (optional)", { exact: true })
      .fill("10");
    await rules
      .getByRole("button", { name: "Save trial rules", exact: true })
      .click();
    await rules.waitFor({ state: "hidden" });
  });
  expect(log.fullReloads(results.trialRules)).toBe(0);
  expect(
    log.count(results.trialRules, "POST", "/api/workspaces/:academy/trials"),
  ).toBe(1);
  expect(
    log.count(
      results.trialRules,
      "GET",
      "/api/workspaces/:academy/trials?player=:id",
    ),
  ).toBe(1);
  expect(
    ((await (await api.get(`${root}/trials`)).json()) as TrialPayload).policy
      .defaultDurationDays,
  ).toBe(10);

  // Trial creation changes the player's status: one reload is justified.
  results.trialCreate = await log.during(async () => {
    await region
      .getByRole("button", { name: "Create trial enrolment", exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "Create trial enrolment",
      exact: true,
    });
    await form
      .getByRole("button", { name: "Save trial enrolment", exact: true })
      .click();
    await form.waitFor({ state: "hidden" });
  });
  expect(log.payloadReads(results.trialCreate)).toBe(1);
  expect(
    log.count(
      results.trialCreate,
      "GET",
      "/api/workspaces/:academy/trials?player=:id",
    ),
  ).toBe(1);
  const afterCreate = (await (
    await api.get(`${root}/records/player/${players[1].id}`)
  ).json()) as WorkspacePlayer;
  expect(afterCreate.status).toBe("TRIAL");
  await expect(page.locator(".portal-player-detail")).toContainText(/trial/i);

  // Trial conversion changes the player's status back: one reload.
  results.trialConvert = await log.during(async () => {
    await region
      .getByText("Trial records and actions", { exact: true })
      .click();
    await region
      .getByRole("button", {
        name: "Convert to regular enrolment",
        exact: true,
      })
      .click();
    const form = page.getByRole("dialog", {
      name: "Convert to regular enrolment",
      exact: true,
    });
    await form
      .getByLabel("Decision reason")
      .fill("WP2 request-count conversion");
    await form.getByRole("checkbox").check();
    await form
      .getByRole("button", {
        name: "Convert to regular enrolment",
        exact: true,
      })
      .click();
    await form.waitFor({ state: "hidden" });
  });
  expect(log.payloadReads(results.trialConvert)).toBe(1);
  const afterConvert = (await (
    await api.get(`${root}/records/player/${players[1].id}`)
  ).json()) as WorkspacePlayer;
  expect(afterConvert.status).toBe("ACTIVE");

  // Settings (staff) and Calendar load only the record kinds they read.
  results.openSettings = await log.during(async () => {
    await page.goto(`${route}?section=settings&tab=academy`);
    await page.getByRole("tabpanel").waitFor();
  });
  expect(log.fullReloads(results.openSettings)).toBe(0);
  expect(profileLoads(results.openSettings)).toEqual([
    "/api/workspaces/:academy?kinds=branch,player,program,squad,venue",
  ]);
  results.openCalendar = await log.during(async () => {
    await page.goto(`${route}?section=calendar`);
    await page.getByRole("heading", { name: "Calendar" }).first().waitFor();
  });
  expect(log.fullReloads(results.openCalendar)).toBe(0);
  expect(profileLoads(results.openCalendar)).toHaveLength(1);
  // Attendance and evidence are read for an open session, never with the
  // sessions of the whole academy.
  expect(profileLoads(results.openCalendar)).toEqual([
    // `closure` is new with P1-08: the calendar shows closed days. Still one
    // reduced read, and still no attendance or evidence.
    "/api/workspaces/:academy?kinds=branch,closure,drill,plan,player,series,session,squad,venue",
  ]);
  expect(
    results.openCalendar.filter(
      (c) =>
        c.path.includes("/records/attendance") ||
        c.path.includes("/records/evidence"),
    ),
  ).toEqual([]);

  // Communication: opening fetches once; its own command refetches it once
  // and does not reload the workspace.
  results.communicationOpen = await log.during(async () => {
    await page.goto(`${route}?section=settings&tab=notifications`);
    await page
      .getByRole("button", { name: "Save communication settings" })
      .waitFor();
  });
  expect(
    log.count(
      results.communicationOpen,
      "GET",
      "/api/workspaces/:academy/communication",
    ),
  ).toBe(1);
  results.communicationCommand = await log.during(async () => {
    await page.getByLabel("Enable schedules").check();
    await page
      .getByRole("button", { name: "Save communication settings" })
      .click();
  });
  expect(log.fullReloads(results.communicationCommand)).toBe(0);
  expect(
    log.count(
      results.communicationCommand,
      "POST",
      "/api/workspaces/:academy/communication",
    ),
  ).toBe(1);
  expect(
    log.count(
      results.communicationCommand,
      "GET",
      "/api/workspaces/:academy/communication",
    ),
  ).toBe(1);
  expect(
    (
      (await (await api.get(`${root}/communication`)).json()) as {
        settings: { enabled: boolean };
      }
    ).settings.enabled,
  ).toBe(true);
  await expect(page.getByLabel("Enable schedules")).toBeChecked();

  // Academy switch: a second academy makes its own requests for its own id.
  const second = await post<{ id: string }>(
    api,
    "/api/workspaces",
    {
      name: "WP2 Second Academy",
      contactEmail: "wp2-second@example.test",
      country: "IN",
      language: "English",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      ageGroups: ["U12"],
      demo: false,
    },
    201,
  );
  const secondLog = recorder(page, second.id);
  const secondCalls = await secondLog.during(async () => {
    await page.goto(`/workspace/${second.id}`);
    await page.locator(".portal-home-page").waitFor();
  });
  expect(secondLog.fullReloads(secondCalls)).toBe(0);
  expect(
    secondLog.count(secondCalls, "GET", "/api/workspaces/:academy/home"),
  ).toBe(1);
  await expect(page.locator("body")).not.toContainText("Wp2 Player One");

  expect(errors).toEqual([]);
  console.log("WP2.1 requests", JSON.stringify(results, null, 1));
  await context.close();
  await api.dispose();
});
