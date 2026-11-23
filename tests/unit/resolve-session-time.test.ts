import { describe, expect, it } from "vitest";
import { resolveSessionTime } from "../../src/services/training-rules";

/**
 * The previous implementation, kept verbatim as the reference: it tried all
 * 1,681 possible whole-minute offsets for every call. The shipped version tries
 * only the offsets in force near the date, so a recurring series of 60 dates
 * does not cost two minutes of CPU. These tests prove they agree wherever it
 * matters: ordinary days, and every clock change of a year in several zones,
 * including the 30- and 45-minute ones.
 */
function reference(local: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error("Use a dated local time.");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const centre = Date.parse(local + "Z");
  if (!Number.isFinite(centre)) throw new Error("Invalid session date.");
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset++) {
    const instant = centre + offset * 60000,
      p = Object.fromEntries(
        format.formatToParts(instant).map((p) => [p.type, p.value]),
      );
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === local)
      matches.push(instant);
  }
  if (matches.length !== 1)
    throw new Error(
      "This local time is invalid or ambiguous in the selected time zone. Choose another time.",
    );
  return new Date(matches[0]).toISOString();
}
const outcome = (fn: () => string) => {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
const same = (local: string, zone: string) =>
  expect(
    outcome(() => resolveSessionTime(local, zone)),
    `${zone} ${local}`,
  ).toEqual(outcome(() => reference(local, zone)));

/** Local calendar dates (in `zone`) on which the UTC offset changes, in `year`. */
function changeDays(zone: string, year: number): string[] {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(
      format.formatToParts(ms).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  const days: string[] = [];
  let previous = offsetAt(Date.UTC(year, 0, 1) - 12 * 3_600_000);
  for (let d = 0; d < 367; d++) {
    const ms =
      Date.UTC(year, 0, 1) + d * 86_400_000 - 12 * 3_600_000 + 86_400_000;
    const now = offsetAt(ms);
    if (now !== previous) {
      const p = new Date(ms - 6 * 3_600_000);
      days.push(p.toISOString().slice(0, 10));
    }
    previous = now;
  }
  return days;
}
const slots = Array.from(
  { length: 48 },
  (_, i) =>
    `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);

describe("resolveSessionTime matches the exhaustive reference", () => {
  it("on ordinary days in many zones", () => {
    for (const zone of [
      "Asia/Kolkata",
      "UTC",
      "Asia/Kathmandu",
      "Pacific/Kiritimati",
      "America/St_Johns",
      "Pacific/Pago_Pago",
    ])
      for (const day of [
        "2026-01-15",
        "2026-07-15",
        "2027-02-28",
        "2028-02-29",
      ])
        for (const time of ["00:00", "03:45", "11:15", "18:00", "23:59"])
          same(`${day}T${time}`, zone);
  });
  for (const zone of [
    "Europe/London",
    "America/New_York",
    "Australia/Lord_Howe", // 30-minute change
    "Pacific/Chatham", // 45-minute offset, 45-minute-aligned change
    "Australia/Sydney",
    "Africa/Casablanca", // changes for Ramadan
  ])
    it(`on every clock-change day of 2026 in ${zone}`, () => {
      const days = changeDays(zone, 2026);
      expect(days.length).toBeGreaterThan(1);
      for (const day of days)
        for (const time of slots) same(`${day}T${time}`, zone);
    });
  it("on the days around a change as well", () => {
    for (const [zone, day] of [
      ["Europe/London", "2027-03-28"],
      ["Europe/London", "2027-10-31"],
      ["America/New_York", "2027-03-14"],
      ["America/New_York", "2027-11-07"],
      ["Australia/Lord_Howe", "2027-04-04"],
      ["Australia/Lord_Howe", "2027-10-03"],
    ] as const) {
      const before = new Date(Date.parse(day + "T00:00Z") - 86_400_000)
          .toISOString()
          .slice(0, 10),
        after = new Date(Date.parse(day + "T00:00Z") + 86_400_000)
          .toISOString()
          .slice(0, 10);
      for (const d of [before, day, after])
        for (const time of [
          "00:00",
          "00:30",
          "01:00",
          "01:15",
          "01:30",
          "01:45",
          "02:00",
          "02:10",
          "02:30",
          "03:00",
          "12:00",
        ])
          same(`${d}T${time}`, zone);
    }
  });
  it("on malformed input and unknown zones", () => {
    for (const bad of [
      "2026-02-30T10:00",
      "2026-13-01T10:00",
      "2026-01-01T25:00",
      "2026-01-01",
      "tomorrow",
      "2026-01-01T10:00:00",
    ])
      same(bad, "Europe/London");
    expect(() =>
      resolveSessionTime("2026-01-01T10:00", "Mars/Olympus"),
    ).toThrow(RangeError);
    expect(() => reference("2026-01-01T10:00", "Mars/Olympus")).toThrow(
      RangeError,
    );
  });
});

describe("resolveSessionTime is fast enough for a recurring series", () => {
  it("resolves 120 local times (a 60-session series) in well under a second", () => {
    const started = performance.now();
    for (let d = 0; d < 60; d++) {
      const day = new Date(Date.UTC(2027, 0, 1 + d)).toISOString().slice(0, 10);
      resolveSessionTime(`${day}T17:00`, "Asia/Kolkata");
      resolveSessionTime(`${day}T18:00`, "Asia/Kolkata");
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});
