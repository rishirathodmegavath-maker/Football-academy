import { describe, expect, it } from "vitest";
import {
  academyMonogram,
  roleLabels,
} from "../../src/features/workspaces/role-labels";

describe("role labels", () => {
  it("names every academy role in words, never the raw enum", () => {
    expect(roleLabels).toEqual({
      OWNER: "Owner",
      ADMIN: "Admin",
      COACH: "Coach",
      PARENT: "Parent",
      SUPPORT: "Support",
    });
  });
});

describe("academy monogram", () => {
  it("uses up to three initials of the academy name", () => {
    expect(academyMonogram("Riverside Football Academy")).toBe("RFA");
    expect(academyMonogram("Riverside Football Academy Under Twelve")).toBe(
      "RFA",
    );
    expect(academyMonogram("  north   star  ")).toBe("NS");
  });
  it("falls back to SA for an empty name", () => {
    expect(academyMonogram("")).toBe("SA");
    expect(academyMonogram("   ")).toBe("SA");
  });
});
