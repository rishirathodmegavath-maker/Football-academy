import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

// Registration with e-mail verification, forgot password and reset in a real
// browser. Mail is written to a local folder by the "file" transport (allowed
// only for a localhost deployment): nothing is sent to anyone.
// The config is loaded again inside every test worker; a value kept in the
// environment makes the database, the mail folder and the test titles identical in both.
const id = process.env.EMAIL_E2E_ID ?? randomUUID();
process.env.EMAIL_E2E_ID = id;
const filename = resolve(`.local/e2e-email-auth-${id}.sqlite`);
const local = relative(resolve(".local"), filename);
if (
  isAbsolute(local) ||
  local.startsWith("..") ||
  !/^e2e-email-auth-[a-zA-Z0-9-]+\.sqlite$/.test(local)
)
  throw new Error("Email browser QA requires a fresh isolated database.");
const mailDir = resolve(`.local/e2e-email-auth-mail-${id}`);
const origin = "http://127.0.0.1:3015";
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = origin;
process.env.SPORTOZEN_EMAIL_PREVIEW_DIR = mailDir;
// Shared with the test workers so the addresses in test titles are the same everywhere.
process.env.EMAIL_E2E_RUN = id.slice(0, 8);
export default defineConfig({
  testDir: "./tests/e2e",
  // New academies are approved at once in this throw-away database, so the
  // operational features can be tested; see tests/e2e/helpers/auto-approve.ts.
  globalSetup: "./tests/e2e/global-setup-approved.ts",
  testMatch: "email-auth.spec.ts",
  outputDir: ".local/email-auth-playwright",
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
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3015",
    url: origin,
    reuseExistingServer: false,
    env: {
      // Browser suites test the review workflow (or pin it off with the trigger in
      // helpers/auto-approve.ts); a developer's own .env.local must not change that.
      SPORTOZEN_ACADEMY_APPROVAL: "required",
      SPORTOZEN_DATABASE_PATH: filename,
      BETTER_AUTH_URL: origin,
      SPORTOZEN_EMAIL_TRANSPORT: "file",
      SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@localhost.test>",
      SPORTOZEN_EMAIL_PREVIEW_DIR: mailDir,
      SPORTOZEN_EMAIL_VERIFICATION: "required",
      SPORTOZEN_PASSWORD_RECOVERY: "on",
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
