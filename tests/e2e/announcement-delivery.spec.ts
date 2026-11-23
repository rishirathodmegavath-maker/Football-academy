import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
// Phase 5: the announcement workflow end to end. An owner drafts, submits and
// approves an announcement; the guardian of a child in that batch reads it in
// the app (no WhatsApp is configured); a guardian of another batch does not;
// a coach is told approval is needed; and every step's feedback is visible
// next to the buttons, not scrolled out of sight.
test.use({ actionTimeout: 15000 });
test("approved batch announcements reach only the intended guardians in the app, with visible feedback at every step", async ({
  playwright,
  browser,
}) => {
  test.setTimeout(240000);
  const origin = "http://127.0.0.1:3001",
    suffix = crypto.randomUUID();
  async function account(name: string) {
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name}-${suffix}@example.test`;
    const response = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { api, email, id: (await response.json()).user.id as string };
  }
  const post = async <T>(
    api: APIRequestContext,
    path: string,
    data: unknown,
    status = 200,
  ) => {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(status);
    return response.json() as Promise<T>;
  };
  // Sign-up is limited per address: leave the limiter window between accounts.
  const owner = await account("AnnounceOwner");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const coach = await account("AnnounceCoach");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const parentA = await account("AnnounceGuardianA");
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const parentB = await account("AnnounceGuardianB");
  const academy = await post<{ id: string }>(
    owner.api,
    "/api/workspaces",
    {
      name: "Synthetic Delivery Academy",
      contactEmail: "delivery@example.test",
      country: "IN",
      language: "en",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
      brandAccent: "#008463",
      modules: ["development", "reports", "communication"],
      demo: false,
    },
    201,
  );
  const root = `/api/workspaces/${academy.id}`;
  const invite = (email: string, role: string, playerIds?: string[]) =>
    post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      data: {
        email,
        role,
        ...(playerIds ? { playerIds, guardianVerified: true } : {}),
      },
    });
  await post(coach.api, "/api/invitations/accept", {
    token: (await invite(coach.email, "COACH")).token,
  });
  const child = async (name: string, coachId: string) =>
    (
      await post<{ id: string }>(
        owner.api,
        `${root}/records/player`,
        { name, birthDate: "2015-05-05", squad: "U12", coachId },
        201,
      )
    ).id;
  const firstChild = await child("Fictional Announce One", coach.id),
    secondChild = await child("Fictional Announce Two", coach.id),
    unlinkedChild = await child("Fictional Announce Three", coach.id);
  const branch = await post<{ id: string }>(
    owner.api,
    `${root}/records/branch`,
    {
      name: "Delivery Branch",
      timezone: "Asia/Kolkata",
    },
    201,
  );
  const batch = async (name: string, playerIds: string[]) =>
    (
      await post<{ id: string }>(owner.api, `${root}/training`, {
        requestId: crypto.randomUUID(),
        action: "squad",
        data: { name, branchId: branch.id, playerIds },
      })
    ).id;
  const batchA = await batch("Under 10", [firstChild]),
    batchB = await batch("Under 12", [secondChild]),
    batchNoGuardian = await batch("Under 14", [unlinkedChild]);
  await post(parentA.api, "/api/invitations/accept", {
    token: (await invite(parentA.email, "PARENT", [firstChild])).token,
  });
  await post(parentB.api, "/api/invitations/accept", {
    token: (await invite(parentB.email, "PARENT", [secondChild])).token,
  });
  const open = async (who: { api: APIRequestContext }, width = 1366) => {
    const context = await browser.newContext({
      storageState: await who.api.storageState(),
      viewport: { width, height: width > 600 ? 768 : 844 },
    });
    return { context, page: await context.newPage() };
  };
  // The point of this spec: the message about what just happened must be on
  // screen, inside the visible part of the dialog, next to the buttons.
  const visibleNow = async (page: Page, target: Locator) => {
    await expect(target).toBeVisible();
    const box = await target.boundingBox(),
      view = page.viewportSize()!;
    expect(box, "feedback has a box").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
  };

  // ---- coach: can draft and submit, cannot approve, and is told why --------
  {
    const { context, page } = await open(coach);
    await page.goto(`/workspace/${academy.id}?section=messages`);
    await page
      .getByRole("button", { name: "Batch announcements", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Batch announcements" });
    const save = dialog.getByRole("button", {
      name: "Save announcement draft",
    });
    await expect(save).toBeDisabled();
    await visibleNow(page, dialog.getByText("Choose at least one batch"));
    await dialog
      .getByRole("combobox", { name: "Announcement batch" })
      .selectOption(batchA);
    await dialog
      .getByLabel("Generic announcement")
      .fill("Coach draft: bring water bottles to the next session.");
    await save.click();
    await visibleNow(page, dialog.getByRole("status"));
    await dialog
      .getByRole("button", { name: "Send announcement for approval" })
      .click();
    await visibleNow(
      page,
      dialog.getByText("An owner or admin must approve it"),
    );
    // The next step is the owner's: a coach sees no Approve button.
    await expect(
      dialog.getByRole("button", { name: "Approve announcement" }),
    ).toHaveCount(0);
    await context.close();
  }

  // ---- owner: draft, send for approval, approve -----------------------------
  const body =
    "Training is moved to the main ground this Saturday. Please arrive ten minutes early.";
  const { context: ownerContext, page } = await open(owner);
  await page.goto(`/workspace/${academy.id}?section=messages`);
  await page
    .getByRole("button", { name: "Batch announcements", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Batch announcements" });
  // The coach's pending draft is there for review.
  await dialog
    .getByRole("combobox", { name: "Announcement batch" })
    .selectOption(batchA);
  await dialog.getByLabel("Generic announcement").fill(body);
  await dialog.getByRole("button", { name: "Save announcement draft" }).click();
  await visibleNow(page, dialog.getByText("Draft saved."));
  await dialog
    .getByRole("button", { name: "Send announcement for approval" })
    .click();
  await visibleNow(page, dialog.getByText("Sent for approval."));
  const approve = dialog.getByRole("button", { name: "Approve announcement" });
  await expect(approve).toBeDisabled();
  await visibleNow(page, dialog.getByText("To approve: preview"));
  await dialog
    .getByRole("button", { name: "Preview recipients and message" })
    .click();
  await expect(dialog).toContainText("1 guardian will read this in the app");
  await visibleNow(page, dialog.getByText("Tick the review box"));
  await dialog
    .getByRole("checkbox", { name: /I reviewed the final message/ })
    .check();
  await approve.click();
  await visibleNow(
    page,
    dialog.getByText("Approved. Guardians of the selected"),
  );
  // WhatsApp is not configured: that is explained, and it did not stop the approval.
  await dialog
    .getByRole("button", { name: "Preview recipients and message" })
    .click();
  await expect(dialog).toContainText("WhatsApp delivery is not ready yet");
  await expect(
    dialog.getByRole("button", { name: "Queue approved announcement" }),
  ).toBeDisabled();

  // ---- the intended guardian reads it; the other guardian does not ----------
  {
    const { context, page: guardian } = await open(parentA);
    await guardian.goto(`/workspace/${academy.id}`);
    const card = guardian.getByRole("region", {
      name: "Academy announcements",
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText(body);
    await expect(card).toContainText("Under 10");
    await expect(card).not.toContainText("Fictional Announce");
    await guardian.goto(`/workspace/${academy.id}?section=messages`);
    await expect(
      guardian.getByRole("region", { name: "Academy announcements" }),
    ).toContainText(body);
    await context.close();
  }
  {
    const { context, page: guardian } = await open(parentB);
    await guardian.goto(`/workspace/${academy.id}`);
    await expect(
      guardian.getByRole("heading", { name: "This Week’s Focus" }),
    ).toBeVisible();
    await expect(
      guardian.getByRole("region", { name: "Academy announcements" }),
    ).toHaveCount(0);
    expect(await guardian.content()).not.toContain(body);
    await context.close();
  }
  // The data is persisted server-side, not held in the page.
  const read = await parentA.api.get(`${root}/announcements`);
  expect(read.status()).toBe(200);
  expect(
    (
      (await read.json()) as { announcements: { body: string }[] }
    ).announcements.map((item) => item.body),
  ).toEqual([body]);
  expect((await parentB.api.get(`${root}/announcements`)).status()).toBe(200);
  expect(
    (
      (await (await parentB.api.get(`${root}/announcements`)).json()) as {
        announcements: unknown[];
      }
    ).announcements,
  ).toEqual([]);
  expect((await owner.api.get(`${root}/announcements`)).status()).toBe(403);

  // ---- an error is shown where the user is looking --------------------------
  await dialog.getByRole("button", { name: "New announcement" }).click();
  await dialog
    .getByRole("combobox", { name: "Announcement batch" })
    .selectOption(batchNoGuardian);
  await dialog
    .getByLabel("Generic announcement")
    .fill("Batch notice for a group with no linked guardian yet.");
  await dialog.getByRole("button", { name: "Save announcement draft" }).click();
  await dialog
    .getByRole("button", { name: "Send announcement for approval" })
    .click();
  await dialog
    .getByRole("button", { name: "Preview recipients and message" })
    .click();
  await expect(dialog).toContainText("0 guardians will read this in the app");
  await dialog
    .getByRole("checkbox", { name: /I reviewed the final message/ })
    .check();
  await dialog.getByRole("button", { name: "Approve announcement" }).click();
  await visibleNow(page, dialog.getByRole("alert"));
  await expect(dialog.getByRole("alert")).toContainText("nobody would see");

  // ---- cancelling withdraws it from the guardian ----------------------------
  await dialog
    .getByRole("combobox", { name: "Saved announcements" })
    .selectOption({ index: 1 });
  const saved = await owner.api.get(`${root}/communication/announcements`);
  const approvedRecord = (
    (await saved.json()) as { announcements: { id: string; status: string }[] }
  ).announcements.find((item) => item.status === "APPROVED");
  expect(approvedRecord).toBeTruthy();
  await dialog
    .getByRole("combobox", { name: "Saved announcements" })
    .selectOption(approvedRecord!.id);
  await dialog.getByRole("button", { name: "Cancel announcement" }).click();
  await visibleNow(page, dialog.getByText("Announcement cancelled."));
  expect(
    (
      (await (await parentA.api.get(`${root}/announcements`)).json()) as {
        announcements: unknown[];
      }
    ).announcements,
  ).toEqual([]);

  // ---- narrow screens: the feedback is still inside the viewport ------------
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "New announcement" }).click();
  await dialog
    .getByRole("combobox", { name: "Announcement batch" })
    .selectOption(batchB);
  await dialog.getByLabel("Generic announcement").fill("Small-screen check.");
  await dialog.getByRole("button", { name: "Save announcement draft" }).click();
  await visibleNow(page, dialog.getByText("Draft saved."));
  await ownerContext.close();
  for (const who of [owner, coach, parentA, parentB]) await who.api.dispose();
});
