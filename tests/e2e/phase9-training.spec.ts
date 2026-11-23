import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  WorkspacePayload,
  WorkspacePlayer,
} from "../../src/domain/workspace";
import type {
  AttendanceHistory,
  FootballSeries,
  FootballSession,
  FootballSquad,
  FootballVenue,
  SessionWrapUp,
} from "../../src/domain/training";

// Phase 9 in a real browser (playwright.training.config.ts). One academy, an
// owner, two coaches and two parents, each used the way they would be:
//  1  the owner repeats a session weekly: preview, holidays, a booking conflict,
//     then creates the sessions
//  2  a coach sees only their own series; the other coach sees none
//  3  a parent sees only their own child's sessions
//  4  one session is cancelled: only that date, each parent e-mailed once
//  5  processing the series again adds nothing and does not undo the cancellation
//  6  the whole series is cancelled: one summary e-mail per parent, outcome shown
//  7  attendance history, percentage and the follow-up flag (staff only)
//  8  session wrap-up, private to staff
//  9  the new screens fit a phone
test.use({ actionTimeout: 15000 });
test.describe.configure({ mode: "serial" });
const origin = "http://127.0.0.1:3018";
const settle = () => new Promise((r) => setTimeout(r, 11000)); // 3 sign-ups per 10 s
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (date: string, days: number) =>
  iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
function mondayAfter(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}
const mailDir = () => resolve(process.env.SPORTOZEN_EMAIL_PREVIEW_DIR!);
type Mail = { to: string; subject: string; text: string };
function mails(): Mail[] {
  try {
    return readdirSync(mailDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(resolve(mailDir(), f), "utf8")));
  } catch {
    return [];
  }
}
const mailsFor = (address: string, subject: RegExp) =>
  mails().filter((m) => m.to === address && subject.test(m.subject));

type Person = {
  api: APIRequestContext;
  email: string;
  id: string;
  name: string;
};
let owner: Person,
  coachA: Person,
  coachB: Person,
  parent1: Person,
  parent2: Person;
let aid = "",
  root = "";
let branchId = "",
  venue: FootballVenue,
  squadU12: FootballSquad,
  squadU14: FootballSquad,
  drillId = "";
let c1: WorkspacePlayer, c2: WorkspacePlayer, c3: WorkspacePlayer;
// The series: Mondays and Wednesdays for three weeks.
const M1 = mondayAfter(14),
  W1 = plus(M1, 2),
  M2 = plus(M1, 7),
  W2 = plus(M1, 9),
  M3 = plus(M1, 14),
  W3 = plus(M1, 16);
let series: FootballSeries;

const get = async <T>(api: APIRequestContext, path: string, status = 200) => {
  const response = await api.get(`${root}${path}`);
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
};
async function post<T>(
  api: APIRequestContext,
  path: string,
  data: unknown,
  status = 200,
) {
  const response = await api.post(path, { data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}
const command = <T>(
  action: string,
  data: unknown,
  id?: string,
  expectedVersion = 0,
  api = owner.api,
) =>
  post<T>(api, `${root}/training`, {
    requestId: crypto.randomUUID(),
    action,
    data,
    id,
    expectedVersion,
  });
const payload = (api = owner.api) => get<WorkspacePayload>(api, "");
const seriesSessions = async () =>
  (await payload()).records.session
    .filter((s) => s.seriesId === series.id)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
async function open(who: Person, width = 1536) {
  const context = await who.api
    .storageState()
    .then((storageState) =>
      pw.browser.newContext({
        storageState,
        viewport: { width, height: width > 600 ? 1024 : 844 },
      }),
    );
  contexts.push(context);
  const page = await context.newPage();
  pageErrors.set(page, []);
  page.on("pageerror", (e) => pageErrors.get(page)!.push(e.message));
  return page;
}
const pw = {} as { browser: import("@playwright/test").Browser };
const contexts: BrowserContext[] = [];
const pageErrors = new Map<Page, string[]>();
const trainingResponse = (page: Page, action: string) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `${root}/training` &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.action === action,
  );
const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );

test.beforeAll(async ({ playwright, browser }) => {
  test.setTimeout(420000);
  pw.browser = browser;
  const suffix = crypto.randomUUID().slice(0, 8);
  let count = 0;
  async function account(name: string): Promise<Person> {
    if (count++) await settle();
    const api = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    const email = `${name.toLowerCase()}-${suffix}@example.test`;
    const response = await api.post("/api/auth/sign-up/email", {
      data: { name, email, password: `Synthetic-only-${crypto.randomUUID()}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { api, email, id: (await response.json()).user.id as string, name };
  }
  owner = await account("TrainingOwner");
  coachA = await account("CoachAlpha");
  coachB = await account("CoachBravo");
  parent1 = await account("ParentOne");
  parent2 = await account("ParentTwo");
  const academy = await post<{ id: string }>(
    owner.api,
    "/api/workspaces",
    {
      name: "Phase Nine Training Academy",
      contactEmail: "phase9@example.test",
      country: "IN",
      language: "English",
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
  aid = academy.id;
  root = `/api/workspaces/${aid}`;
  const invite = (email: string, role: string, playerIds?: string[]) =>
    post<{ token: string }>(owner.api, `${root}/actions`, {
      action: "invite",
      data: {
        email,
        role,
        ...(playerIds ? { playerIds, guardianVerified: true } : {}),
      },
    });
  const save = <T>(kind: string, data: unknown) =>
    post<T>(owner.api, `${root}/records/${kind}`, data, 201);
  for (const person of [coachA, coachB])
    await post(person.api, "/api/invitations/accept", {
      token: (await invite(person.email, "COACH")).token,
    });
  const branch = await save<{ id: string }>("branch", {
    name: "Phase Nine Branch",
    timezone: "Asia/Kolkata",
  });
  branchId = branch.id;
  drillId = (
    await save<{ id: string }>("drill", {
      name: "Phase nine passing square",
      category: "passing-combination-play",
      sportId: "football",
      focusArea: "Passing",
      purpose: "Pass accurately under light pressure",
      cue: "Open body, firm pass",
    })
  ).id;
  const player = (name: string, coach: Person) =>
    save<WorkspacePlayer>("player", { birthDate: "2015-05-05",
      name,
      squad: "U12",
      ageCategory: "U12",
      coachId: coach.id,
      sportIds: ["football"],
      status: "ACTIVE",
    });
  c1 = await player("Synthetic Asha", coachA);
  c2 = await player("Synthetic Kabir", coachA);
  c3 = await player("Synthetic Meera", coachB);
  squadU12 = await command<FootballSquad>("squad", {
    name: "Synthetic U12",
    branchId,
    playerIds: [c1.id, c2.id],
  });
  squadU14 = await command<FootballSquad>("squad", {
    name: "Synthetic U14",
    branchId,
    playerIds: [c3.id],
  });
  venue = await command<FootballVenue>("venue", {
    name: "Synthetic Main Pitch",
    branchId,
    location: "Synthetic Ground",
  });
  await post(parent1.api, "/api/invitations/accept", {
    token: (await invite(parent1.email, "PARENT", [c1.id])).token,
  });
  await post(parent2.api, "/api/invitations/accept", {
    token: (await invite(parent2.email, "PARENT", [c2.id])).token,
  });
  // A booking on the first Wednesday that clashes with the series: Coach Bravo's
  // U14 uses the same pitch at the same time.
  const blocker = await command<FootballSession>("session", {
    branchId,
    squadId: squadU14.id,
    venueId: venue.id,
    location: venue.location,
    coachIds: [coachB.id],
    timezone: "Asia/Kolkata",
    startLocal: `${W1}T17:00`,
    endLocal: `${W1}T18:00`,
    theme: "U14 booking",
    agenda: [],
  });
  await command("status", { status: "SCHEDULED" }, blocker.id, blocker.version);
});
test.afterAll(async () => {
  for (const context of contexts) await context.close();
});

test("1 · the owner repeats a session weekly: preview, holiday, conflict, create", async () => {
  const page = await open(owner);
  await page.goto(`/workspace/${aid}?section=calendar&date=${M1}&view=Week`);
  await page.getByRole("button", { name: "Repeat weekly" }).click();
  const dialog = page.getByRole("dialog", { name: "Repeat weekly" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Batch").selectOption({ label: "Synthetic U12" });
  await dialog
    .getByLabel("Training space")
    .selectOption({ label: "Synthetic Main Pitch" });
  await expect(dialog.getByLabel("Location", { exact: true })).toHaveValue(
    "Synthetic Ground",
  );
  await dialog.getByRole("checkbox", { name: "Monday", exact: true }).check();
  await dialog
    .getByRole("checkbox", { name: "Wednesday", exact: true })
    .check();
  await dialog.getByLabel("First date").fill(M1);
  await dialog.getByLabel("Last date").fill(W3);
  await dialog.getByLabel("Start time").fill("17:00");
  await dialog.getByLabel("End time").fill("18:00");
  await dialog.getByRole("checkbox", { name: coachA.name }).check();
  await dialog.getByRole("button", { name: "Add a drill" }).click();
  await dialog.getByLabel("Minutes for drill 1").fill("30");
  await dialog.getByRole("button", { name: "Add a holiday" }).click();
  await dialog.getByLabel("Holiday date 1").fill(W2);
  await dialog.getByLabel("Holiday name 1").fill("Diwali break");
  // Nothing is created by previewing.
  const before = (await payload()).records.session.length;
  const previewed = trainingResponse(page, "seriesPreview");
  await dialog.getByRole("button", { name: "Preview dates" }).click();
  expect((await previewed).status()).toBe(200);
  await expect(dialog.getByTestId("preview-count")).toHaveText(
    "4 sessions will be created",
  );
  const skipped = dialog.getByRole("list", {
    name: "Dates that will be skipped",
  });
  await expect(skipped).toContainText("Holiday");
  await expect(skipped).toContainText("Diwali break");
  await expect(skipped).toContainText("Booking conflict");
  await expect(skipped).toContainText(/venue/);
  expect((await payload()).records.session.length).toBe(before);
  // Changing the rule invalidates the preview: it must be previewed again.
  await dialog.getByLabel("End time").fill("18:30");
  await expect(dialog.getByRole("button", { name: /^Create/ })).toHaveCount(0);
  await dialog.getByLabel("End time").fill("18:00");
  await dialog.getByRole("button", { name: "Preview dates" }).click();
  await expect(dialog.getByTestId("preview-count")).toHaveText(
    "4 sessions will be created",
  );
  const created = trainingResponse(page, "series");
  await dialog.getByRole("button", { name: "Create 4 sessions" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(200);
  series = (await response.json()) as FootballSeries;
  await expect(
    dialog.getByText("Series created, with some dates skipped"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("list", { name: "Dates that will be skipped" }),
  ).toContainText("Diwali break");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const sessions = await seriesSessions();
  expect(sessions.map((s) => s.occurrenceDate)).toEqual([M1, M2, M3, W3]);
  expect(
    sessions.every(
      (s) => s.status === "SCHEDULED" && s.squadId === squadU12.id,
    ),
  ).toBe(true);
  expect(sessions[0]).toMatchObject({
    startLocal: `${M1}T17:00`,
    startAt: `${M1}T11:30:00.000Z`,
    coachIds: [coachA.id],
  });
  expect(series.skipped.map((s) => [s.date, s.reason]).sort()).toEqual(
    [
      [W1, "CONFLICT"],
      [W2, "EXCLUDED"],
    ].sort(),
  );
  const attendance = (await payload()).records.attendance.filter(
    (a) => a.sessionId === sessions[0].id,
  );
  expect(attendance.map((a) => a.status)).toEqual(["UNMARKED", "UNMARKED"]);
  // The calendar shows the new sessions and the series summary on one of them.
  await page.goto(
    `/workspace/${aid}?section=calendar&date=${M1}&view=Week&session=${sessions[0].id}`,
  );
  const panel = page.locator(".pc-desktop-panel .pc-panel");
  await expect(panel).toHaveAttribute("data-session-id", sessions[0].id);
  const summary = panel.getByLabel("Weekly series");
  await expect(summary).toContainText("Mondays and Wednesdays");
  await expect(summary).toContainText("17:00-18:00");
  await expect(summary).toContainText("2 dates not scheduled");
  expect(pageErrors.get(page)).toEqual([]);
});

test("2 · a coach sees only their own series; the other coach sees none", async () => {
  const sessions = await seriesSessions();
  const first = sessions[0];
  const alpha = await open(coachA);
  await alpha.goto(
    `/workspace/${aid}?section=calendar&date=${M1}&view=Week&session=${first.id}`,
  );
  await expect(
    alpha.locator(`.pc-view-week button[data-session-id="${first.id}"]`),
  ).toHaveCount(1);
  await expect(
    alpha.locator(".pc-desktop-panel .pc-panel").getByLabel("Weekly series"),
  ).toContainText("Mondays and Wednesdays");

  const bravo = await open(coachB);
  await bravo.goto(`/workspace/${aid}?section=calendar&date=${M1}&view=Week`);
  await expect(
    bravo.getByRole("heading", { name: "Calendar", exact: true }),
  ).toBeVisible();
  for (const s of sessions)
    await expect(
      bravo.locator(`button[data-session-id="${s.id}"]`),
    ).toHaveCount(0);
  await bravo.getByRole("button", { name: "Repeat weekly" }).click();
  const options = bravo
    .getByRole("dialog", { name: "Repeat weekly" })
    .getByLabel("Batch")
    .locator("option");
  await expect(options).toHaveText(["Synthetic U14"]);
  // The server agrees, not just the screen.
  expect(
    (await get<FootballSeries[]>(coachB.api, "/records/series")).length,
  ).toBe(0);
  expect(
    (await get<FootballSeries[]>(coachA.api, "/records/series")).map(
      (s) => s.id,
    ),
  ).toEqual([series.id]);
  const refused = await coachB.api.post(`${root}/training`, {
    data: {
      requestId: crypto.randomUUID(),
      action: "seriesCancel",
      id: series.id,
      expectedVersion: series.version,
      data: { reason: "Not mine to cancel" },
    },
  });
  expect(refused.status()).toBe(404);
  expect((await seriesSessions()).every((s) => s.status === "SCHEDULED")).toBe(
    true,
  );
});

test("3 · a parent sees only their own child's sessions", async () => {
  const one = await open(parent1);
  await one.goto(`/workspace/${aid}?section=calendar&player=${c1.id}`);
  await expect(
    one.getByRole("heading", { name: "Training schedule" }),
  ).toBeVisible();
  await expect(one.locator('[data-session-status="SCHEDULED"]')).toHaveCount(4);
  await expect(one.locator('[data-session-status="CANCELLED"]')).toHaveCount(0);
  await expect(one.locator("main, body").first()).not.toContainText(
    "Synthetic Kabir",
  );
  const two = await open(parent2);
  await two.goto(`/workspace/${aid}?section=calendar&player=${c2.id}`);
  await expect(two.locator('[data-session-status="SCHEDULED"]')).toHaveCount(4);
  await expect(two.locator("body")).not.toContainText("Synthetic Asha");
  // The server will not hand over another family's data either.
  const other = await parent1.api.get(
    `${root}/attendance-history?player=${c2.id}`,
  );
  expect(other.status()).toBe(404);
  expect((await get<unknown[]>(parent1.api, "/records/series")).length).toBe(0);
  expect(
    (await get<unknown[]>(parent1.api, "/records/wrapup?session=x")).length,
  ).toBe(0);
});

test("4 · cancelling one session cancels only that date and e-mails each parent once", async () => {
  const sessions = await seriesSessions();
  const target = sessions[1]; // M2
  const page = await open(owner);
  await page.goto(
    `/workspace/${aid}?section=calendar&date=${M2}&view=Week&session=${target.id}`,
  );
  const panel = page.locator(".pc-desktop-panel .pc-panel");
  await expect(panel).toHaveAttribute("data-session-id", target.id);
  await panel.getByRole("button", { name: "Cancel session" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel session" });
  await expect(
    dialog.getByRole("radio", { name: /Only this session/ }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", {
      name: /whole weekly series \(4 upcoming sessions\)/,
    }),
  ).toBeVisible();
  await dialog
    .getByLabel("Cancellation reason")
    .fill("Pitch waterlogged, internal note");
  const saved = trainingResponse(page, "status");
  await dialog.getByRole("button", { name: "Confirm cancellation" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();

  const after = await seriesSessions();
  expect(after.map((s) => s.status)).toEqual([
    "SCHEDULED",
    "CANCELLED",
    "SCHEDULED",
    "SCHEDULED",
  ]);
  expect(after[1].cancelledFrom).toBe("SCHEDULED");
  expect(
    (await get<FootballSeries[]>(owner.api, "/records/series"))[0],
  ).toMatchObject({ status: "ACTIVE", version: series.version });

  // Each parent is e-mailed once; nobody else is; the staff reason is not in it.
  await expect
    .poll(() => mailsFor(parent1.email, /Training session cancelled/).length)
    .toBe(1);
  await expect
    .poll(() => mailsFor(parent2.email, /Training session cancelled/).length)
    .toBe(1);
  const mail = mailsFor(parent1.email, /Training session cancelled/)[0];
  expect(mail.text).not.toMatch(/waterlogged|internal note/);
  expect(mail.text).toContain("Synthetic Ground");
  for (const other of [owner, coachA, coachB])
    expect(mailsFor(other.email, /cancelled/i)).toHaveLength(0);

  // The parent's schedule shows what changed instead of dropping it.
  const parent = await open(parent1);
  await parent.goto(`/workspace/${aid}?section=calendar&player=${c1.id}`);
  await expect(parent.locator('[data-session-status="CANCELLED"]')).toHaveCount(
    1,
  );
  await expect(parent.locator('[data-session-status="SCHEDULED"]')).toHaveCount(
    3,
  );
  await expect(
    parent.locator('[data-session-status="CANCELLED"]'),
  ).toContainText("This session has been cancelled.");
  await expect(parent.locator("body")).not.toContainText("waterlogged");
});

test("5 · processing the series again adds nothing and does not undo the cancellation", async () => {
  const current = (
    await get<FootballSeries[]>(owner.api, "/records/series")
  )[0];
  const before = (await payload()).records.session.length;
  const synced = await command<FootballSeries>(
    "seriesSync",
    {},
    current.id,
    current.version,
  );
  expect(synced.version).toBe(current.version + 1);
  const again = await command<FootballSeries>(
    "seriesSync",
    {},
    current.id,
    synced.version,
  );
  expect(again.version).toBe(synced.version + 1);
  expect((await payload()).records.session.length).toBe(before);
  expect((await seriesSessions()).map((s) => s.status)).toEqual([
    "SCHEDULED",
    "CANCELLED",
    "SCHEDULED",
    "SCHEDULED",
  ]);
  // A stale second processor is refused rather than writing twice.
  const stale = await owner.api.post(`${root}/training`, {
    data: {
      requestId: crypto.randomUUID(),
      action: "seriesSync",
      id: current.id,
      expectedVersion: current.version,
      data: {},
    },
  });
  expect(stale.status()).toBe(409);
});

test("6 · cancelling the whole series: one summary e-mail per parent and an honest outcome", async () => {
  const sessions = await seriesSessions();
  const page = await open(owner);
  await page.goto(
    `/workspace/${aid}?section=calendar&date=${M1}&view=Week&session=${sessions[0].id}`,
  );
  const panel = page.locator(".pc-desktop-panel .pc-panel");
  await expect(panel).toHaveAttribute("data-session-id", sessions[0].id);
  await panel.getByRole("button", { name: "Cancel session" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel session" });
  await dialog
    .getByRole("radio", { name: /whole weekly series \(3 upcoming sessions\)/ })
    .check();
  await dialog
    .getByLabel("Cancellation reason")
    .fill("Academy closed for the term");
  const saved = trainingResponse(page, "seriesCancel");
  await dialog.getByRole("button", { name: "Confirm cancellation" }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  await expect(
    dialog.getByText("The weekly series is cancelled."),
  ).toBeVisible();
  await expect(dialog.getByText("3 sessions cancelled.")).toBeVisible();
  await expect(dialog.getByTestId("notice-report")).toContainText(
    "Parent emails: 2 queued",
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  expect((await seriesSessions()).every((s) => s.status === "CANCELLED")).toBe(
    true,
  );
  const final = (await get<FootballSeries[]>(owner.api, "/records/series"))[0];
  expect(final).toMatchObject({
    status: "CANCELLED",
    cancelReason: "Academy closed for the term",
  });
  expect(final.cancelOutcome).toMatchObject({ cancelled: 3, left: [] });
  expect(final.cancelOutcome!.notices).toMatchObject({
    emailEnabled: true,
    guardians: 2,
    queued: 2,
    refused: 0,
  });

  // One summary per parent (3 dates in one message), plus the earlier single notice.
  for (const parent of [parent1, parent2]) {
    await expect
      .poll(() => mailsFor(parent.email, /Weekly training cancelled/).length)
      .toBe(1);
    expect(
      mailsFor(parent.email, /Weekly training cancelled: 3 sessions/),
    ).toHaveLength(1);
    expect(mailsFor(parent.email, /Training session cancelled/)).toHaveLength(
      1,
    );
    expect(mailsFor(parent.email, /cancelled/i)).toHaveLength(2);
  }
  // A cancelled series cannot be processed or cancelled again.
  for (const action of ["seriesSync", "seriesCancel"]) {
    const refused = await owner.api.post(`${root}/training`, {
      data: {
        requestId: crypto.randomUUID(),
        action,
        id: final.id,
        expectedVersion: final.version,
        data: { reason: "again please" },
      },
    });
    expect(refused.status()).toBe(409);
  }
  // The series screen keeps the record of what happened.
  await page.goto(
    `/workspace/${aid}?section=calendar&date=${M1}&view=Week&session=${sessions[0].id}`,
  );
  await expect(
    page.locator(".pc-desktop-panel .pc-panel").getByLabel("Weekly series"),
  ).toContainText("Cancelled");
  await expect(
    page.locator(".pc-desktop-panel .pc-panel").getByLabel("Weekly series"),
  ).toContainText("3 sessions cancelled.");
  const parent = await open(parent2);
  await parent.goto(`/workspace/${aid}?section=calendar&player=${c2.id}`);
  await expect(parent.locator('[data-session-status="CANCELLED"]')).toHaveCount(
    4,
  );
  await expect(parent.locator('[data-session-status="SCHEDULED"]')).toHaveCount(
    0,
  );
});

const held: FootballSession[] = [];
test("7 · attendance history, percentage and the follow-up flag", async () => {
  // Five finished sessions in the past: Asha: present, absent, excused, absent, absent.
  const marks: Record<string, "PRESENT" | "ABSENT" | "EXCUSED">[] = [
    { [c1.id]: "PRESENT", [c2.id]: "PRESENT" },
    { [c1.id]: "ABSENT", [c2.id]: "PRESENT" },
    { [c1.id]: "EXCUSED", [c2.id]: "PRESENT" },
    { [c1.id]: "ABSENT", [c2.id]: "PRESENT" },
    { [c1.id]: "ABSENT", [c2.id]: "PRESENT" },
  ];
  for (const [index, mark] of marks.entries()) {
    const date = plus(iso(new Date()), -(40 - index * 7));
    const draft = await command<FootballSession>("session", {
      branchId,
      squadId: squadU12.id,
      venueId: venue.id,
      location: venue.location,
      coachIds: [coachA.id],
      timezone: "Asia/Kolkata",
      startLocal: `${date}T10:00`,
      endLocal: `${date}T11:00`,
      theme: `Held session ${index + 1}`,
      agenda: [{ drillId, duration: 30 }],
    });
    let s = await command<FootballSession>(
      "status",
      { status: "SCHEDULED" },
      draft.id,
      draft.version,
    );
    s = await command<FootballSession>(
      "status",
      { status: "IN_PROGRESS" },
      s.id,
      s.version,
    );
    const records = (await payload()).records.attendance.filter(
      (a) => a.sessionId === s.id,
    );
    await command(
      "attendance",
      {
        entries: records.map((a) => ({
          playerId: a.playerId,
          status: mark[a.playerId],
          expectedVersion: a.version,
        })),
      },
      s.id,
    );
    s = await command<FootballSession>(
      "status",
      { status: "COMPLETED" },
      s.id,
      s.version,
    );
    held.push(s);
  }
  // The numbers, from the server.
  const history = await get<AttendanceHistory>(
    owner.api,
    `/attendance-history?player=${c1.id}`,
  );
  expect(history).toMatchObject({
    counted: 5,
    present: 1,
    absent: 3,
    excused: 1,
    percentage: 20,
    consecutiveAbsences: 3,
    followUp: true,
  });
  // Excused neither counts toward nor ends the run: absent, absent, (excused), absent.
  expect(
    await get<AttendanceHistory>(
      owner.api,
      `/attendance-history?player=${c2.id}`,
    ),
  ).toMatchObject({ percentage: 100, followUp: false });

  // Staff screen: the follow-up list, then the history.
  const page = await open(owner);
  await page.goto(`/workspace/${aid}?section=training`);
  const list = page.getByRole("region", {
    name: "Attendance follow-up",
    exact: true,
  });
  await expect(list).toContainText("Synthetic Asha");
  await expect(list).toContainText("missed 3 sessions in a row");
  await expect(list).toContainText("20% attendance");
  await expect(list).not.toContainText("Synthetic Kabir");
  await list.getByRole("button", { name: "View history" }).click();
  const table = list.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(5);
  await expect(table.locator("tbody tr").first()).toContainText("Absent");
  await expect(list.getByRole("alert")).toContainText("Follow-up needed");

  // The coach who owns the child sees the flag; the other coach does not.
  const alpha = await open(coachA);
  await alpha.goto(`/workspace/${aid}?section=training`);
  await expect(
    alpha.getByRole("region", { name: "Attendance follow-up" }),
  ).toContainText("Synthetic Asha");
  const bravo = await open(coachB);
  await bravo.goto(`/workspace/${aid}?section=training`);
  await expect(
    bravo.getByRole("region", { name: "Attendance follow-up" }),
  ).toContainText("No player has missed three sessions in a row.");
  expect(
    (
      await bravo
        .context()
        .request.get(`${origin}${root}/attendance-history?player=${c1.id}`)
    ).status(),
  ).toBe(404);

  // A parent sees the child's history and percentage, not the flag.
  const parent = await open(parent1);
  await parent.goto(`/workspace/${aid}?section=calendar&player=${c1.id}`);
  const section = parent.getByRole("region", {
    name: "Attendance",
    exact: true,
  });
  await expect(section.getByTestId("attendance-percentage")).toHaveText("20%");
  await expect(section.getByRole("table").locator("tbody tr")).toHaveCount(5);
  await expect(section).not.toContainText(/follow-up/i);
  await expect(section).not.toContainText("Correction note");
  const own = await get<AttendanceHistory>(
    parent1.api,
    `/attendance-history?player=${c1.id}`,
  );
  expect("followUp" in own).toBe(false);
  expect(
    (await parent1.api.get(`${root}/attendance-history?followUp=1`)).status(),
  ).toBe(403);
  const parentTwo = await open(parent2);
  await parentTwo.goto(`/workspace/${aid}?section=calendar&player=${c2.id}`);
  await expect(
    parentTwo
      .getByRole("region", { name: "Attendance", exact: true })
      .getByTestId("attendance-percentage"),
  ).toHaveText("100%");
  expect(pageErrors.get(page)).toEqual([]);
});

test("8 · session wrap-up is saved by staff and never reaches a parent", async () => {
  const session = held[4];
  const page = await open(owner);
  await page.goto(`/workspace/${aid}?section=training&session=${session.id}`);
  await page.getByRole("button", { name: "Wrap-up", exact: true }).click();
  const form = page.getByRole("form", { name: "Session wrap-up" });
  await expect(form.getByTestId("wrapup-summary")).toContainText(
    "1 of 1 drills completed · 30 of 30 planned minutes",
  );
  await form
    .getByLabel("Outcome for Phase nine passing square")
    .selectOption("PARTIAL");
  await form
    .getByLabel("Minutes done for Phase nine passing square")
    .fill("20");
  await form
    .getByLabel("Note for Phase nine passing square")
    .fill("Ran short on time");
  await expect(form.getByTestId("wrapup-summary")).toContainText(
    "0 of 1 drills completed · 20 of 30 planned minutes",
  );
  await form
    .getByLabel("Coach observations")
    .fill("PRIVATE-OBSERVATION good intensity");
  await form
    .getByLabel("Achievements")
    .fill("PRIVATE-ACHIEVEMENT everyone finished");
  await form
    .getByLabel("Improvement notes")
    .fill("PRIVATE-IMPROVEMENT weaker foot");
  const saved = trainingResponse(page, "wrapup");
  await form.getByRole("button", { name: "Save wrap-up" }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  const record = (await response.json()) as SessionWrapUp;
  expect(record).toMatchObject({ id: session.id, version: 1 });
  expect(record.drills[0]).toMatchObject({
    plannedMinutes: 30,
    outcome: "PARTIAL",
    actualMinutes: 20,
  });

  // It survives a reload, and an edit makes a new version.
  await page.reload();
  await page.getByRole("button", { name: "Wrap-up", exact: true }).click();
  const again = page.getByRole("form", { name: "Session wrap-up" });
  await expect(again.getByLabel("Coach observations")).toHaveValue(
    "PRIVATE-OBSERVATION good intensity",
  );
  await expect(
    again.getByLabel("Outcome for Phase nine passing square"),
  ).toHaveValue("PARTIAL");
  await again
    .getByLabel("Improvement notes")
    .fill("PRIVATE-IMPROVEMENT weaker foot and scanning");
  const second = trainingResponse(page, "wrapup");
  await again.getByRole("button", { name: "Update wrap-up" }).click();
  expect(((await (await second).json()) as SessionWrapUp).version).toBe(2);

  // Completing a session never needed it: the other four have none.
  expect(
    (await get<SessionWrapUp[]>(owner.api, `/records/wrapup`)).map(
      (w) => w.sessionId,
    ),
  ).toEqual([session.id]);

  // Private to staff: the coach with the session can read it, nobody else can.
  expect(
    (
      await get<SessionWrapUp[]>(
        coachA.api,
        `/records/wrapup?session=${session.id}`,
      )
    ).length,
  ).toBe(1);
  expect(
    (
      await get<SessionWrapUp[]>(
        coachB.api,
        `/records/wrapup?session=${session.id}`,
      )
    ).length,
  ).toBe(0);
  expect(
    (
      await get<SessionWrapUp[]>(
        parent1.api,
        `/records/wrapup?session=${session.id}`,
      )
    ).length,
  ).toBe(0);
  for (const parent of [parent1, parent2]) {
    const full = JSON.stringify(await get(parent.api, ""));
    expect(full).not.toMatch(/PRIVATE-/);
    expect(
      JSON.stringify(await get(parent.api, "?kinds=wrapup,session,series")),
    ).not.toMatch(/PRIVATE-/);
  }
  const refused = await parent1.api.post(`${root}/training`, {
    data: {
      requestId: crypto.randomUUID(),
      action: "wrapup",
      id: session.id,
      expectedVersion: 2,
      data: { observations: "x" },
    },
  });
  expect(refused.status()).toBe(403);
  const parent = await open(parent1);
  await parent.goto(`/workspace/${aid}?section=calendar&player=${c1.id}`);
  await expect(parent.locator("body")).not.toContainText("PRIVATE-");
  await expect(parent.locator("body")).not.toContainText("Wrap-up");
});

test("9 · the new screens fit a phone", async () => {
  const page = await open(owner, 390);
  await page.goto(`/workspace/${aid}?section=calendar&date=${M1}&view=Agenda`);
  await page.getByRole("button", { name: "Repeat weekly" }).click();
  const dialog = page.getByRole("dialog", { name: "Repeat weekly" });
  await expect(dialog).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  await page.goto(`/workspace/${aid}?section=training`);
  await expect(
    page.getByRole("region", { name: "Attendance follow-up" }),
  ).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  const parent = await open(parent1, 390);
  await parent.goto(`/workspace/${aid}?section=calendar&player=${c1.id}`);
  await expect(
    parent.getByRole("region", { name: "Attendance", exact: true }),
  ).toBeVisible();
  expect(await noHorizontalScroll(parent)).toBe(true);
});
