import { test, expect, type APIRequestContext } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// The academy approval workflow in a real browser (playwright.approval.config.ts:
// no academy is approved automatically here).
//  1. A new academy sees the approval page, can edit its profile and submit, and
//     every operational request is refused by the server.
//  2. A platform administrator reviews: rejects with a reason (mandatory), the
//     owner reads it, edits and resubmits, the administrator approves.
//  3. Only then does the owner open the portal and create a player.
//  4. An academy owner cannot reach the platform pages; a suspension closes the
//     academy and a reactivation reopens it.
test.use({ actionTimeout: 15000 });
const origin = "http://127.0.0.1:3016";
const settle = () => new Promise((resolve) => setTimeout(resolve, 11000));

test("an academy is reviewed, rejected with a reason, resubmitted, approved and then opens", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(420000);
  const suffix = crypto.randomUUID().slice(0, 8);
  async function account(name: string) {
    await settle(); // sign-up is limited to three per ten seconds
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name}-${suffix}@example.test`;
    const r = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(r.status(), await r.text()).toBe(200);
    return { api, email, id: (await r.json()).user.id as string };
  }
  const owner = await account("ApprovalOwner");
  const admin = await account("ApprovalAdmin");
  const db = new DatabaseSync(process.env.SPORTOZEN_DATABASE_PATH!);
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare("INSERT INTO platform_administrators(userId) VALUES(?)").run(
    admin.id,
  );

  const created = await owner.api.post("/api/workspaces", {
    data: {
      name: "Approval Check Academy",
      contactEmail: "approval@example.test",
      country: "IN",
      language: "en",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      modules: ["development", "reports", "communication", "fees"],
      demo: false,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const academyId = (await created.json()).id as string;
  const root = `/api/workspaces/${academyId}`;

  // ---- 1. the owner's side before approval --------------------------------
  const ownerContext = await browser.newContext({
    storageState: await owner.api.storageState(),
  });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(`${origin}/workspace/${academyId}`);
  await expect(
    ownerPage.getByRole("heading", {
      name: "Approval Check Academy",
      level: 1,
    }),
  ).toBeVisible();
  await expect(ownerPage.getByText("Setting up").first()).toBeVisible();
  await expect(
    ownerPage.getByRole("button", { name: "Submit for approval" }),
  ).toBeEnabled();
  // No operational navigation is offered, and the server refuses the requests.
  await expect(
    ownerPage.getByRole("navigation", { name: "Academy navigation" }),
  ).toHaveCount(0);
  await expect(
    ownerPage.getByRole("button", { name: "Players", exact: true }),
  ).toHaveCount(0);
  const refused: [string, string, unknown][] = [
    ["get", `${root}`, undefined],
    ["get", `${root}/records/player`, undefined],
    [
      "post",
      `${root}/records/player`,
      { birthDate: "2015-05-05", name: "Fictional Child", squad: "U12", coachId: owner.id },
    ],
    ["post", `${root}/training`, { action: "squad", data: {} }],
    [
      "post",
      `${root}/finance`,
      { requestId: crypto.randomUUID(), action: "invoice", data: {} },
    ],
    [
      "post",
      `${root}/communication/announcements`,
      { action: "save", data: {} },
    ],
    ["get", `${root}/communication`, undefined],
    [
      "post",
      `${root}/actions`,
      { action: "invite", data: { email: "x@example.test", role: "COACH" } },
    ],
  ];
  for (const [method, path, data] of refused) {
    const res =
      method === "get"
        ? await owner.api.get(path)
        : await owner.api.post(path, { data });
    expect(res.status(), `${method} ${path}`).toBe(403);
    expect((await res.json()).code, `${method} ${path}`).toBe(
      "ACADEMY_NOT_APPROVED",
    );
  }
  // Edit the profile on the page, then submit.
  await ownerPage.getByLabel("Academy name").fill("Approval Check Academy");
  await ownerPage
    .getByRole("button", { name: "Save academy configuration" })
    .click();
  await expect(ownerPage.getByText("Academy profile saved.")).toBeVisible();
  await ownerPage.getByRole("button", { name: "Submit for approval" }).click();
  await expect(
    ownerPage.getByText("Submitted for approval").first(),
  ).toBeVisible();
  // Once submitted there is nothing left to submit, so the button is no longer offered.
  await expect(
    ownerPage.getByRole("button", { name: "Submit for approval" }),
  ).toHaveCount(0);

  // ---- 2. the platform administrator's side -------------------------------
  const adminContext = await browser.newContext({
    storageState: await admin.api.storageState(),
  });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${origin}/platform`);
  await expect(
    adminPage.getByRole("heading", { name: "Academy applications" }),
  ).toBeVisible();
  const open = () =>
    adminPage
      .getByRole("button", { name: "Open application: Approval Check Academy" })
      .click();
  await open();
  const detail = adminPage.getByRole("region", {
    name: "Application details",
  });
  await expect(detail.getByText("Submitted for approval")).toBeVisible();
  await expect(detail.getByText("approval@example.test")).toBeVisible();
  // Approving needs a review first; the only action offered is "Start review".
  await expect(detail.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Start review" }).click();
  await expect(detail.getByText("Pending review").first()).toBeVisible();
  // A rejection without a reason is refused on the page.
  await detail.getByRole("button", { name: "Reject" }).click();
  await expect(adminPage.locator("main [role=alert]")).toContainText(
    "at least 10 characters",
  );
  const feedback = "Please add a phone number and a location we can verify.";
  await adminPage
    .getByLabel(/Reason or note for the academy owner/)
    .fill(feedback);
  await detail.getByRole("button", { name: "Reject" }).click();
  await expect(detail.getByText("Not approved").first()).toBeVisible();
  await expect(detail.getByText(feedback)).toBeVisible();

  // ---- the owner reads the feedback, edits and resubmits -------------------
  await ownerPage.reload();
  await expect(ownerPage.getByText("Not approved").first()).toBeVisible();
  await expect(ownerPage.getByText(feedback).first()).toBeVisible();
  await ownerPage.getByLabel("Academy name").fill("Approval Check Academy");
  await ownerPage
    .getByRole("button", { name: "Save academy configuration" })
    .click();
  await expect(ownerPage.getByText("Academy profile saved.")).toBeVisible();
  await ownerPage
    .getByRole("button", { name: "Resubmit for approval" })
    .click();
  await expect(ownerPage.getByText(/submitted 2 times/)).toBeVisible();

  // ---- the administrator approves the resubmission --------------------------
  await adminPage.reload();
  await open();
  await expect(adminPage.getByText(/resubmitted/).first()).toBeVisible();
  await detail.getByRole("button", { name: "Start review" }).click();
  await detail.getByRole("button", { name: "Approve" }).click();
  await expect(detail.getByText("Approved and active").first()).toBeVisible();

  // ---- 3. the owner opens the portal and works ------------------------------
  // The page is still open: one click finds the decision and opens the portal.
  await ownerPage.getByRole("button", { name: "Check for a decision" }).click();
  await expect(
    ownerPage.getByRole("navigation", { name: "Academy navigation" }),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole("button", { name: "Players", exact: true }),
  ).toBeVisible();
  const player = await owner.api.post(`${root}/records/player`, {
    data: { birthDate: "2015-05-05", name: "Fictional Approved Child", squad: "U12", coachId: owner.id },
  });
  expect(player.status(), await player.text()).toBe(201);
  // The history and the notices are on record.
  const history = db
    .prepare(
      "SELECT action FROM academy_lifecycle_history WHERE academyId=? ORDER BY id",
    )
    .all(academyId)
    .map((r) => r.action);
  expect(history).toEqual([
    "REGISTERED",
    "SUBMITTED",
    "REVIEW_STARTED",
    "REJECTED",
    "RESUBMITTED",
    "REVIEW_STARTED",
    "APPROVED",
  ]);
  const mailDir = resolve(process.env.SPORTOZEN_EMAIL_PREVIEW_DIR!);
  await expect
    .poll(
      () =>
        readdirSync(mailDir)
          .map(
            (f) =>
              JSON.parse(readFileSync(resolve(mailDir, f), "utf8"))
                .subject as string,
          )
          .filter((s) => /academy/i.test(s)).length,
      { timeout: 60000 },
    )
    .toBeGreaterThanOrEqual(4);

  // ---- 4. separation of roles, suspension and reactivation -------------------
  expect((await owner.api.get("/api/platform/applications")).status()).toBe(
    403,
  );
  const ownerPlatformPage = await ownerContext.newPage();
  await ownerPlatformPage.goto(`${origin}/platform`);
  await expect(ownerPlatformPage.locator("main [role=alert]")).toContainText(
    "not an academy role",
  );
  const ownerDecision = await owner.api.post(
    `/api/platform/applications/${academyId}/decision`,
    {
      data: {
        decision: "suspend",
        reason: "I would like to close it",
        expectedVersion: 1,
      },
    },
  );
  expect(ownerDecision.status()).toBe(403);

  await adminPage.reload();
  await open();
  await adminPage
    .getByLabel(/Reason or note for the academy owner/)
    .fill("Paused while we check a complaint.");
  adminPage.once("dialog", (dialog) => void dialog.accept());
  await detail.getByRole("button", { name: "Suspend" }).click();
  await expect(detail.getByText("Suspended").first()).toBeVisible();
  expect((await owner.api.get(`${root}/records/player`)).status()).toBe(403);
  await ownerPage.reload();
  await expect(ownerPage.locator("main [role=alert]")).toContainText(
    "suspended",
  );
  await adminPage
    .getByLabel(/Reason or note for the academy owner/)
    .fill("Complaint resolved.");
  await detail.getByRole("button", { name: "Reactivate" }).click();
  await expect(detail.getByText("Approved and active").first()).toBeVisible();
  expect((await owner.api.get(`${root}/records/player`)).status()).toBe(200);

  db.close();
  await ownerContext.close();
  await adminContext.close();
  for (const api of [owner.api, admin.api] as APIRequestContext[])
    await api.dispose();
});
