import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

const filename = resolve(`.local/e2e-account-security-${randomUUID()}.sqlite`);
const local = relative(resolve(".local"), filename);
if (
  isAbsolute(local) ||
  local.startsWith("..") ||
  !/^e2e-account-security-[a-zA-Z0-9-]+\.sqlite$/.test(local)
)
  throw new Error(
    "Account security browser QA requires a fresh isolated database.",
  );
const origin = "http://127.0.0.1:3014";
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = origin;
export default defineConfig({
  testDir: "./tests/e2e",
  // New academies are approved at once in this throw-away database, so the
  // operational features can be tested; see tests/e2e/helpers/auto-approve.ts.
  globalSetup: "./tests/e2e/global-setup-approved.ts",
  testMatch: "account-security.spec.ts",
  outputDir: ".local/account-security-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 180000,
  expect: { timeout: 20000 },
  use: {
    baseURL: origin,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    actionTimeout: 15000,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3014",
    url: origin,
    reuseExistingServer: false,
    env: {
      // Browser suites test the review workflow (or pin it off with the trigger in
      // helpers/auto-approve.ts); a developer's own .env.local must not change that.
      SPORTOZEN_ACADEMY_APPROVAL: "required",
      SPORTOZEN_DATABASE_PATH: filename,
      BETTER_AUTH_URL: origin,
      // The policy under test: staff and owners must use a second step.
      SPORTOZEN_MFA: "staff",
      ...(process.env.SPORTOZEN_QA_BUILD === "1"
        ? { SPORTOZEN_QA_BUILD: "1" }
        : {}),
      ...(process.env.SPORTOZEN_FINAL_QA === "1"
        ? { SPORTOZEN_FINAL_QA: "1" }
        : {}),
      SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
      SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
      SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
    },
    timeout: 120000,
  },
});
