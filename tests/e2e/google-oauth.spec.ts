// Google sign-in in a real browser against a STAND-IN for Google (see
// playwright.google-oauth.config.ts). The test plays Google's consent page and
// returns to Sportozen's callback with a code; the server's token request is
// answered by tests/e2e/helpers/google-stand-in.cjs. Everything else is the
// real application: Better Auth, the database, sessions, the academy checks.
import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const DATABASE = process.env.SPORTOZEN_DATABASE_PATH!;
const SECRET = process.env.GOOGLE_E2E_CLIENT_SECRET!;
const CLIENT_ID = process.env.GOOGLE_E2E_CLIENT_ID!;
const ORIGIN = process.env.BETTER_AUTH_URL!;
const PASSWORD = `Synthetic-only-${randomUUID()}`;

type Claims = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
};
const codeFor = (claims: Claims) =>
  Buffer.from(
    JSON.stringify({ email_verified: true, name: "Google Person", ...claims }),
  ).toString("base64url");
const person = (label: string): Claims => ({
  sub: `g-${randomUUID()}`,
  email: `${label}.${randomUUID().slice(0, 8)}@example.test`,
  name: `Google ${label}`,
});

function db<T>(work: (db: DatabaseSync) => T): T {
  const handle = new DatabaseSync(DATABASE);
  try {
    handle.exec("PRAGMA busy_timeout=5000");
    return work(handle);
  } finally {
    handle.close();
  }
}
const userRows = (email: string) =>
  db((d) =>
    d
      .prepare('SELECT id,emailVerified FROM "user" WHERE email=?')
      .all(email.toLowerCase()),
  );
const accountRows = (userId: string) =>
  db((d) =>
    d
      .prepare(
        "SELECT providerId FROM account WHERE userId=? ORDER BY providerId",
      )
      .all(userId)
      .map((r) => String(r.providerId)),
  );

// Better Auth allows 3 sign-in or sign-up requests per 10 seconds from one address
// (a refused request counts too), so each start waits out the window.
let lastStart = 0;
async function gap() {
  const wait = lastStart + 10500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
}

type Decision = { claims: Claims } | { error: string };
/** Plays Google's consent page for this page: returns to the callback. */
async function playGoogle(page: Page, decide: () => Decision) {
  const seen: URL[] = [];
  await page.route("https://accounts.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    const state = url.searchParams.get("state")!,
      redirect = url.searchParams.get("redirect_uri")!,
      choice = decide();
    await route.fulfill({
      status: 302,
      headers: {
        location:
          "error" in choice
            ? `${redirect}?error=${choice.error}&state=${state}`
            : `${redirect}?code=${codeFor(choice.claims)}&state=${state}`,
      },
    });
  });
  return seen;
}
const googleButton = (page: Page) =>
  page.getByRole("button", { name: "Continue with Google" });
const alertOf = (page: Page) => page.locator("main").getByRole("alert");

async function withGoogle(
  page: Page,
  claims: Claims,
  { expectUrl = /\/workspace/ }: { expectUrl?: RegExp } = {},
) {
  await playGoogle(page, () => ({ claims }));
  await page.goto("/sign-in");
  await gap();
  await googleButton(page).click();
  await expect(page).toHaveURL(expectUrl);
}
async function api(
  context: BrowserContext,
  method: "get" | "post",
  path: string,
  data?: unknown,
) {
  const response: APIResponse = await context.request[method](ORIGIN + path, {
    headers: { origin: ORIGIN, "content-type": "application/json" },
    ...(data === undefined ? {} : { data }),
  });
  let body: Record<string, unknown> | unknown[] = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status(), body: body as Record<string, unknown> };
}
async function signedInPage(browser: Browser, claims: Claims) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await withGoogle(page, claims);
  return { context, page, claims };
}
const academyBody = (name: string) => ({
  name,
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
});
const setLifecycle = (academyId: string, state: string) =>
  db((d) =>
    d
      .prepare(
        "INSERT OR REPLACE INTO academy_lifecycle(academyId,state,version,submissions,updatedAt) VALUES(?,?,9,1,?)",
      )
      .run(academyId, state, new Date().toISOString()),
  );

test.describe.configure({ mode: "serial" });

test("a new person signs in with Google, signs out, and signs in again to the same account", async ({
  page,
}) => {
  const me = person("newcomer");
  // Everything the browser is sent while this happens, for the secret check.
  const texts: string[] = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (response.url().startsWith(ORIGIN) && /html|javascript|json/.test(type))
      texts.push(await response.text().catch(() => ""));
  });
  const consent = await playGoogle(page, () => ({ claims: me }));
  await page.goto("/sign-in");
  await expect(googleButton(page)).toBeEnabled();
  await gap();
  await googleButton(page).click();
  await expect(page).toHaveURL(/\/workspace/);
  // Google's address carried the right settings.
  expect(consent).toHaveLength(1);
  const q = consent[0]!.searchParams;
  expect(q.get("client_id")).toBe(CLIENT_ID);
  expect(q.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("prompt")).toBe("select_account");
  expect(consent[0]!.toString()).not.toContain(SECRET);
  // Signed in, with no academy and no authority.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Onboard an academy" }),
  ).toBeVisible();
  const [row] = userRows(me.email);
  expect(userRows(me.email)).toHaveLength(1);
  expect(Number(row!.emailVerified)).toBe(1);
  expect(accountRows(String(row!.id))).toEqual(["google"]);
  expect(
    db(
      (d) =>
        d
          .prepare(
            "SELECT COUNT(*) AS n FROM academy_memberships WHERE userId=?",
          )
          .get(String(row!.id))!.n,
    ),
  ).toBe(0);
  // The secret was never in anything the browser received.
  expect(texts.join("\n")).not.toContain(SECRET);
  // Sign out, then Google again: the same account. (Let the page finish
  // loading first: a click before hydration does nothing.)
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in/);
  await gap();
  await googleButton(page).click();
  await expect(page).toHaveURL(/\/workspace/);
  expect(userRows(me.email)).toHaveLength(1);
  expect(accountRows(String(row!.id))).toEqual(["google"]);
});

test("an existing e-mail and password account with a verified address is linked, and its password still works", async ({
  page,
  context,
}) => {
  const me = person("verified");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill(me.name!);
  await page.getByLabel("Email").fill(me.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await gap();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/workspace/);
  const [row] = userRows(me.email);
  db((d) =>
    d.prepare('UPDATE "user" SET emailVerified=1 WHERE email=?').run(me.email),
  );
  await context.clearCookies();
  await withGoogle(page, me);
  expect(userRows(me.email)).toHaveLength(1);
  expect(accountRows(String(row!.id))).toEqual(["credential", "google"]);
  // The password was not touched.
  await context.clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(me.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await gap();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace/);
});

test("an existing account whose address is NOT verified is not linked, and the screen says what to do", async ({
  page,
  context,
}) => {
  const me = person("unverified");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill(me.name!);
  await page.getByLabel("Email").fill(me.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await gap();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/workspace/);
  const [row] = userRows(me.email);
  const hashBefore = db((d) =>
    String(
      d
        .prepare(
          "SELECT password FROM account WHERE userId=? AND providerId='credential'",
        )
        .get(String(row!.id))!.password,
    ),
  );
  await context.clearCookies();
  await withGoogle(page, me, { expectUrl: /\/sign-in/ });
  await expect(alertOf(page)).toContainText("already exists");
  await expect(alertOf(page)).toContainText("has not been confirmed");
  await expect(alertOf(page)).toContainText("email and password");
  // Not signed in, nothing linked, nothing verified, password untouched.
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in/);
  expect(userRows(me.email)).toHaveLength(1);
  expect(Number(userRows(me.email)[0]!.emailVerified)).toBe(0);
  expect(accountRows(String(row!.id))).toEqual(["credential"]);
  expect(
    db((d) =>
      String(
        d
          .prepare(
            "SELECT password FROM account WHERE userId=? AND providerId='credential'",
          )
          .get(String(row!.id))!.password,
      ),
    ),
  ).toBe(hashBefore);
  // The password still signs in.
  await page.getByLabel("Email").fill(me.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await gap();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace/);
});

test("cancelling at Google returns to the sign-in screen with a clear message and no session", async ({
  page,
}) => {
  await playGoogle(page, () => ({ error: "access_denied" }));
  await page.goto("/sign-in");
  await gap();
  await googleButton(page).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(alertOf(page)).toContainText("Google sign-in was cancelled");
  // The address was cleaned, and the e-mail form is ready.
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel("Email")).toBeEnabled();
  await expect(googleButton(page)).toBeEnabled();
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("a forged or stale callback address is turned away without signing anyone in", async ({
  page,
  request,
}) => {
  const before = db((d) =>
    Number(d.prepare('SELECT COUNT(*) AS n FROM "user"').get()!.n),
  );
  await page.goto(
    `/api/auth/callback/google?code=${codeFor(person("forged"))}&state=forged-state`,
  );
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(alertOf(page)).toContainText("could not be completed");
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in/);
  // Text in the address is never shown.
  await page.goto(
    "/sign-in?source=google&error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
  );
  await expect(alertOf(page)).toContainText("could not be completed");
  await expect(page.locator('main img[src="x"], main [onerror]')).toHaveCount(
    0,
  );
  expect(
    db((d) => Number(d.prepare('SELECT COUNT(*) AS n FROM "user"').get()!.n)),
  ).toBe(before);
  await gap();
  // The start request must come from this application's pages.
  const foreign = await request.post("/api/auth/sign-in/social", {
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    data: { provider: "google", callbackURL: "/workspace" },
  });
  expect(foreign.status()).toBe(403);
});

test("a person who uses two-step verification must use their password and code, not Google", async ({
  page,
  context,
}) => {
  const me = person("twostep");
  await withGoogle(page, me);
  db((d) =>
    d
      .prepare('UPDATE "user" SET twoFactorEnabled=1 WHERE email=?')
      .run(me.email),
  );
  await context.clearCookies();
  await withGoogle(page, me, { expectUrl: /\/sign-in/ });
  await expect(alertOf(page)).toContainText("two-step verification");
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("owner, coach and parent all sign in with Google and get only what their academy gives them", async ({
  browser,
}) => {
  const owner = await signedInPage(browser, person("owner"));
  // A Google owner starts an academy: it is NOT approved yet, so nothing operational works.
  const created = await api(
    owner.context,
    "post",
    "/api/workspaces",
    academyBody("Google Academy"),
  );
  expect(created.status).toBe(201);
  const id = String(created.body.id);
  const branch = (c: BrowserContext, academy = id) =>
    api(c, "post", `/api/workspaces/${academy}/records/branch`, {
      name: "Main",
      timezone: "Asia/Kolkata",
    });
  expect((await branch(owner.context)).status).toBe(403);
  // The platform approves it (the approval workflow itself has its own browser test).
  setLifecycle(id, "ACTIVE");
  expect((await branch(owner.context)).status).toBe(201);

  const coach = await signedInPage(browser, person("coach"));
  const parent = await signedInPage(browser, person("parent"));
  // Neither has an academy yet: Google gave them nothing.
  for (const who of [coach, parent]) {
    expect(
      (await api(who.context, "get", `/api/workspaces/${id}`)).status,
    ).toBeGreaterThanOrEqual(403);
  }
  const coachInvite = await api(
    owner.context,
    "post",
    `/api/workspaces/${id}/actions`,
    {
      action: "invite",
      data: { email: coach.claims.email, role: "COACH" },
    },
  );
  expect(coachInvite.status).toBeLessThan(300);
  expect(
    (
      await api(coach.context, "post", "/api/invitations/accept", {
        token: coachInvite.body.token,
      })
    ).status,
  ).toBe(200);
  const coachId = String(
    db(
      (d) =>
        d
          .prepare('SELECT id FROM "user" WHERE email=?')
          .get(coach.claims.email)!.id,
    ),
  );
  const child = await api(
    owner.context,
    "post",
    `/api/workspaces/${id}/records/player`,
    {
      name: "Linked Child",
      birthDate: "2015-05-05",
      squad: "U12",
      ageCategory: "U12",
      coachId,
      sportIds: ["football"],
      status: "ACTIVE",
    },
  );
  const other = await api(
    owner.context,
    "post",
    `/api/workspaces/${id}/records/player`,
    {
      name: "Someone Else",
      birthDate: "2015-05-05",
      squad: "U12",
      ageCategory: "U12",
      coachId,
      sportIds: ["football"],
      status: "ACTIVE",
    },
  );
  expect(child.status).toBe(201);
  expect(other.status).toBe(201);
  const parentInvite = await api(
    owner.context,
    "post",
    `/api/workspaces/${id}/actions`,
    {
      action: "invite",
      data: {
        email: parent.claims.email,
        role: "PARENT",
        playerIds: [child.body.id],
        guardianVerified: true,
      },
    },
  );
  expect(
    (
      await api(parent.context, "post", "/api/invitations/accept", {
        token: parentInvite.body.token,
      })
    ).status,
  ).toBe(200);

  // The academy appears in each person's own list, by what they were invited as.
  for (const who of [coach, parent]) {
    await who.page.goto("/workspace");
    await expect(
      who.page.getByRole("heading", { name: "Google Academy" }),
    ).toBeVisible();
  }
  // A parent sees only their child; a coach cannot do owner-only things; a parent cannot configure.
  const seen = await api(
    parent.context,
    "get",
    `/api/workspaces/${id}/records/player`,
  );
  expect(JSON.stringify(seen.body)).toContain("Linked Child");
  expect(JSON.stringify(seen.body)).not.toContain("Someone Else");
  expect(
    (
      await api(coach.context, "post", `/api/workspaces/${id}/actions`, {
        action: "invite",
        data: { email: person("x").email, role: "COACH" },
      })
    ).status,
  ).toBe(403);
  expect((await branch(parent.context)).status).toBe(403);

  // Another academy, another Google owner: neither can see the other's.
  const owner2 = await signedInPage(browser, person("owner2"));
  const second = await api(
    owner2.context,
    "post",
    "/api/workspaces",
    academyBody("Other Academy"),
  );
  const id2 = String(second.body.id);
  setLifecycle(id2, "ACTIVE");
  for (const [context, target] of [
    [owner2.context, id],
    [owner.context, id2],
    [coach.context, id2],
    [parent.context, id2],
  ] as const) {
    expect([403, 404]).toContain(
      (await api(context, "get", `/api/workspaces/${target}`)).status,
    );
    expect((await branch(context, target)).status).toBeGreaterThanOrEqual(403);
  }

  // Unapproved or suspended: the same sessions are shut out at once, and come back with the academy.
  for (const state of ["CONFIGURING", "SUSPENDED"]) {
    setLifecycle(id, state);
    for (const who of [owner, coach, parent])
      expect(
        (await api(who.context, "get", `/api/workspaces/${id}`)).status,
        `${who.claims.email} ${state}`,
      ).toBe(403);
  }
  setLifecycle(id, "ACTIVE");
  expect(
    (await api(coach.context, "get", `/api/workspaces/${id}`)).status,
  ).toBe(200);
  // A removed membership stops working for the same session.
  db((d) =>
    d
      .prepare("UPDATE academy_memberships SET active=0 WHERE userId=?")
      .run(coachId),
  );
  expect(
    (await api(coach.context, "get", `/api/workspaces/${id}`)).status,
  ).toBeGreaterThanOrEqual(403);

  for (const who of [owner, coach, parent, owner2]) await who.context.close();
});

test("on a phone the Google button and the error fit the screen", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
  });
  const page = await context.newPage();
  await playGoogle(page, () => ({ error: "access_denied" }));
  await page.goto("/sign-in");
  await gap();
  await googleButton(page).click();
  await expect(alertOf(page)).toContainText("cancelled");
  const scroll = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(scroll.page).toBeLessThanOrEqual(scroll.view);
  await context.close();
});
