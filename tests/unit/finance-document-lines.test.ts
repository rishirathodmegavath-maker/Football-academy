import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  forDocumentFont,
  wrapFinanceDocumentText,
} from "../../src/services/finance-document-lines";
import { formatFinanceMoney } from "../../src/services/finance-rules";

let regular: PDFFont, bold: PDFFont;
beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(join(process.cwd(), "public/fonts/NotoSans-Regular.ttf")),
    readFile(join(process.cwd(), "public/fonts/NotoSans-Bold.ttf")),
  ]);
  [regular, bold] = await Promise.all([
    pdf.embedFont(regularBytes, { subset: true }),
    pdf.embedFont(boldBytes, { subset: true }),
  ]);
}, 30000);

describe("finance document wrapping with the actual document fonts", () => {
  it("keeps the receipt disclaimer's transaction word intact on a fresh line", () => {
    const text =
      "This receipt records a manually verified academy payment. It does not claim an online gateway transaction.";
    const measure = (value: string) => regular.widthOfTextAtSize(value, 10);
    const lines = wrapFinanceDocumentText(text, 495, measure);
    expect(lines.join(" ")).toBe(text);
    expect(lines.some((line) => line.endsWith("transaction."))).toBe(true);
    expect(lines.every((line) => measure(line) <= 495)).toBe(true);
  });

  it("fits a long reference without losing or inventing any token characters", () => {
    const reference = "REFERENCE1234567890".repeat(8);
    const text = `Manual payment reference: ${reference}`;
    const measure = (value: string) => regular.widthOfTextAtSize(value, 10);
    const lines = wrapFinanceDocumentText(text, 140, measure);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => measure(line) <= 140)).toBe(true);
    expect(lines.join("").replaceAll(/\s/g, "")).toBe(
      text.replaceAll(/\s/g, ""),
    );
  });

  it("preserves explicit blank paragraphs and removes prohibited control characters", () => {
    const measure = (value: string) => regular.widthOfTextAtSize(value, 10);
    expect(
      wrapFinanceDocumentText(
        "First paragraph\r\n\nSecond \u0000paragraph\n",
        495,
        measure,
      ),
    ).toEqual(["First paragraph", "", "Second paragraph"]);
    expect(wrapFinanceDocumentText("", 495, measure)).toEqual([]);
  });

  it("reserves the logo header width while preserving words in a long academy name", () => {
    const name =
      "Riverside Football Academy for Development and Community Training "
        .repeat(4)
        .trim();
    const measure = (value: string) => bold.widthOfTextAtSize(value, 15);
    const lines = wrapFinanceDocumentText(name, 420, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(name);
    expect(lines.every((line) => measure(line) <= 420)).toBe(true);
    // Header x48 + width420 ends at468; the logo starts at490.
    expect(48 + Math.max(...lines.map(measure))).toBeLessThan(490);
  });
});

describe("amounts as the document font can draw them", () => {
  it("never asks the font for a glyph it lacks when a credit or a discount is negative", () => {
    const drawable = new Set(regular.getCharacterSet());
    const missing = (text: string) =>
      [...text].filter((c) => !drawable.has(c.codePointAt(0)!));
    for (const [minor, currency, locale] of [
      [-34567, "INR", "en-IN"],
      [-1, "INR", "en-IN"],
      [-1234567890, "GBP", "en-GB"],
      [-5000, "JPY", "en-US"],
      [-1001, "KWD", "en-US"],
      [34567, "INR", "en-IN"],
    ] as const) {
      const text = `Approved adjustments: ${formatFinanceMoney(minor, currency, locale)}`;
      expect(missing(forDocumentFont(text)), `${minor} ${currency}`).toEqual(
        [],
      );
      if (minor < 0)
        // The formatter's own minus sign is not in the font: this is why the helper exists.
        expect(missing(text)).toEqual(["−"]);
    }
    expect(forDocumentFont("-₹345.67")).toBe("-₹345.67");
    expect(forDocumentFont(formatFinanceMoney(-34567, "INR", "en-IN"))).toMatch(
      /^-/,
    );
  });
});
