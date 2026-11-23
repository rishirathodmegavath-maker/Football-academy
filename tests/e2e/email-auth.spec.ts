// Registration with e-mail verification, Forgot password and reset, in a real
// browser against a production build. Mail is captured by the local "file"
// transport (a folder of JSON files): nothing is sent to anyone, so this proves
// the application's flow, NOT delivery to a real mailbox.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIL_DIR = resolve(process.env.SPORTOZEN_EMAIL_PREVIEW_DIR!);
const PASSWORD = `Synthetic-only-${randomUUID()}`;
const NEW_PASSWORD = `Another-synthetic-${randomUUID()}`;
// Representative addresses and names from several countries. None is special.
const RUN = process.env.EMAIL_E2E_RUN!;
const PEOPLE = [
  { name: "Åsa Ñandú 李雷", email: `sarah.${RUN}@outlook.co.uk` },
  { name: "अजय कुमार", email: `rishi.${RUN}@gmail.com` },
  { name: "Ahmed محمد", email: `ahmed.${RUN}@example.ae` },
];

type Mail = { to: string; subject: string; text: string };
function mailsFor(email: string): Mail[] {
  let files: string[] = [];
  try {
    files = readdirSync(MAIL_DIR).sort();
  } catch {
    return [];
  }
  return files
    .map((f) => JSON.parse(readFileSync(resolve(MAIL_DIR, f), "utf8")) as Mail)
    .filter((m) => m.to === email.toLowerCase());
}
/** The nth message to this address whose subject starts with `subject`. */
async function waitForMail(email: string, subject: string, nth = 1): Promise<Mail> {
  const matching = () =>
    mailsFor(email).filter((m) => m.subject.startsWith(subject));
  await expect
    .poll(() => matching().length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(nth);
  return matching()[nth - 1]!;
}
const CONFIRM = "Confirm your Sportozen";
const RESET = "Reset your Sportozen";
const linkIn = (mail: Mail) => /http:\/\/127\.0\.0\.1:3015\/\S+/.exec(mail.text)![0];

async function register(page: Page, name: string, email: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/Check your email/)).toBeVisible();
}

// Better Auth allows 3 sign-in requests per 10 seconds per client address.
const pauseForLimiter = (page: Page) => page.waitForTimeout(11_000);

test.describe.configure({ mode: "serial" });

for (const person of PEOPLE) {
  test(`registration and e-mail verification for ${person.email}`, async ({ page }) => {
    await pauseForLimiter(page);
    await register(page, person.name, person.email);

    // Signing in before confirming is refused.
    await page.getByLabel("Email").fill(person.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/Confirm your email address first/)).toBeVisible();

    // The first message is the sign-up one; the refused sign-in sent a fresh one.
    const mail = await waitForMail(person.email, CONFIRM);
    expect(mail.subject).toBe("Confirm your Sportozen Academy email address");
    expect(mail.text).toContain(person.name);
    await page.goto(linkIn(mail));
    // The page shows the confirmation and removes the query string from the address bar.
    await expect(page.getByText(/email address is confirmed/i)).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByLabel("Email").fill(person.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace/);
  });
}

test("forgot password: request, emailed link, new password, one use only", async ({
  page,
  browser,
}) => {
  const person = PEOPLE[0]!;
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByLabel("Email").fill(person.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  const notice =
    "If an account exists for that address, a reset link is on its way.";
  await expect(page.getByText(notice)).toBeVisible();

  // An address without an account gets exactly the same answer and no message.
  const stranger = `nobody.${randomUUID().slice(0, 8)}@example.de`;
  await page.getByLabel("Email").fill(stranger);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(notice)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(mailsFor(stranger)).toHaveLength(0);

  const mail = await waitForMail(person.email, RESET);
  expect(mail.subject).toBe("Reset your Sportozen Academy password");
  const link = linkIn(mail);

  // A second browser, signed in with the old password, loses that session.
  await pauseForLimiter(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/sign-in");
  await otherPage.getByLabel("Email").fill(person.email);
  await otherPage.getByLabel("Password").fill(PASSWORD);
  await otherPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(otherPage).toHaveURL(/\/workspace/);

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  // The token is gone from the address bar.
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Repeat the new password").fill("short");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible(); // browser validation blocks it
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Repeat the new password").fill(NEW_PASSWORD + "x");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();
  await page.getByLabel("Repeat the new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText(/Your password has been changed/)).toBeVisible();

  // The other browser's session ended.
  await otherPage.goto("/workspace");
  await expect(otherPage).toHaveURL(/\/sign-in/);
  await other.close();

  // Old password refused, new password accepted.
  await pauseForLimiter(page);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toBeVisible();
  await page.getByLabel("Password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);

  // The link works once.
  await page.goto(link);
  await expect(page.getByText(/not valid or has expired/)).toBeVisible();
});

test("an invalid, missing or expired reset link is explained and cannot change anything", async ({
  page,
}) => {
  // No token at all: explained at once.
  await page.goto("/reset-password");
  await expect(page.getByText(/not valid or has expired/)).toBeVisible();
  // A token the server does not know: the form appears, and submitting is refused.
  await page.goto("/reset-password?token=not-a-real-token");
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Repeat the new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator("p[role=alert]")).toContainText(/not valid or has expired/);
  // The server's own redirect for a token it rejects.
  await page.goto("/api/auth/reset-password/not-a-real-token?callbackURL=/reset-password");
  await expect(page.getByText(/not valid or has expired/)).toBeVisible();

  // Expired: request a link, then age its stored record past its expiry.
  const person = PEOPLE[1]!;
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByLabel("Email").fill(person.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  const mail = await waitForMail(person.email, RESET);
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!);
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare(
    `UPDATE verification SET expiresAt=? WHERE expiresAt>?`,
  ).run("2000-01-01T00:00:00.000Z", new Date().toISOString());
  db.close();
  await page.goto(linkIn(mail));
  await expect(page.getByText(/not valid or has expired/)).toBeVisible();
});

test("password reset requests are rate limited", async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const response = await request.post("/api/auth/request-password-reset", {
      data: { email: `flood.${i}@example.org`, redirectTo: "/reset-password" },
      headers: { Origin: origin },
    });
    statuses.push(response.status());
  }
  expect(statuses).toContain(429);
  // Earlier tests used part of the same window, so only the end state is fixed.
  expect(statuses.at(-1)).toBe(429);
});
