import { installAutoApproval } from "./helpers/auto-approve";

// Playwright starts the web server first, then runs this: see helpers/auto-approve.ts.
export default async function globalSetup() {
  const database = process.env.SPORTOZEN_DATABASE_PATH;
  const origin = process.env.BETTER_AUTH_URL;
  if (!database || !origin)
    throw new Error("The browser test database and origin are not set.");
  await installAutoApproval(origin, database);
}
