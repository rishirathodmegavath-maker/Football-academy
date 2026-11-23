// Wave 5 (V9, A5): the design standard as a tripwire, not a rewrite. docs/DESIGN_STANDARD.md explains the rules.
//   1. No new hard-coded colour: a stylesheet may not contain more hex colours than the baseline recorded for it (a file the baseline does
//      not list may contain none). Replace-on-touch lowers the baseline; it can only go down.
//   2. One breakpoint scale: 480, 768, 1024 and 1280 px, written as "min-width: N" or "max-width: N - 1". A width off the scale is allowed only
//      where the baseline already has one, and the number per file can only go down.
//   3. One font: a font-family other than var(--portal-font) or inherit is allowed only where the baseline already has one.
//   4. Files already moved to tokens are held strictly: no colour literal, no raw font, no text under 12 px, and every var(--name) they use is defined.
// To record a new, lower baseline after cleaning a file up: UPDATE_DESIGN_BASELINE=1 npx vitest run tests/unit/design-standard.test.ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const BASELINE_FILE = join(ROOT, "tests/unit/design-standard.baseline.json");
/** The scale, in pixels. A max-width query uses the value minus one so that the two sides of a breakpoint never overlap. */
export const BREAKPOINT_SCALE = [480, 768, 1024, 1280] as const;
const onScale = (px: number) =>
  BREAKPOINT_SCALE.some((step) => px === step || px === step - 1);
/** Stylesheets fully moved to tokens (Wave 5). They are held to the strict rules in section 4. */
const MIGRATED = ["src/features/workspaces/drill-library.css"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "node_modules" || name.startsWith(".") ? [] : walk(path);
    return name.endsWith(".css") ? [path] : [];
  });
}
const rel = (path: string) => relative(ROOT, path).replace(/\\/g, "/");
const files = walk(join(ROOT, "src")).map((f) => rel(f)).sort();
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Counts = { hex: number; offScale: number; rawFont: number };
function measure(css: string): Counts & { offScaleWidths: number[] } {
  const text = stripComments(css);
  const hex = (text.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) ?? []).length;
  const widths = [...text.matchAll(/\(\s*(?:min|max)-width:\s*(\d+(?:\.\d+)?)px\s*\)/g)].map((m) => Number(m[1]));
  const offScaleWidths = widths.filter((w) => !onScale(w));
  const rawFont = [...text.matchAll(/font-family:\s*([^;}]+)/g)].filter(
    (m) => !/^\s*(var\(--portal-font\)|inherit)\s*$/i.test(m[1]),
  ).length;
  return { hex, offScale: offScaleWidths.length, rawFont, offScaleWidths };
}
const current = new Map(
  files.map((file) => [file, measure(readFileSync(join(ROOT, file), "utf8"))]),
);

if (process.env.UPDATE_DESIGN_BASELINE) {
  const out: Record<string, Counts> = {};
  for (const [file, c] of current)
    if (c.hex || c.offScale || c.rawFont)
      out[file] = { hex: c.hex, offScale: c.offScale, rawFont: c.rawFont };
  writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 1) + "\n");
}
const baseline: Record<string, Counts> = JSON.parse(
  readFileSync(BASELINE_FILE, "utf8"),
);

describe("design standard (Wave 5)", () => {
  it("adds no hard-coded colour: each stylesheet stays at or under its recorded count", () => {
    const over = [...current].filter(([file, c]) => c.hex > (baseline[file]?.hex ?? 0))
      .map(([file, c]) => `${file}: ${c.hex} hex colours, baseline ${baseline[file]?.hex ?? 0}`);
    expect(over, "Use a var(--token) from src/styles/globals.css instead of a hex colour").toEqual([]);
  });
  it("adds no breakpoint off the scale 480 / 768 / 1024 / 1280 (written N or N-1)", () => {
    const over = [...current].filter(([file, c]) => c.offScale > (baseline[file]?.offScale ?? 0))
      .map(([file, c]) => `${file}: ${c.offScale} off-scale widths (${[...new Set(c.offScaleWidths)].join(", ")}), baseline ${baseline[file]?.offScale ?? 0}`);
    expect(over, "Use 479/480, 767/768, 1023/1024 or 1279/1280").toEqual([]);
  });
  it("adds no font other than var(--portal-font) or inherit", () => {
    const over = [...current].filter(([file, c]) => c.rawFont > (baseline[file]?.rawFont ?? 0))
      .map(([file, c]) => `${file}: ${c.rawFont} raw font-family, baseline ${baseline[file]?.rawFont ?? 0}`);
    expect(over).toEqual([]);
  });
  it("lists only stylesheets that exist, and never a count the files no longer reach (the baseline must be lowered when a file is cleaned)", () => {
    const stale = Object.entries(baseline).filter(([file, b]) => {
      const c = current.get(file);
      return !c || c.hex < b.hex || c.offScale < b.offScale || c.rawFont < b.rawFont;
    }).map(([file]) => file);
    expect(stale, "Run UPDATE_DESIGN_BASELINE=1 npx vitest run tests/unit/design-standard.test.ts to record the lower counts").toEqual([]);
  });
  describe.each(MIGRATED)("%s (moved to tokens)", (file) => {
    const css = stripComments(readFileSync(join(ROOT, file), "utf8"));
    const tokens = readFileSync(join(ROOT, "src/styles/globals.css"), "utf8");
    it("has no colour literal, no raw font and nothing under 12 px", () => {
      expect(css.match(/#[0-9a-fA-F]{3,8}(?![\w-])/g) ?? []).toEqual([]);
      expect(css.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
      expect([...css.matchAll(/font-family:\s*([^;}]+)/g)].filter((m) => !/var\(--portal-font\)|inherit/.test(m[1]))).toEqual([]);
      const small = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < 12).map((m) => m[0]);
      expect(small).toEqual([]);
    });
    it("uses only tokens that are defined in globals.css", () => {
      const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/g)].map((m) => m[1]));
      const missing = [...used].filter((name) => !new RegExp(`${name}\\s*:`).test(tokens));
      expect(missing).toEqual([]);
    });
  });
});
