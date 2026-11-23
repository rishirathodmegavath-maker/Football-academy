// WP7: every class of page loads, hydrates and works under the ENFORCED
// Content-Security-Policy, with no violation reported by the browser (and
// therefore none sent to /api/csp-report), and every script carries the nonce.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const PASSWORD = `Synthetic-only-${randomUUID()}`;

async function watch(page: Page) {
  const seen: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      w.__csp.push(
        `${event.effectiveDirective} blocked=${event.blockedURI.split("?")[0]} at=${event.sourceFile?.split("?")[0] ?? ""}`,
      ),
    );
  });
  page.on("console", (message) => {
    if (
      /Content Security Policy|Refused to (load|execute|apply)/i.test(
        message.text(),
      )
    )
      seen.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => seen.push(`pageerror: ${error.message}`));
  return seen;
}
async function visit(page: Page, seen: string[], path: string) {
  const response = await page.goto(path, { waitUntil: "networkidle" });
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy, path).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  // 'wasm-unsafe-eval' (WebAssembly compilation) is allowed; plain 'unsafe-eval' never.
  expect(policy, path).not.toMatch(/(?<!wasm-)unsafe-eval/);
  // Every script in the HTML the server sent carries the nonce. (Chunks that
  // those scripts add later are allowed by 'strict-dynamic'; a violation there
  // would be reported below.)
  // The raw HTML of a second request (the DOM hides the nonce attribute).
  const raw = await page.request.get(path);
  expect(raw.headers()["content-security-policy"], path).toContain("'nonce-");
  const html = await raw.text();
  const tags = html.match(/<script[\s>][^>]*>?/g) ?? [];
  // "/" only redirects (to the workspace list or sign-in) and has no document.
  if (path !== "/")
    expect(tags.length, `${path}: no scripts in the page`).toBeGreaterThan(0);
  expect(
    tags.filter((tag) => !/\snonce="[^"]+"/.test(tag)),
    `${path}: scripts without a nonce`,
  ).toEqual([]);
  const reported = await page.evaluate(
    () => (window as unknown as { __csp: string[] }).__csp,
  );
  expect([...seen, ...reported], path).toEqual([]);
}

test("pages load and hydrate under the enforced policy without a violation", async ({
  browser,
  playwright,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const api = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const email = `csp-${randomUUID()}@example.test`;
  expect(
    (
      await api.post("/api/auth/sign-up/email", {
        data: { name: "Synthetic Owner", email, password: PASSWORD },
      })
    ).status(),
  ).toBe(200);
  const created = await api.post("/api/workspaces", {
    data: {
      name: "CSP QA Academy",
      contactEmail: "fictional-csp@example.test",
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
  });
  expect(created.status(), await created.text()).toBe(201);
  const academy = await created.json();

  // Signed out: the public and legacy-demo pages.
  const anonymous = await browser.newContext();
  const page = await anonymous.newPage();
  const seen = await watch(page);
  for (const path of [
    "/",
    "/sign-in",
    "/reset-password",
    "/owner/dashboard",
    "/coach/dashboard",
    "/parent/home",
    "/design-preview",
    "/owner/not-a-screen",
    "/does-not-exist",
    "/apiary",
    "/_next/staticky",
  ])
    await visit(page, seen, path);
  // Hydration really happened: the sign-in form switches to registration.
  await page.goto("/sign-in", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await anonymous.close();

  // Signed in: the chooser, the account page, the platform page and academy screens.
  const context = await browser.newContext({
    storageState: await api.storageState(),
  });
  const signedIn = await context.newPage();
  const seenSignedIn = await watch(signedIn);
  for (const path of [
    "/workspace",
    "/account/security",
    "/platform",
    `/workspace/${academy.id}`,
    `/workspace/${academy.id}?section=fees`,
    `/workspace/${academy.id}?section=settings`,
    `/workspace/${academy.id}?section=reports`,
    `/workspace/${academy.id}?section=calendar`,
    `/workspace/${academy.id}?section=training`,
  ])
    await visit(signedIn, seenSignedIn, path);
  await context.close();
});

test("markup injected into the server's HTML does not run (the policy is enforced, not decorative)", async ({
  page,
}) => {
  // What a reflected-XSS bug would produce: an inline script and an inline
  // event handler in the HTML, without this response's nonce.
  await page.route("**/sign-in", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      "</body>",
      '<script>window.__injected=\'ran\'</script><img src="x" onerror="window.__handler=1"></body>',
    );
    await route.fulfill({ response, body: html });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __v: string[] };
    w.__v = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      w.__v.push(event.effectiveDirective),
    );
  });
  await page.goto("/sign-in", { waitUntil: "networkidle" });
  const result = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { injected: w.__injected, handler: w.__handler, violations: w.__v };
  });
  expect(result.injected).toBeUndefined();
  expect(result.handler).toBeUndefined();
  expect(result.violations).toEqual(
    expect.arrayContaining(["script-src-elem", "script-src-attr"]),
  );
  // The page itself still works.
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("API responses carry the locked-down policy and no page policy", async ({
  request,
}) => {
  const res = await request.get("/api/health");
  expect(res.headers()["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  expect(res.headers()["cross-origin-resource-policy"]).toBe("same-origin");
});

test("a violation report is accepted quietly, and a hostile one is ignored", async ({
  request,
  baseURL,
}) => {
  const url = `${new URL(baseURL!).origin}/api/csp-report`;
  const ok = await request.post(url, {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({
      "csp-report": {
        "document-uri": "http://127.0.0.1/sign-in?token=SECRET-NOT-LOGGED",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://evil.example/x.js?k=SECRET-NOT-LOGGED",
      },
    }),
  });
  expect(ok.status()).toBe(204);
  const junk = await request.post(url, { data: "not json at all" });
  expect(junk.status()).toBe(204);
  const huge = await request.post(url, { data: "x".repeat(20_000) });
  expect(huge.status()).toBe(204);
});
