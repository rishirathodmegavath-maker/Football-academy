// How dates read on screen (UX decision UX-D17): "21 Nov 2026", never ISO, "Sep" not "Sept".
import { describe, expect, it } from "vitest";
import {
  displayDay,
  displayDayRange,
  displayInstant,
  displayLocal,
  displayMonthShort,
  displayTime,
  MONTHS,
} from "@/services/date-display";

describe("date display", () => {
  it("writes a day as 'd Mon yyyy' and never as ISO", () => {
    expect(displayDay("2026-11-21")).toBe("21 Nov 2026");
    expect(displayDay("2026-01-05")).toBe("5 Jan 2026");
    expect(displayDay("2026-11-21T17:30:00.000Z")).toBe("21 Nov 2026");
    expect(displayDay("2026-11-21", { weekday: true })).toBe("Sat, 21 Nov 2026");
  });
  it("uses 'Sep', not 'Sept', for every month in every route", () => {
    expect(displayDay("2026-09-05")).toBe("5 Sep 2026");
    expect(displayInstant("2026-09-05T10:00:00Z", "Asia/Kolkata")).toBe("5 Sep 2026");
    expect(displayMonthShort("2026-09-05T10:00:00Z", "Asia/Kolkata")).toBe("Sep");
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS.every((month) => month.length === 3)).toBe(true);
  });
  it("leaves empty and unrecognised values alone instead of inventing a date", () => {
    expect(displayDay("")).toBe("");
    expect(displayDay(null)).toBe("");
    expect(displayDay("not a date")).toBe("not a date");
    expect(displayDay("2026-13-40")).toBe("2026-13-40");
    expect(displayInstant("nonsense")).toBe("nonsense");
    expect(displayInstant(undefined)).toBe("");
  });
  it("shows an instant in the academy's own time zone", () => {
    // 20:00 UTC on 21 Nov is 01:30 on 22 Nov in Kolkata.
    expect(displayInstant("2026-11-21T20:00:00Z", "Asia/Kolkata")).toBe("22 Nov 2026");
    expect(displayInstant("2026-11-21T20:00:00Z", "Asia/Kolkata", { time: true })).toBe(
      "22 Nov 2026, 1:30 AM",
    );
    expect(
      displayInstant("2026-11-21T12:00:00Z", "Asia/Kolkata", { time: true, hour12: false }),
    ).toBe("21 Nov 2026, 17:30");
    expect(displayTime("2026-11-21T12:00:00Z", "Asia/Kolkata")).toBe("5:30 PM");
    expect(displayTime("2026-11-21T12:00:00Z", "UTC", false)).toBe("12:00");
  });
  it("formats wall-clock values that carry no zone", () => {
    expect(displayLocal("2026-11-21T17:30")).toBe("21 Nov 2026, 5:30 PM");
    expect(displayLocal("2026-11-21 09:05")).toBe("21 Nov 2026, 9:05 AM");
    expect(displayLocal("2026-11-21T00:10")).toBe("21 Nov 2026, 12:10 AM");
    expect(displayLocal("2026-11-21T17:30", { hour12: false })).toBe("21 Nov 2026, 17:30");
    expect(displayLocal("2026-11-21")).toBe("21 Nov 2026");
  });
  it("writes a range with an en dash", () => {
    expect(displayDayRange("2026-11-01", "2026-11-30")).toBe("1 Nov 2026 – 30 Nov 2026");
    expect(displayDayRange("2026-11-01", "2026-11-30", " to ")).toBe("1 Nov 2026 to 30 Nov 2026");
  });
});
