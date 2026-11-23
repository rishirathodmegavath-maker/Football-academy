import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// The "Continue with Google" button on the sign-in and registration screen, in a
// real browser. Two production servers on throw-away databases:
//   3019 has placeholder Google settings, so the button is enabled;
//   3020 has none, so the button is shown disabled.
// The placeholder values are not real credentials and are never sent anywhere:
// the browser tests intercept the one request the button makes. No Google
// account is contacted.
const id = process.env.GOOGLE_UI_E2E_ID ?? randomUUID();
process.env.GOOGLE_UI_E2E_ID = id;
const enabled = "http://127.0.0.1:3019";
const disabled = "http://127.0.0.1:3020";
const server = (
  port: number,
  origin: string,
  extra: Record<string, string>,
) => ({
  command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
  url: `${origin}/sign-in`,
  reuseExistingServer: false,
  timeout: 120000,
  env: {
    // Browser suites test the review workflow (or pin it off with the trigger in
    // helpers/auto-approve.ts); a developer's own .env.local must not change that.
    SPORTOZEN_ACADEMY_APPROVAL: "required",
    SPORTOZEN_DATABASE_PATH: resolve(
      `.local/e2e-google-ui-${port}-${id}.sqlite`,
    ),
    BETTER_AUTH_URL: origin,
    SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
    SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
    SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
    ...extra,
  },
});
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "google-sign-in-ui.spec.ts",
  outputDir: ".local/google-ui-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "enabled", use: { baseURL: enabled } },
    { name: "disabled", use: { baseURL: disabled } },
  ],
  webServer: [
    server(3019, enabled, {
      GOOGLE_CLIENT_ID: "test-only-placeholder.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-only-placeholder-not-a-secret",
    }),
    server(3020, disabled, {}),
  ],
});
