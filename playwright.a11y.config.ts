import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
// Wave 0 accessibility baseline: runs ONLY against the isolated synthetic Bharat database, on its own port.
const access = JSON.parse(readFileSync(".local/bharat-qa-access.json", "utf8")) as { databasePath: string };
const filename = resolve(access.databasePath);
const local = relative(resolve(".local"), filename);
if (isAbsolute(local) || local.startsWith("..") || !/^e2e-bharat-[a-zA-Z0-9-]+\.sqlite$/.test(local))
  throw new Error("The accessibility baseline requires the isolated synthetic Bharat database.");
process.env.SPORTOZEN_DATABASE_PATH = filename;
export default defineConfig({
  testDir: "./tests/a11y",
  outputDir: ".local/a11y-playwright",
  workers: 1,
  fullyParallel: false,
  timeout: 240000,
  expect: { timeout: 15000 },
  use: { baseURL: "http://127.0.0.1:3022", browserName: "chromium", actionTimeout: 15000, trace: "retain-on-failure" },
  reporter: [["list"], ["json", { outputFile: ".local/a11y-playwright/results.json" }]],
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3022",
    url: "http://127.0.0.1:3022/sign-in",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      SPORTOZEN_ACADEMY_APPROVAL: "required",
      SPORTOZEN_DATABASE_PATH: filename,
      BETTER_AUTH_URL: "http://127.0.0.1:3022",
      SPORTOZEN_GOOGLE_PLACES_ENABLED: "0",
      SPORTOZEN_WHATSAPP_SEND_ENABLED: "false",
      SPORTOZEN_WHATSAPP_LIVE_ENABLED: "false",
    },
  },
});
