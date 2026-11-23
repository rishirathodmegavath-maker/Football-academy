import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";

/**
 * Football accessibility checks (test-only; no product code is touched).
 *
 * Results and limits are recorded in ux-audit/wave-0-report/ACCESSIBILITY_BASELINE.md (structure, keyboard,
 * reflow) and ux-audit/wave-1-football-report/ (axe).
 *
 * - Runs against the isolated synthetic Bharat academy only (same database guard as playwright.bharat.config.ts).
 *   The fixture is created with `pnpm qa:bharat:seed`; this file needs .local/bharat-qa-access.json.
 * - "enforce" checks must hold today; a regression fails the test.
 * - "record" checks describe what is wrong today; they are attached to the report and never fail the run.
 * - The "axe" block runs @axe-core/playwright (WCAG 2.0, 2.1 and 2.2 A and AA tags) on the same screens.
 *   Every violation is recorded. A violation whose rule id is NOT in KNOWN_AXE_RULES fails the run, so nothing
 *   new can slip in. The list is the measured baseline and may only shrink.
 */
type Account = { name: string; email: string; password: string };
const access = JSON.parse(readFileSync(".local/bharat-qa-access.json", "utf8")) as {
  academyId: string;
  accounts: Account[];
};
const origin = "http://127.0.0.1:3022";
const academy = access.academyId;
const pick: Record<string, (a: Account) => boolean> = {
  owner: (a) => /Owner/.test(a.name),
  coach: (a) => /U8 Coach/.test(a.name),
  parent: (a) => /Guardian U8 1$/.test(a.name),
};
const sections: Record<string, string[]> = {
  owner: ["home", "players", "calendar", "training", "reports", "fees", "messages", "settings"],
  coach: ["home", "players", "calendar", "training", "reports", "messages", "settings"],
  parent: ["home", "reports", "messages", "fees", "settings"],
};

async function signIn(context: BrowserContext, role: string): Promise<Page> {
  const me = access.accounts.find(pick[role]);
  expect(me, `fixture account for ${role}`).toBeTruthy();
  const page = await context.newPage();
  // Sign-in is rate limited to a few attempts a minute: after one refusal, wait out the window and try once more.
  for (const attempt of [1, 2]) {
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel("Email").fill(me!.email);
    await page.getByLabel("Password", { exact: true }).fill(me!.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await page.waitForURL(/\/workspace/, { timeout: 30000 });
      return page;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(65000);
    }
  }
  return page;
}

async function open(page: Page, section: string) {
  await page.goto(`${origin}/workspace/${academy}?section=${section}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.locator("main").first()).toBeVisible();
}

/** Static structure checks computed in the page. Names are approximated from aria-label(ledby), label, text, title, alt. */
async function structure(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el: Element): string => {
      const h = el as HTMLElement;
      const labelled = h.getAttribute("aria-labelledby");
      if (labelled)
        return labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
      const al = h.getAttribute("aria-label")?.trim();
      if (al) return al;
      if (h instanceof HTMLInputElement || h instanceof HTMLSelectElement || h instanceof HTMLTextAreaElement) {
        const ls = Array.from(h.labels ?? []).map((l) => l.textContent ?? "").join(" ").trim();
        if (ls) return ls;
      }
      const img = h.querySelector("img[alt]");
      const text = (h.textContent ?? "").trim() || img?.getAttribute("alt")?.trim() || "";
      return text || h.getAttribute("title")?.trim() || "";
    };
    const describe = (el: Element) => {
      const h = el as HTMLElement;
      return `${h.tagName.toLowerCase()}${h.id ? "#" + h.id : ""}${h.getAttribute("role") ? `[role=${h.getAttribute("role")}]` : ""}${
        typeof h.className === "string" && h.className ? "." + h.className.split(/\s+/)[0] : ""
      }`;
    };
    const interactive = Array.from(
      document.querySelectorAll(
        "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], [role=menuitem], [role=switch], [role=checkbox]",
      ),
    ).filter(visible);
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    return {
      lang: document.documentElement.lang,
      title: document.title,
      mains: document.querySelectorAll("main, [role=main]").length,
      navs: document.querySelectorAll("nav, [role=navigation]").length,
      h1: document.querySelectorAll("h1").length,
      interactiveCount: interactive.length,
      unnamed: interactive.filter((e) => !nameOf(e)).map(describe),
      imagesWithoutAlt: Array.from(document.querySelectorAll("img:not([alt])")).filter(visible).map(describe),
      duplicateIds: Array.from(new Set(ids.filter((id, i) => ids.indexOf(id) !== i))),
      reflowOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });
}

/** Presses Tab and reports where focus goes and whether it is visibly indicated. */
async function tabWalk(page: Page, max: number) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.mouse.move(0, 0);
  const stops: { id: string; ring: boolean; inNav: boolean; inMain: boolean }[] = [];
  let repeats = 0;
  let last = "";
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const s = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring =
        (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" || el.matches("input, select, textarea");
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("href") || "").trim().replace(/\s+/g, " ").slice(0, 40);
      return { id: `${el.tagName.toLowerCase()}:${label}`, ring, inNav: !!el.closest("nav, [role=navigation]"), inMain: !!el.closest("main, [role=main]") };
    });
    if (!s) break; // focus left the page (browser chrome) or wrapped to the document
    if (s.id === last) repeats++;
    last = s.id;
    stops.push(s);
    if (repeats > 2) break; // would indicate a trap
  }
  return { stops, trapped: repeats > 2 };
}

for (const role of Object.keys(pick)) {
  test.describe(`${role}`, () => {
    test.describe.configure({ mode: "serial" });
    let context: BrowserContext;
    let page: Page;
    test.beforeAll(async ({ browser }) => {
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      page = await signIn(context, role);
    });
    test.afterAll(async () => context?.close());

    for (const section of sections[role]) {
      test(`structure and names: ${section}`, async () => {
        await open(page, section);
        const s = await structure(page);
        await test.info().attach(`structure-${role}-${section}.json`, { body: JSON.stringify(s, null, 1), contentType: "application/json" });
        // enforce
        expect(s.lang, "html lang").not.toBe("");
        expect(s.title, "document title").not.toBe("");
        expect(s.mains, "one main landmark").toBe(1);
        expect(s.navs, "a navigation landmark").toBeGreaterThan(0);
        // record (findings are attached above; see ACCESSIBILITY_BASELINE.md)
        if (s.unnamed.length) test.info().annotations.push({ type: "record:unnamed-controls", description: s.unnamed.join(", ") });
        if (s.imagesWithoutAlt.length) test.info().annotations.push({ type: "record:img-no-alt", description: s.imagesWithoutAlt.join(", ") });
        if (s.duplicateIds.length) test.info().annotations.push({ type: "record:duplicate-ids", description: s.duplicateIds.join(", ") });
        if (s.h1 !== 1) test.info().annotations.push({ type: "record:h1-count", description: String(s.h1) });
      });
    }

    test("keyboard: Tab reaches navigation and content without a trap", async () => {
      await open(page, "home");
      const { stops, trapped } = await tabWalk(page, 70);
      await test.info().attach(`tabwalk-${role}.json`, { body: JSON.stringify(stops, null, 1), contentType: "application/json" });
      expect(trapped, "keyboard trap").toBe(false);
      expect(stops.length, "focusable stops").toBeGreaterThan(3);
      expect(stops.some((x) => x.inNav), "navigation is reachable by Tab").toBe(true);
      const noRing = stops.filter((x) => !x.ring).map((x) => x.id);
      if (noRing.length) test.info().annotations.push({ type: "record:no-visible-focus", description: noRing.join(" | ") });
    });
  });
}

test.describe("reflow at 320 px (WCAG 1.4.10) and 390 px", () => {
  for (const role of ["owner", "parent"]) {
    test(`${role}: no horizontal scrolling`, async ({ browser }) => {
      for (const width of [390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
        const page = await signIn(context, role);
        for (const section of sections[role]) {
          await open(page, section);
          const s = await structure(page);
          if (s.reflowOverflowPx > 0)
            test.info().annotations.push({ type: `record:overflow-${width}px`, description: `${role}/${section}: ${s.reflowOverflowPx}px` });
        }
        await context.close();
      }
    });
  }
});

/**
 * Rule ids present in the measured baseline (Wave 1, 20 screens, 3 roles). Remove an id when it is fixed;
 * never add one to hide a regression.
 * - label-content-name-mismatch (serious): the player buttons in the Fees table (.pf-player-button) have an
 *   aria-label that does not contain their visible text (owner and parent, Fees).
 * - color-contrast (serious): the active tab in Communications sections (owner and coach, Communications).
 */
const KNOWN_AXE_RULES: string[] = ["label-content-name-mismatch", "color-contrast"];

test.describe("axe", () => {
  for (const role of Object.keys(pick)) {
    // One test per role that scans every screen it can open, so one failing screen never hides the rest.
    test(`axe: ${role}, every screen`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await signIn(context, role);
      const unknown: string[] = [];
      for (const section of sections[role]) {
        await open(page, section);
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const found = result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          count: v.nodes.length,
          nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
        }));
        await test.info().attach(`axe-${role}-${section}.json`, { body: JSON.stringify(found, null, 1), contentType: "application/json" });
        for (const f of found) {
          test.info().annotations.push({ type: `record:axe:${f.impact}`, description: `${role}/${section}: ${f.id} (${f.count}): ${f.nodes.join(" | ")}` });
          if (!KNOWN_AXE_RULES.includes(f.id)) unknown.push(`${role}/${section}: ${f.id}`);
        }
      }
      await context.close();
      expect(unknown, "axe rules not in the known baseline").toEqual([]);
    });
  }
});
