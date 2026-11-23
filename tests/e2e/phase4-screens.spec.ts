import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  WorkspacePlayer,
  WorkspacePlan,
} from "../../src/domain/workspace";
import type { FootballSession, FootballSquad } from "../../src/domain/training";

/**
 * Phase 4: real, database-backed screens for Owner, Coach and Parent at four viewports.
 * Captures screenshots and enforces objective accessibility and layout checks:
 * every control has an accessible name, images have alt text, one h1 per screen, no duplicate ids,
 * no horizontal page overflow, no page errors. Text contrast is measured and recorded
 * (only flat backgrounds are measured; gradients and images are skipped).
 * Accounts are created through the normal sign-up API and roles come from real invitations;
 * no authorization is bypassed.
 */
test.use({ actionTimeout: 15000 });

const origin = "http://127.0.0.1:3001";
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 720 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const shots = resolve(process.env.PHASE4_SHOTS ?? "docs/screenshots/phase4/after");

type Audit = {
  page: string;
  viewport: string;
  unnamedControls: string[];
  imagesWithoutAlt: string[];
  h1Count: number;
  duplicateIds: string[];
  overflow: boolean;
  contrastFailures: { text: string; ratio: number; fg: string; bg: string }[];
  contrastChecked: number;
};

async function audit(page: Page, label: string, viewport: string): Promise<Audit> {
  const result = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => text(document.getElementById(id) ?? document.body.ownerDocument.createElement("i"))).join(" ").trim();
        if (t) return t;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) return Array.from(labels).map(text).join(" ").trim();
      const t = text(el);
      if (t) return t;
      const img = el.querySelector("img[alt]");
      if (img?.getAttribute("alt")?.trim()) return img.getAttribute("alt")!.trim();
      const svgTitle = el.querySelector("svg title");
      if (svgTitle) return text(svgTitle);
      return (el.getAttribute("title") ?? (el as HTMLInputElement).placeholder ?? (["submit", "button"].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "") ?? "").trim();
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
    const controls = Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox]")).filter(visible);
    const unnamedControls = controls.filter((el) => !nameOf(el)).map(describe);
    const imagesWithoutAlt = Array.from(document.querySelectorAll("img")).filter((img) => !img.hasAttribute("alt")).map((img) => img.getAttribute("src") ?? "");
    const h1Count = Array.from(document.querySelectorAll("h1")).filter(visible).length;
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    // contrast on flat backgrounds
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number }) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const backgroundOf = (el: Element): { r: number; g: number; b: number } | null => {
      const layers: { r: number; g: number; b: number; a: number }[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage !== "none") return null;
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
      }
      let base = { r: 255, g: 255, b: 255 };
      for (const l of layers.reverse()) base = blend(l, base);
      return base;
    };
    const failures: { text: string; ratio: number; fg: string; bg: string }[] = [];
    let checked = 0;
    const seen = new Set<string>();
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim()).map((n) => n.textContent!.trim()).join(" ");
      if (!own || !visible(el) || (el as HTMLButtonElement).disabled || el.closest("[disabled], [aria-disabled=true]")) continue;
      const s = getComputedStyle(el);
      if (Number(s.opacity) < 1 || el.closest("script, style")) continue;
      const bg = backgroundOf(el);
      const fgRaw = parse(s.color);
      if (!bg || !fgRaw) continue;
      const fg = blend(fgRaw, bg);
      const l1 = lum(fg) + 0.05, l2 = lum(bg) + 0.05;
      const ratio = Math.max(l1, l2) / Math.min(l1, l2);
      checked++;
      const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      if (ratio < (large ? 3 : 4.5)) {
        const key = own.slice(0, 40) + s.color;
        if (!seen.has(key)) { seen.add(key); failures.push({ text: own.slice(0, 50), ratio: Math.round(ratio * 100) / 100, fg: s.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` }); }
      }
    }
    return { unnamedControls, imagesWithoutAlt, h1Count, duplicateIds, overflow, contrastFailures: failures.slice(0, 40), contrastChecked: checked };
  });
  return { page: label, viewport, ...result };
}

/** The official Sportozen symbol is shown, fully loaded, and is the same file everywhere. */
async function expectPlatformSymbol(page: Page, where: string) {
  const symbols = page.locator("img.sportozen-symbol:visible");
  await expect(symbols, `${where}: platform symbol`).toHaveCount(1);
  const info = await symbols.first().evaluate((img: HTMLImageElement) => ({
    src: new URL(img.currentSrc).pathname,
    loaded: img.complete && img.naturalWidth > 0,
    height: Math.round(img.getBoundingClientRect().height),
    width: Math.round(img.getBoundingClientRect().width),
  }));
  expect(info.src, where).toBe("/brand/sportozen-logo.png");
  expect(info.loaded, `${where}: image loaded`).toBe(true);
  expect(info.height, `${where}: visible size`).toBeGreaterThanOrEqual(28);
  expect(info.width / info.height, `${where}: aspect ratio kept`).toBeGreaterThan(0.78);
  expect(info.width / info.height, `${where}: aspect ratio kept`).toBeLessThan(0.88);
}

async function ready(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

test("Owner, Coach and Parent screens render real data accessibly at four viewports", async ({ playwright, browser }) => {
  test.setTimeout(900000);
  await mkdir(shots, { recursive: true });
  const suffix = crypto.randomUUID();
  let registrations = 0;
  async function account(name: string) {
    if (registrations++) await new Promise((r) => setTimeout(r, 11000));
    const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    const email = `${name}-${suffix}@example.test`;
    const password = `Synthetic-only-${crypto.randomUUID()}`;
    const response = await api.post("/api/auth/sign-up/email", { data: { name, email, password } });
    expect(response.status(), await response.text()).toBe(200);
    return { api, email, password, id: (await response.json()).user.id as string };
  }
  const owner = await account("PortalOwner"), coach = await account("PortalCoach"), parent = await account("PortalParent");
  async function post<T>(api: APIRequestContext, path: string, data: unknown, status = 200): Promise<T> {
    const response = await api.post(path, { data });
    expect(response.status(), await response.text()).toBe(status);
    return response.json() as Promise<T>;
  }
  const academy = await post<{ id: string }>(owner.api, "/api/workspaces", {
    name: "Riverside Football Academy", contactEmail: "synthetic-academy@example.test", country: "IN", language: "en", currency: "INR",
    timezone: "Asia/Kolkata", dateLocale: "en-IN", measurementSystem: "METRIC", brandAccent: "#2364a1",
    modules: ["development", "reports", "communication", "fees"], demo: false,
  }, 201);
  const root = `/api/workspaces/${academy.id}`;
  const save = <T>(kind: string, data: unknown, api = owner.api) => post<T>(api, `${root}/records/${kind}`, data, 201);
  const action = <T>(name: string, id?: string, data?: unknown) => post<T>(owner.api, `${root}/actions`, { action: name, id, data, verified: true });
  const training = <T>(name: string, data: unknown, id?: string, expectedVersion = 0, api = coach.api) =>
    post<T>(api, `${root}/training`, { requestId: crypto.randomUUID(), action: name, id, expectedVersion, data });
  async function invite(person: typeof coach, role: "COACH" | "PARENT", playerIds: string[] = []) {
    const invitation = await action<{ token: string }>("invite", undefined, { email: person.email, role, playerIds, guardianVerified: role === "PARENT" });
    await post(person.api, "/api/invitations/accept", { token: invitation.token });
  }
  await invite(coach, "COACH");
  const child = await save<WorkspacePlayer>("player", { birthDate: "2015-05-05", name: "Aarav Sharma", squad: "U10", coachId: coach.id });
  const other = await save<WorkspacePlayer>("player", { birthDate: "2015-05-05", name: "Kabir Mehta", squad: "U10", coachId: coach.id });
  await invite(parent, "PARENT", [child.id]);
  const trialPlayer = await save<WorkspacePlayer>("player", { birthDate: "2015-05-05", name: "Rohan Verma", squad: "U10", coachId: coach.id });
  const branch = await save<{ id: string }>("branch", { name: "Main Branch", timezone: "Asia/Kolkata" });
  const drill = await save<{ id: string }>("drill", { name: "Close-control turns", category: "ball-control-dribbling", focusArea: "Dribbling", purpose: "Keep the ball close when changing direction", cue: "Small touches and look up", sportId: "football" }, coach.api);
  const batch = await training<FootballSquad>("squad", { name: "U10 Shared Training", branchId: branch.id, playerIds: [child.id, other.id, trialPlayer.id] }, undefined, 0, owner.api);
  const venue = await training<{ id: string }>("venue", { name: "Main Pitch", branchId: branch.id, location: "Riverside ground", exclusive: true }, undefined, 0, owner.api);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 3);
  const later = next.toISOString().slice(0, 10);
  async function session(date: string, theme: string) {
    const draft = await training<FootballSession>("session", {
      branchId: branch.id, squadId: batch.id, venueId: venue.id, location: "Main Pitch", coachIds: [coach.id], timezone: "Asia/Kolkata",
      startLocal: `${date}T17:00`, endLocal: `${date}T18:00`, theme,
      sharedObjective: { goal: "Keep close control when changing direction", cue: "Small touches", observe: "First touch when changing direction" },
      agenda: [{ drillId: drill.id, duration: 45 }],
    });
    return training<FootballSession>("status", { status: "SCHEDULED" }, draft.id, draft.version);
  }
  const placed = await owner.api.get(`${root}/records/player/${trialPlayer.id}`);
  const trialRecord = (await placed.json()) as WorkspacePlayer & { recordVersion: number };
  const placement = await owner.api.put(`${root}/records/player/${trialPlayer.id}`, {
    data: { ...trialRecord, squadId: batch.id, squad: "U10 Shared Training", placementReviewed: true, expectedVersion: trialRecord.recordVersion },
  });
  expect(placement.status(), await placement.text()).toBe(200);
  const trialEnd = new Date(`${today}T00:00:00Z`);
  trialEnd.setUTCDate(trialEnd.getUTCDate() + 10);
  await post(owner.api, `${root}/trials`, {
    requestId: crypto.randomUUID(), action: "create",
    data: { playerId: trialPlayer.id, squadId: batch.id, coachId: coach.id, startDate: today, endDate: trialEnd.toISOString().slice(0, 10), pricing: "FREE", feeMinor: 0, currency: "INR" },
  });
  await session(today, "Dribbling and finishing");
  await session(later, "Passing patterns");
  await save<WorkspacePlan>("plan", {
    playerId: child.id, coachId: coach.id, focus: "Dribbling", reason: "Keeps the ball closer under pressure", drillIds: [drill.id],
    observe: "Watch first touch direction", homePractice: "Gentle touches in a safe space", reviewDate: later,
    nextStep: "Repeat the activity before changing the task", status: "ACTIVE", privateNote: "Private coach note",
  }, coach.api);

  const roles = [
    { name: "owner", who: owner, screens: ["home", "calendar", "players", "training", "reports", "fees", "settings", "messages"] },
    { name: "coach", who: coach, screens: ["home", "calendar", "players", "training", "reports", "settings", "messages"] },
    { name: "parent", who: parent, screens: ["home", "calendar", "reports", "fees", "settings", "messages", "development", "practice"] },
  ];
  const audits: Audit[] = [];
  const pageErrors: string[] = [];
  for (const viewport of viewports) {
    for (const role of roles) {
      const context = await browser.newContext({ storageState: await role.who.api.storageState(), viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      page.on("pageerror", (e) => pageErrors.push(`${role.name} ${viewport.name}: ${e.message}`));
      for (const screen of role.screens) {
        await page.goto(`/workspace/${academy.id}?section=${screen}`);
        await ready(page);
        const label = `${role.name}-${screen}`;
        await page.screenshot({ path: `${shots}/${viewport.name}-${label}.png`, fullPage: true });
        audits.push(await audit(page, label, viewport.name));
        if (screen === "home" && role.name !== "parent") {
          // Sidebar: platform symbol in the brand block, the academy's own mark separately below it.
          const drawerButton = page.getByRole("button", { name: "Open academy navigation", exact: true });
          if (await drawerButton.isVisible()) {
            // No fixed sidebar on narrow screens: the navigation drawer carries the same brand block.
            await drawerButton.click();
            await expectPlatformSymbol(page, `${viewport.name} ${label} navigation drawer`);
            await page.screenshot({ path: `${shots}/${viewport.name}-${label}-drawer.png` });
            await page.keyboard.press("Escape");
          } else {
            await expectPlatformSymbol(page, `${viewport.name} ${label} sidebar`);
          }
          await expect(page.locator(".portal-academy-logo")).toHaveCount(1);
        }
      }
      if (role.name === "owner") {
        await page.goto(`/workspace/${academy.id}?section=messages&player=${child.id}`);
        await ready(page);
        await page.screenshot({ path: `${shots}/${viewport.name}-owner-messages-player.png`, fullPage: true });
        audits.push(await audit(page, "owner-messages-player", viewport.name));
        await page.goto(`/workspace/${academy.id}?section=players&player=${trialPlayer.id}`);
        await ready(page);
        await page.getByText("Trial records and actions", { exact: true }).click();
        const actions = page.locator(".portal-trial-record .portal-actions .button");
        await expect(actions.first()).toBeVisible();
        // Regression: trial action buttons must not overlap each other or overflow their own box.
        const layout = await actions.evaluateAll((buttons) => {
          const boxes = buttons.map((b) => b.getBoundingClientRect());
          const overlaps = [];
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${buttons[i].textContent} / ${buttons[j].textContent}`);
          }
          return { count: buttons.length, overlaps, clipped: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) };
        });
        expect(layout.count).toBeGreaterThan(2);
        expect(layout.overlaps, `trial buttons overlap at ${viewport.name}`).toEqual([]);
        expect(layout.clipped, `trial button text clipped at ${viewport.name}`).toEqual([]);
        await page.screenshot({ path: `${shots}/${viewport.name}-owner-player-trial.png`, fullPage: true });
        audits.push(await audit(page, "owner-player-trial", viewport.name));
        await page.goto("/workspace");
        await ready(page);
        await page.screenshot({ path: `${shots}/${viewport.name}-chooser.png`, fullPage: true });
        audits.push(await audit(page, "chooser", viewport.name));
        await expectPlatformSymbol(page, `${viewport.name} chooser`);
        await page.goto("/account/security");
        await ready(page);
        await page.screenshot({ path: `${shots}/${viewport.name}-account-security.png`, fullPage: true });
        audits.push(await audit(page, "account-security", viewport.name));
        await expectPlatformSymbol(page, `${viewport.name} account security`);
      }
      await context.close();
    }
    const anonymous = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await anonymous.newPage();
    for (const [name, path] of [["sign-in", "/sign-in"], ["reset-password", "/reset-password?token=sample"]] as const) {
      await page.goto(path);
      await ready(page);
      await page.screenshot({ path: `${shots}/${viewport.name}-${name}.png`, fullPage: true });
      audits.push(await audit(page, name, viewport.name));
      await expectPlatformSymbol(page, `${viewport.name} ${name}`);
      if (name === "sign-in") {
        await page.getByRole("button", { name: "Create an account", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
        await page.screenshot({ path: `${shots}/${viewport.name}-register.png`, fullPage: true });
        audits.push(await audit(page, "register", viewport.name));
        await expectPlatformSymbol(page, `${viewport.name} register`);
      }
    }
    await anonymous.close();
  }
  await writeFile(`${shots}/audit.json`, JSON.stringify(audits, null, 1));
  const problems = audits.flatMap((a) => [
    ...a.unnamedControls.map((c) => `${a.viewport} ${a.page}: control without a name ${c}`),
    ...a.imagesWithoutAlt.map((c) => `${a.viewport} ${a.page}: image without alt ${c}`),
    ...(a.h1Count === 1 ? [] : [`${a.viewport} ${a.page}: ${a.h1Count} visible h1`]),
    ...a.duplicateIds.map((c) => `${a.viewport} ${a.page}: duplicate id ${c}`),
    ...(a.overflow ? [`${a.viewport} ${a.page}: horizontal page overflow`] : []),
  ]);
  const contrast = audits.reduce((n, a) => n + a.contrastFailures.length, 0);
  console.log(`PHASE4 AUDIT pages=${audits.length} structural-problems=${problems.length} contrast-failures=${contrast}`);
  for (const p of problems.slice(0, 60)) console.log("PHASE4 PROBLEM " + p);
  expect(pageErrors).toEqual([]);
  expect(problems).toEqual([]);
});
