import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// Google sign-in end to end in a real browser, against a STAND-IN for Google:
// the browser test plays Google's consent page, and tests/e2e/helpers/
// google-stand-in.cjs (loaded into this server only) answers Better Auth's
// token request. No Google account or credential is involved, nothing leaves
// this machine, and no e-mail is sent. The database is throw-away and has NO
// automatic approval, so an academy starts unapproved exactly as in production.
const id = process.env.GOOGLE_OAUTH_E2E_ID ?? randomUUID();
process.env.GOOGLE_OAUTH_E2E_ID = id;
const filename = resolve(`.local/e2e-google-oauth-${id}.sqlite`);
const origin = "http://127.0.0.1:3021";
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = origin;
process.env.GOOGLE_E2E_CLIENT_ID = "stand-in-client.apps.googleusercontent.com";
process.env.GOOGLE_E2E_CLIENT_SECRET = `stand-in-secret-${id}`;
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "google-oauth.spec.ts",
  outputDir: ".local/google-oauth-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: origin,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    actionTimeout: 15000,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3021",
    url: `${origin}/sign-in`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      // Browser suites test the review workflow (or pin it off with the trigger in
      // helpers/auto-approve.ts); a developer's own .env.local must not change that.
      SPORTOZEN_ACADEMY_APPROVAL: "required",
      SPORTOZEN_DATABASE_PATH: filename,
      BETTER_AUTH_URL: origin,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_E2E_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_E2E_CLIENT_SECRET,
      NODE_OPTIONS: `--require ${resolve("tests/e2e/helpers/google-stand-in.cjs").replace(/\\/g, "/")}`,
      SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
      SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
      SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
    },
  },
});
