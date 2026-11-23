import { describe, expect, it } from "vitest";
import { academyGreeting, dayPart } from "@/services/portal-records";

const academy = (timezone: string) => ({ academy: { timezone } }) as never;
const at = (iso: string) => new Date(iso);

describe("the Home greeting follows the academy's clock", () => {
  it("changes at 05:00, 12:00 and 17:00 and nowhere else", () => {
    const parts = Array.from({ length: 24 }, (_, hour) => dayPart(hour));
    expect(parts.slice(0, 5)).toEqual(Array(5).fill("evening"));
    expect(parts.slice(5, 12)).toEqual(Array(7).fill("morning"));
    expect(parts.slice(12, 17)).toEqual(Array(5).fill("afternoon"));
    expect(parts.slice(17)).toEqual(Array(7).fill("evening"));
  });
  it("uses India time (Asia/Kolkata, UTC+5:30) whatever the device's time zone is", () => {
    const ist = academy("Asia/Kolkata");
    // 18:30 UTC on 3 Nov is 00:00 IST on 4 Nov: the night, not "morning".
    expect(academyGreeting(ist, at("2026-11-03T18:30:00Z"))).toBe(
      "Good evening",
    );
    expect(academyGreeting(ist, at("2026-11-03T23:29:00Z"))).toBe(
      "Good evening",
    ); // 04:59
    expect(academyGreeting(ist, at("2026-11-03T23:30:00Z"))).toBe(
      "Good morning",
    ); // 05:00
    expect(academyGreeting(ist, at("2026-11-04T06:29:00Z"))).toBe(
      "Good morning",
    ); // 11:59
    expect(academyGreeting(ist, at("2026-11-04T06:30:00Z"))).toBe(
      "Good afternoon",
    ); // 12:00
    expect(academyGreeting(ist, at("2026-11-04T11:29:00Z"))).toBe(
      "Good afternoon",
    ); // 16:59
    expect(academyGreeting(ist, at("2026-11-04T11:30:00Z"))).toBe(
      "Good evening",
    ); // 17:00
    expect(academyGreeting(ist, at("2026-11-04T18:29:00Z"))).toBe(
      "Good evening",
    ); // 23:59
  });
  it("is the same instant everywhere in the world only for academies in the same zone", () => {
    const instant = at("2026-11-04T06:40:00Z");
    expect(academyGreeting(academy("Asia/Kolkata"), instant)).toBe(
      "Good afternoon",
    ); // 12:10
    expect(academyGreeting(academy("Europe/London"), instant)).toBe(
      "Good morning",
    ); // 06:40
    expect(academyGreeting(academy("America/New_York"), instant)).toBe(
      "Good evening",
    ); // 01:40
    expect(academyGreeting(academy("Australia/Perth"), instant)).toBe(
      "Good afternoon",
    ); // 14:40
  });
  it("follows daylight saving in the academy's zone", () => {
    const london = academy("Europe/London");
    // 16:30 UTC is 16:30 in winter (afternoon) but 17:30 BST in summer (evening).
    expect(academyGreeting(london, at("2026-01-15T16:30:00Z"))).toBe(
      "Good afternoon",
    );
    expect(academyGreeting(london, at("2026-07-15T16:30:00Z"))).toBe(
      "Good evening",
    );
  });
  it("never blanks the screen on an unusable time zone", () => {
    expect(
      academyGreeting(academy("Not/AZone"), at("2026-11-04T06:40:00Z")),
    ).toMatch(/^Good (morning|afternoon|evening)$/);
  });
});
