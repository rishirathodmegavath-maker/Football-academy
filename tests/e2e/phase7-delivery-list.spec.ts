import { test, expect, type APIRequestContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
// Phase 7, in a real browser against the production build:
//  1. the delivery list is read one bounded page at a time (API and screen),
//     with filter, search, empty state and a guardian who sees only their own;
//  2. a screen whose code cannot be fetched (the page was open across an
//     update) shows a message with a Reload button instead of a broken page;
//  3. the fee list's avatar initials are decoration, not text in the page.
test.use({ actionTimeout: 15000 });
test("delivery jobs page through the screen and the API, a missing screen chunk recovers, avatars are decoration", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  // Sign-up is limited per address for the whole run: let the window clear
  // before and after this spec (see phase6-finance.spec.ts).
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID().slice(0, 8);
  async function account(name: string) {
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name}-${suffix}@example.test`;
    const r = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(r.status(), await r.text()).toBe(200);
    return { api, email, id: (await r.json()).user.id as string };
  }
  const post = async <T>(
    api: APIRequestContext,
    path: string,
    data: unknown,
    status = 200,
  ) => {
    const r = await api.post(path, { data });
    expect(r.status(), await r.text()).toBe(status);
    return r.json() as Promise<T>;
  };
  const owner = await account("JobsOwner");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const parent = await account("JobsParent");
  const academy = await post<{ id: string }>(
    owner.api,
    "/api/workspaces",
    {
      name: "Jobs Check Academy",
      contactEmail: "jobs@example.test",
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
  const child = (
    await post<{ id: string }>(
      owner.api,
      `${root}/records/player`,
      { birthDate: "2015-05-05", name: "Fictional Jobs Child", squad: "U12", coachId: owner.id },
      201,
    )
  ).id;
  const invite = await post<{ token: string }>(owner.api, `${root}/actions`, {
    action: "invite",
    data: {
      email: parent.email,
      role: "PARENT",
      playerIds: [child],
      guardianVerified: true,
    },
  });
  await post(parent.api, "/api/invitations/accept", { token: invite.token });
  await post(owner.api, `${root}/finance`, {
    requestId: crypto.randomUUID(),
    action: "invoice",
    data: {
      playerId: child,
      label: "Monthly fee",
      chargeMinor: 150000,
      currency: "INR",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      dueDate: "2026-10-20",
    },
  });

  // 60 jobs for the child: 40 to the real parent, 20 to another guardian.
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!);
  db.exec("PRAGMA busy_timeout = 5000");
  const insert = db.prepare(
    "INSERT INTO delivery_jobs(id,academyId,playerId,guardianId,type,sourceId,sourceVersion,period,correction,dueAt,expiresAt,state,attempts,reason) VALUES(?,?,?,?,?,?,1,?,'',?,?,?,1,?)",
  );
  const states = ["DELIVERED", "FAILED", "QUEUED", "READ"];
  db.exec("BEGIN");
  for (let i = 0; i < 60; i++)
    insert.run(
      `job-${suffix}-${String(i).padStart(3, "0")}`,
      academy.id,
      child,
      i < 40 ? parent.id : "someone-else",
      "WEEKLY",
      `source-${i}`,
      `2026-W${String(i).padStart(2, "0")}`,
      new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString(),
      "2030-01-01T00:00:00.000Z",
      states[i % 4],
      i % 4 === 1 ? "Template rejected by provider" : null,
    );
  db.exec("COMMIT");
  db.close();

  // ---- API: bounded pages, walk, filter, search, guardian scope -------------
  const get = async (api: APIRequestContext, query = "") => {
    const r = await api.get(`${root}/communication/jobs${query}`);
    return { status: r.status(), body: await r.json() };
  };
  let page = await get(owner.api);
  expect(page.status).toBe(200);
  expect(page.body.jobs).toHaveLength(25);
  expect(page.body.nextCursor).toBeTruthy();
  const seen = new Set<string>(page.body.jobs.map((j: { id: string }) => j.id));
  while (page.body.nextCursor) {
    page = await get(owner.api, `?cursor=${page.body.nextCursor}`);
    for (const j of page.body.jobs) {
      expect(seen.has(j.id)).toBe(false);
      seen.add(j.id);
    }
  }
  expect(seen.size).toBe(60);
  expect((await get(owner.api, "?limit=101")).status).toBe(400);
  expect((await get(owner.api, "?cursor=garbage")).status).toBe(400);
  const failed = await get(owner.api, "?state=FAILED&limit=100");
  expect(failed.body.jobs).toHaveLength(15);
  const found = await get(owner.api, "?q=rejected&limit=100");
  expect(found.body.jobs).toHaveLength(15);
  const mine = await get(parent.api, "?limit=100");
  expect(mine.status).toBe(200);
  expect(mine.body.jobs).toHaveLength(40);
  expect(
    mine.body.jobs.every(
      (j: { guardianId: string }) => j.guardianId === parent.id,
    ),
  ).toBe(true);
  expect(JSON.stringify(mine.body)).not.toContain("someone-else");

  // ---- screen: 25 at a time, older on request, filter, search ---------------
  const context = await browser.newContext({
    storageState: await owner.api.storageState(),
    viewport: { width: 1280, height: 900 },
  });
  const ownerPage = await context.newPage();
  await ownerPage.goto(
    `/workspace/${academy.id}?section=messages&player=${child}`,
  );
  await ownerPage.getByText("Delivery and approval details").click();
  const list = ownerPage.locator(".delivery-jobs");
  await expect(
    list.getByText(/Showing 25 notifications, newest first/),
  ).toBeVisible();
  await expect(list.locator(".list-row")).toHaveCount(25);
  await list.getByRole("button", { name: "Show older notifications" }).click();
  await expect(list.locator(".list-row")).toHaveCount(50);
  await list.getByRole("button", { name: "Show older notifications" }).click();
  await expect(list.locator(".list-row")).toHaveCount(60);
  await expect(list.getByText(/That is all of them/)).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Show older notifications" }),
  ).toHaveCount(0);
  await list.getByLabel("Status").selectOption("FAILED");
  await expect(list.locator(".list-row")).toHaveCount(15);
  await list.getByLabel("Status").selectOption("");
  await list.getByLabel("Search notifications").fill("2026-W07");
  await expect(list.locator(".list-row")).toHaveCount(1);
  await list.getByLabel("Search notifications").fill("no such thing");
  await expect(
    list.getByText("No notifications match these filters."),
  ).toBeVisible();
  // a failed read shows an error with a retry, not a blank list
  await ownerPage.route("**/communication/jobs**", (route) => route.abort());
  await list.getByLabel("Search notifications").fill("2026");
  await expect(list.getByRole("alert")).toBeVisible();
  await ownerPage.unroute("**/communication/jobs**");
  await list.getByRole("button", { name: "Try again" }).click();
  await expect(list.locator(".list-row").first()).toBeVisible();

  // ---- a screen whose code file cannot be fetched --------------------------
  const stale = await browser.newContext({
    storageState: await owner.api.storageState(),
    viewport: { width: 1280, height: 900 },
  });
  const sp = await stale.newPage();
  // no background prefetch: the Fees code must be fetched when Fees is opened
  await sp.addInitScript(() =>
    Object.defineProperty(navigator, "connection", {
      value: { saveData: true },
      configurable: true,
    }),
  );
  await sp.goto(`/workspace/${academy.id}`);
  await expect(sp.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await sp.route("**/_next/static/chunks/**", (route) => route.abort());
  await sp.getByRole("button", { name: "Fees", exact: true }).click();
  await expect(sp.getByText("This screen could not be loaded")).toBeVisible();
  await sp.unroute("**/_next/static/chunks/**");
  await sp.getByRole("button", { name: "Reload the page" }).click();
  await expect(
    sp.getByRole("heading", { name: "Fees", level: 1 }),
  ).toBeVisible();

  // ---- avatars are decoration: no text, and the control is named by the person
  const row = sp.locator(".pf-player-button").first();
  await expect(row).toBeVisible();
  await expect(row.locator(".avatar")).toHaveText("");
  await expect(row.locator(".avatar")).toHaveAttribute("data-initials", "FJ");
  await expect(row).toHaveAccessibleName(
    /Open Fictional Jobs Child Monthly fee fee details/,
  );
  await stale.close();
  await context.close();
  await new Promise((resolve) => setTimeout(resolve, 11000));
});
