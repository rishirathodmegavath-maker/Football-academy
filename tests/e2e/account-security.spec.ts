// WP6 in a real browser: turning on two-step verification, signing in with the
// second step, a recovery code, and the staff policy (SPORTOZEN_MFA=staff).
import { test, expect, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";

// RFC 6238, 30 s, 6 digits, from the base32 key the screen shows.
function totp(key: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of key.replace(/[\s=]/g, "").toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", bytes).update(counter).digest();
  const o = h[19] & 0xf;
  const n =
    ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
const PASSWORD = `Synthetic-only-${randomUUID()}`;

// Better Auth allows 3 second-step requests per 10 seconds per client address.
const pauseForLimiter = (page: Page) => page.waitForTimeout(11_000);

async function signInViaScreen(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("two-step verification: turn on, sign in with the code and with a recovery code, and the staff policy", async ({
  page,
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const email = `mfa-${randomUUID()}@example.test`;
  const up = await request.post("/api/auth/sign-up/email", {
    data: { name: "Synthetic Person", email, password: PASSWORD },
    headers: { Origin: origin },
  });
  expect(up.status(), await up.text()).toBe(200);
  await signInViaScreen(page, email);
  await expect(page).toHaveURL(/\/workspace$/);

  // The account page is reachable from the academy list.
  await page.getByRole("link", { name: "Account security" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Two-step verification" }),
  ).toBeVisible();
  await expect(page.getByText(/Off\. Turn it on/)).toBeVisible();

  // Turn it on: password, then the key, then a code.
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  const key = (await page.getByLabel("Setup key").innerText()).trim();
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel("Authentication code").fill("000000");
  await page.getByRole("button", { name: "Confirm and turn on" }).click();
  await expect(page.locator("p[role=alert]")).toBeVisible();
  await page.getByLabel("Authentication code").fill(totp(key));
  await page.getByRole("button", { name: "Confirm and turn on" }).click();
  const codes = (await page.getByLabel("Recovery codes").innerText())
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  expect(codes).toHaveLength(10);
  await expect(page.getByText(/^On\./)).toBeVisible();

  // Sign out, then the second step is asked for, and a wrong code is refused.
  await pauseForLimiter(page);
  await page.context().clearCookies();
  await signInViaScreen(page, email);
  await expect(
    page.getByRole("heading", { name: "Two-step verification" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel("Authentication code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("not accepted");
  await page.getByLabel("Authentication code").fill(totp(key));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  // A recovery code works once.
  await pauseForLimiter(page);
  await page.context().clearCookies();
  await signInViaScreen(page, email);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.context().clearCookies();
  await signInViaScreen(page, email);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await pauseForLimiter(page);
  await page.getByLabel("Recovery code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("not accepted");
});

test("with the staff policy a person without a second step cannot create an academy", async ({
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const email = `owner-${randomUUID()}@example.test`;
  await request.post("/api/auth/sign-up/email", {
    data: { name: "Synthetic Owner", email, password: PASSWORD },
    headers: { Origin: origin },
  });
  const created = await request.post("/api/workspaces", {
    data: {},
    headers: { Origin: origin },
  });
  expect(created.status()).toBe(403);
  expect((await created.json()).code).toBe("MFA_REQUIRED");
});
