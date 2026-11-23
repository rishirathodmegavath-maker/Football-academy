import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

// The academy approval workflow in a real browser, against a database in which
// NOTHING is approved automatically (unlike playwright.config.ts): an owner
// registers an academy, sees the approval page and is refused every operational
// request; a platform administrator reviews, rejects with a reason, approves;
// the owner resubmits and then opens the portal. Mail goes to a local folder
// (the "file" transport, localhost only); nothing is sent to anyone.
const id = process.env.APPROVAL_E2E_ID ?? randomUUID();
process.env.APPROVAL_E2E_ID = id;
const filename = resolve(`.local/e2e-approval-${id}.sqlite`);
const local = relative(resolve(".local"), filename);
if (
  isAbsolute(local) ||
  local.startsWith("..") ||
  !/^e2e-approval-[a-zA-Z0-9-]+\.sqlite$/.test(local)
)
  throw new Error("Approval browser QA requires a fresh isolated database.");
const mailDir = resolve(`.local/e2e-approval-mail-${id}`);
const origin = "http://127.0.0.1:3016";
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = origin;
process.env.SPORTOZEN_EMAIL_PREVIEW_DIR = mailDir;
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "phase8-approval.spec.ts",
  outputDir: ".local/approval-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 240000,
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
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3016",
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
