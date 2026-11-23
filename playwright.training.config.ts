import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

// Phase 9 in a real browser: recurring weekly sessions, single and series
// cancellation, cancellation e-mails, session wrap-up and attendance history,
// for an owner, two coaches and two parents. Mail goes to a local folder (the
// "file" transport, localhost only); nothing is sent to anyone. New academies
// are approved at once in this throw-away database (see helpers/auto-approve.ts).
const id = process.env.TRAINING_E2E_ID ?? randomUUID();
process.env.TRAINING_E2E_ID = id;
const filename = resolve(`.local/e2e-training-${id}.sqlite`);
const local = relative(resolve(".local"), filename);
if (
  isAbsolute(local) ||
  local.startsWith("..") ||
  !/^e2e-training-[a-zA-Z0-9-]+\.sqlite$/.test(local)
)
  throw new Error("Training browser QA requires a fresh isolated database.");
const mailDir = resolve(`.local/e2e-training-mail-${id}`);
const origin = "http://127.0.0.1:3018";
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = origin;
process.env.SPORTOZEN_EMAIL_PREVIEW_DIR = mailDir;
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup-approved.ts",
  testMatch: "phase9-training.spec.ts",
  outputDir: ".local/training-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 300000,
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
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3018",
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
      SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
      SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
      SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
    },
    timeout: 120000,
  },
});
