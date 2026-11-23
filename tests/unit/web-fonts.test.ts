// Phase 5: the portal font is delivered as small WOFF2 files with font-display
// swap instead of two 570 KB TrueType files that hid all text until they had
// downloaded. These checks keep that setup honest: the files exist, the CSS
// points at them, every character of the original TTF is still reachable, and
// the Latin file holds what the screens use almost everywhere.
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";

const root = process.cwd();
const css = readFileSync(join(root, "src/styles/globals.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const layout = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
  .map((m) => m[1])
  .filter((body) => /font-family:\s*Portal Noto/.test(body));
const file = (name: string) => join(root, "public/fonts", name);
const codepoints = (path: string) => {
  const font = fontkit.create(readFileSync(path)) as unknown as {
    characterSet: number[];
  };
  // fontkit reports the cmap's closing 0xFFFF segment marker as a character.
  return new Set<number>(font.characterSet.filter((c) => c !== 0xffff));
};
function parseRanges(value: string) {
  const set = new Set<number>();
  for (const part of value.split(",")) {
    const [a, b] = part.trim().replace(/U\+/g, "").split("-");
    const from = parseInt(a, 16),
      to = b ? parseInt(b, 16) : from;
    for (let c = from; c <= to; c++) set.add(c);
  }
  return set;
}
const faceOf = (weightName: "Regular" | "Bold", latin: boolean) => {
  const wanted = `NotoSans-${weightName}${latin ? "-latin" : ""}-v1.woff2`;
  return faces.find((body) => body.includes(`/fonts/${wanted}`))!;
};

describe("portal web fonts", () => {
  it("declare four faces, every one font-display swap and every WOFF2 file present", () => {
    expect(faces).toHaveLength(4);
    for (const body of faces) {
      expect(body).toMatch(/font-display:\s*swap/);
      for (const [, name] of body.matchAll(/url\("\/fonts\/([^"]+)"\)/g))
        expect(statSync(file(name)).size, name).toBeGreaterThan(1000);
    }
  });
  it("send a Latin visitor only the small files, not the 570 KB TrueType files", () => {
    for (const weight of ["Regular", "Bold"] as const) {
      expect(
        statSync(file(`NotoSans-${weight}-latin-v1.woff2`)).size,
      ).toBeLessThan(40_000);
      expect(statSync(file(`NotoSans-${weight}-v1.woff2`)).size).toBeLessThan(
        260_000,
      );
      expect(statSync(file(`NotoSans-${weight}.ttf`)).size).toBeGreaterThan(
        500_000,
      );
    }
  });
  it("keep every character of the original font reachable, and nothing is lost in conversion", () => {
    for (const weight of ["Regular", "Bold"] as const) {
      const original = codepoints(file(`NotoSans-${weight}.ttf`));
      const full = codepoints(file(`NotoSans-${weight}-v1.woff2`));
      const latin = codepoints(file(`NotoSans-${weight}-latin-v1.woff2`));
      expect([...original].filter((c) => !full.has(c))).toEqual([]);
      const latinRange = parseRanges(
        /unicode-range:\s*([^;]+);/.exec(faceOf(weight, true))![1],
      );
      const fullRange = parseRanges(
        /unicode-range:\s*([^;]+);/.exec(faceOf(weight, false))![1],
      );
      // The Latin file holds every character of the font that its range claims.
      expect(
        [...original].filter((c) => latinRange.has(c) && !latin.has(c)),
      ).toEqual([]);
      // Each character of the font is claimed by one of the two ranges, so the
      // browser can always find its glyph.
      expect(
        [...original].filter((c) => !latinRange.has(c) && !fullRange.has(c)),
      ).toEqual([]);
      // The full face claims nothing the font cannot draw: an emoji, which Noto
      // Sans lacks, must not trigger a download of the large file.
      expect(fullRange.has(0x1f44b)).toBe(false);
      expect([...fullRange].filter((c) => !original.has(c))).toEqual([]);
    }
  });
  it("hold what the screens use: ASCII, the rupee sign and typographic punctuation", () => {
    const latin = codepoints(file("NotoSans-Regular-latin-v1.woff2"));
    for (const c of "AZaz09 .,:;!?()-+/&%@#$*")
      expect(latin.has(c.codePointAt(0)!)).toBe(true);
    for (const c of ["₹", "’", "“", "–", "…", "·"])
      expect(latin.has(c.codePointAt(0)!), c).toBe(true);
  });
  it("are not preloaded: measured on a throttled mobile profile a preload only delayed first paint", () => {
    expect(layout).not.toContain('rel="preload"');
  });
});
