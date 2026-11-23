import { describe, expect, it } from "vitest";
import { developmentPriorities } from "@/services/reports/report-priorities";

describe("development priorities on the family report", () => {
  it("keeps one sentence as one card with its exact wording", () => {
    const text = "Repeat six close-control turns at a comfortable pace";
    expect(developmentPriorities(text)).toEqual([text]);
  });

  it("shows one priority per line as separate cards", () => {
    expect(
      developmentPriorities(
        "Dribbling in tight spaces\nDecision making\nMental stability",
      ),
    ).toEqual([
      "Dribbling in tight spaces",
      "Decision making",
      "Mental stability",
    ]);
  });

  it("splits a semicolon list and strips bullets and numbers", () => {
    expect(developmentPriorities("- Passing; 2. Scanning; • Balance")).toEqual([
      "Passing",
      "Scanning",
      "Balance",
    ]);
    expect(developmentPriorities("1) First touch\n2) Weak foot")).toEqual([
      "First touch",
      "Weak foot",
    ]);
  });

  it("leaves long or numerous lists whole rather than cutting the wording", () => {
    const five = "A\nB\nC\nD\nE";
    expect(developmentPriorities(five)).toEqual([five]);
    const long = `${"x".repeat(91)}\nsecond`;
    expect(developmentPriorities(long)).toEqual([long]);
  });

  it("never drops text: the cards always carry every word", () => {
    const text = "Receive on the back foot; scan before the pass";
    expect(developmentPriorities(text).join(" ")).toContain("scan before");
    expect(developmentPriorities("")).toEqual([""]);
  });
});
