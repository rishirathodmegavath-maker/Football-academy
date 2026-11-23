import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
// The spawned server and test operator commands share an isolated fictional database.
process.env.SPORTOZEN_DATABASE_PATH ??= `.local/e2e-${randomUUID()}.sqlite`;
const testDatabase = resolve(process.env.SPORTOZEN_DATABASE_PATH);
const relativeDatabase = relative(resolve(".local"), testDatabase);
if (
  isAbsolute(relativeDatabase) ||
  relativeDatabase.startsWith("..") ||
  !/^e2e-[a-zA-Z0-9-]+\.sqlite$/.test(relativeDatabase)
)
  throw new Error(
    "Browser tests require a dedicated .local/e2e-*.sqlite database.",
  );
const origin = "http://127.0.0.1:3001";
process.env.BETTER_AUTH_URL = origin;
export default defineConfig({
  testDir: "./tests/e2e",
  // New academies are approved at once in this throw-away database, so the
  // operational features can be tested; see tests/e2e/helpers/auto-approve.ts.
  globalSetup: "./tests/e2e/global-setup-approved.ts",
  // Monthly report review seeds and starts its own server on port 3013; run it
  // with playwright.report-review.config.ts (a separate CI job).
  // Account security runs with SPORTOZEN_MFA=staff on port 3014; run it with
  // playwright.account-security.config.ts.
  testIgnore: [
    "monthly-report-review.spec.ts",
    "account-security.spec.ts",
    "email-auth.spec.ts",
    // Needs a database in which nothing is approved automatically; it runs
    // with playwright.approval.config.ts on its own server.
    "phase8-approval.spec.ts",
    // Runs on its own server with e-mail written to a local folder; see
    // playwright.training.config.ts.
    "phase9-training.spec.ts",
    // Needs two servers, one with placeholder Google settings; see
    // playwright.google-ui.config.ts.
    "google-sign-in-ui.spec.ts",
    // Runs against a stand-in for Google on its own server; see
    // playwright.google-oauth.config.ts.
    "google-oauth.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL: origin,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "retain-on-failure",
  },
  webServer: {
    // The project's own Next.js executable, run by the same Node that runs
    // Playwright: no global pnpm is needed (same as the other configs).
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3001",
    url: origin,
    reuseExistingServer: false,
    env: {
      // Browser suites test the review workflow (or pin it off with the trigger in
      // helpers/auto-approve.ts); a developer's own .env.local must not change that.
      SPORTOZEN_ACADEMY_APPROVAL: "required",
      SPORTOZEN_DATABASE_PATH: testDatabase,
      BETTER_AUTH_URL: origin,
      SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
      SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
      SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
      // Player invitation links are OFF by default in every deployment (they make logins for people under 18, which needs legal
      // advice first). The browser suite switches them on so it can test the journey; nothing else uses this value.
      SPORTOZEN_PLAYER_LINKS_ENABLED: "1",
      ...(process.env.SPORTOZEN_QA_BUILD === "1"
        ? { SPORTOZEN_QA_BUILD: "1" }
        : {}),
      ...(process.env.SPORTOZEN_GALLERY_QA === "1"
        ? { SPORTOZEN_GALLERY_QA: "1" }
        : {}),
      ...(process.env.SPORTOZEN_FINAL_QA === "1"
        ? { SPORTOZEN_FINAL_QA: "1" }
        : {}),
      ...(process.env.SPORTOZEN_PLAYER_FORM_QA === "1"
        ? { SPORTOZEN_PLAYER_FORM_QA: "1" }
        : {}),
    },
    timeout: 120000,
  },
});
