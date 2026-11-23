import { describe, expect, it } from "vitest";
import {
  expandSeries,
  isCalendarDate,
  isoWeekday,
  MAX_SERIES_OCCURRENCES,
  occurrenceId,
  SeriesRuleError,
  seriesDates,
  type SeriesRule,
} from "../../src/services/recurrence";

const long_ago = Date.parse("2020-01-01T00:00:00Z");
const rule = (over: Partial<SeriesRule> = {}): SeriesRule => ({
  timezone: "Asia/Kolkata",
  weekdays: [1, 3],
  startDate: "2027-01-04",
  endDate: "2027-01-17",
  startTime: "18:00",
  endTime: "19:30",
  exclusions: [],
  ...over,
});

describe("calendar helpers", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2027-13-01")).toBe(false);
    expect(isCalendarDate("2027-1-1")).toBe(false);
  });
  it("numbers weekdays 1 = Monday ... 7 = Sunday from the date alone", () => {
    expect(isoWeekday("2027-01-04")).toBe(1);
    expect(isoWeekday("2027-01-10")).toBe(7);
    expect(isoWeekday("2027-01-09")).toBe(6);
  });
  it("builds a deterministic occurrence id", () => {
    expect(occurrenceId("s1", "2027-01-04")).toBe("s1:2027-01-04");
  });
});

describe("weekly selection", () => {
  it("returns only the chosen weekdays inside the inclusive range", () => {
    expect(seriesDates(rule())).toEqual([
      "2027-01-04",
      "2027-01-06",
      "2027-01-11",
      "2027-01-13",
    ]);
    // Both end dates are included.
    expect(seriesDates(rule({ weekdays: [1], endDate: "2027-01-11" }))).toEqual(
      ["2027-01-04", "2027-01-11"],
    );
  });
  it("walks month ends and the leap day", () => {
    expect(
      seriesDates(
        rule({
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startDate: "2028-02-27",
          endDate: "2028-03-02",
        }),
      ),
    ).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
      "2028-03-02",
    ]);
    expect(
      seriesDates(
        rule({
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startDate: "2027-02-27",
          endDate: "2027-03-02",
        }),
      ),
    ).toEqual(["2027-02-27", "2027-02-28", "2027-03-01", "2027-03-02"]);
  });
  it("crosses a year end", () => {
    expect(
      seriesDates(
        rule({ weekdays: [5], startDate: "2027-12-20", endDate: "2028-01-10" }),
      ),
    ).toEqual(["2027-12-24", "2027-12-31", "2028-01-07"]);
  });
});

describe("limits and invalid rules", () => {
  const bad = (over: Partial<SeriesRule>) =>
    expect(() => seriesDates(rule(over))).toThrow(SeriesRuleError);
  it("rejects an unusable rule with a clear error", () => {
    bad({ weekdays: [] });
    bad({ weekdays: [0] });
    bad({ weekdays: [8] });
    bad({ weekdays: [1, 1] });
    bad({ weekdays: [1.5] });
    bad({ timezone: "Mars/Olympus" });
    bad({ startDate: "2027-02-30" });
    bad({ endDate: "2027-01-03" });
    bad({ startTime: "6pm" });
    bad({ startTime: "24:00" });
    bad({ endTime: "18:00" });
    bad({ endTime: "17:00" });
    bad({ startTime: "08:00", endTime: "16:01" });
  });
  it("accepts a session of exactly eight hours", () => {
    expect(() =>
      seriesDates(rule({ startTime: "08:00", endTime: "16:00" })),
    ).not.toThrow();
  });
  it("allows 26 weeks and refuses 27", () => {
    // 2027-01-04 + 181 days = the last day of week 26.
    expect(() =>
      seriesDates(rule({ weekdays: [1], endDate: "2027-07-04" })),
    ).not.toThrow();
    expect(() =>
      seriesDates(rule({ weekdays: [1], endDate: "2027-07-05" })),
    ).toThrow(/26 weeks/);
  });
  it("allows exactly 60 sessions and refuses 61", () => {
    const daily = [1, 2, 3, 4, 5, 6, 7];
    expect(
      seriesDates(
        rule({
          weekdays: daily,
          startDate: "2027-01-01",
          endDate: "2027-03-01",
        }),
      ),
    ).toHaveLength(MAX_SERIES_OCCURRENCES);
    expect(() =>
      seriesDates(
        rule({
          weekdays: daily,
          startDate: "2027-01-01",
          endDate: "2027-03-02",
        }),
      ),
    ).toThrow(/at most 60/);
  });
  it("refuses a range that contains none of the chosen weekdays", () => {
    bad({ weekdays: [2], startDate: "2027-01-04", endDate: "2027-01-04" });
  });
});

describe("exclusions (holidays)", () => {
  it("skips an excluded date and reports its label", () => {
    const { occurrences, skipped } = expandSeries(
      rule({
        exclusions: [{ date: "2027-01-06", label: "Republic Day week" }],
      }),
      long_ago,
    );
    expect(occurrences.map((o) => o.date)).toEqual([
      "2027-01-04",
      "2027-01-11",
      "2027-01-13",
    ]);
    expect(skipped).toEqual([
      { date: "2027-01-06", reason: "EXCLUDED", detail: "Republic Day week" },
    ]);
  });
  it("accepts an excluded date that is not a session day (nothing to skip)", () => {
    const { occurrences, skipped } = expandSeries(
      rule({ exclusions: [{ date: "2027-01-05", label: "x" }] }),
      long_ago,
    );
    expect(occurrences).toHaveLength(4);
    expect(skipped).toEqual([]);
  });
  it("rejects a holiday outside the range, a repeated one, or a bad one", () => {
    for (const exclusions of [
      [{ date: "2027-02-01", label: "x" }],
      [
        { date: "2027-01-06", label: "x" },
        { date: "2027-01-06", label: "y" },
      ],
      [{ date: "2027-01-32", label: "x" }],
    ])
      expect(() => expandSeries(rule({ exclusions }), long_ago)).toThrow(
        SeriesRuleError,
      );
  });
});

describe("instants and time zones", () => {
  it("resolves the wall time in the academy zone", () => {
    const { occurrences } = expandSeries(rule({ weekdays: [1] }), long_ago);
    expect(occurrences[0]).toEqual({
      date: "2027-01-04",
      startLocal: "2027-01-04T18:00",
      endLocal: "2027-01-04T19:30",
      startAt: "2027-01-04T12:30:00.000Z",
      endAt: "2027-01-04T14:00:00.000Z",
    });
  });
  it("keeps the same wall time across a clock change (London spring)", () => {
    const { occurrences, skipped } = expandSeries(
      rule({
        timezone: "Europe/London",
        weekdays: [1],
        startDate: "2027-03-22",
        endDate: "2027-04-05",
        startTime: "18:00",
        endTime: "19:00",
      }),
      long_ago,
    );
    expect(skipped).toEqual([]);
    // 2027-03-28 is the Sunday the clocks went forward: Monday 29th is BST.
    expect(occurrences.map((o) => [o.date, o.startAt])).toEqual([
      ["2027-03-22", "2027-03-22T18:00:00.000Z"],
      ["2027-03-29", "2027-03-29T17:00:00.000Z"],
      ["2027-04-05", "2027-04-05T17:00:00.000Z"],
    ]);
  });
  it("keeps the same wall time across a clock change (New York autumn)", () => {
    const { occurrences } = expandSeries(
      rule({
        timezone: "America/New_York",
        weekdays: [1],
        startDate: "2027-11-01",
        endDate: "2027-11-08",
        startTime: "17:00",
        endTime: "18:00",
      }),
      long_ago,
    );
    expect(occurrences.map((o) => o.startAt)).toEqual([
      "2027-11-01T21:00:00.000Z", // EDT, UTC-4
      "2027-11-08T22:00:00.000Z", // EST, UTC-5
    ]);
  });
  it("has no clock change to handle in Asia/Kolkata", () => {
    const { occurrences, skipped } = expandSeries(
      rule({ weekdays: [7], startDate: "2027-01-03", endDate: "2027-06-30" }),
      long_ago,
    );
    expect(skipped).toEqual([]);
    expect(occurrences).toHaveLength(26);
    // 18:00 IST is 12:30Z on every date, all year.
    expect(occurrences.every((o) => o.startAt.endsWith("T12:30:00.000Z"))).toBe(
      true,
    );
    // A whole year is longer than 26 weeks and is refused before expansion.
    expect(() =>
      expandSeries(
        rule({ weekdays: [7], startDate: "2027-01-01", endDate: "2027-12-31" }),
        long_ago,
      ),
    ).toThrow(SeriesRuleError);
  });
});

describe("clock changes never silently shift a session", () => {
  const skippedOn = (r: Partial<SeriesRule>) =>
    expandSeries(rule(r), long_ago).skipped.map((s) => [s.date, s.reason]);
  const daily = [1, 2, 3, 4, 5, 6, 7];

  it("skips a time that does not exist (London spring-forward gap)", () => {
    expect(
      skippedOn({
        timezone: "Europe/London",
        weekdays: [7],
        startDate: "2027-03-21",
        endDate: "2027-04-04",
        startTime: "01:30",
        endTime: "02:30",
      }),
    ).toEqual([["2027-03-28", "TIME_INVALID"]]);
  });
  it("skips an ambiguous time (London autumn fold)", () => {
    expect(
      skippedOn({
        timezone: "Europe/London",
        weekdays: [7],
        startDate: "2027-10-24",
        endDate: "2027-11-07",
        startTime: "01:15",
        endTime: "01:45",
      }),
    ).toEqual([["2027-10-31", "TIME_INVALID"]]);
  });
  it("skips only the affected day in New York (gap in March, fold in November)", () => {
    expect(
      skippedOn({
        timezone: "America/New_York",
        weekdays: daily,
        startDate: "2027-03-12",
        endDate: "2027-03-16",
        startTime: "02:10",
        endTime: "02:50",
      }),
    ).toEqual([["2027-03-14", "TIME_INVALID"]]);
    expect(
      skippedOn({
        timezone: "America/New_York",
        weekdays: daily,
        startDate: "2027-11-05",
        endDate: "2027-11-09",
        startTime: "01:10",
        endTime: "01:50",
      }),
    ).toEqual([["2027-11-07", "TIME_INVALID"]]);
  });
  it("handles the 30-minute change of Australia/Lord_Howe", () => {
    // Clocks go back 02:00 -> 01:30 on 2027-04-04: 01:30-02:00 happens twice.
    expect(
      skippedOn({
        timezone: "Australia/Lord_Howe",
        weekdays: daily,
        startDate: "2027-04-02",
        endDate: "2027-04-06",
        startTime: "01:40",
        endTime: "01:50",
      }),
    ).toEqual([["2027-04-04", "TIME_INVALID"]]);
    // Clocks go forward 02:00 -> 02:30 on 2027-10-03: 02:00-02:30 never happens.
    expect(
      skippedOn({
        timezone: "Australia/Lord_Howe",
        weekdays: daily,
        startDate: "2027-10-01",
        endDate: "2027-10-05",
        startTime: "02:10",
        endTime: "02:20",
      }),
    ).toEqual([["2027-10-03", "TIME_INVALID"]]);
  });
  it("keeps a session that spans a clock change but starts and ends on real times", () => {
    const { occurrences, skipped } = expandSeries(
      rule({
        timezone: "Europe/London",
        weekdays: [7],
        startDate: "2027-03-28",
        endDate: "2027-03-28",
        startTime: "00:30",
        endTime: "03:30",
      }),
      long_ago,
    );
    expect(skipped).toEqual([]);
    // 00:30 GMT to 03:30 BST is two real hours.
    expect(occurrences[0].startAt).toBe("2027-03-28T00:30:00.000Z");
    expect(occurrences[0].endAt).toBe("2027-03-28T02:30:00.000Z");
  });
  it("explains the skip in terms staff can act on", () => {
    const [skipped] = expandSeries(
      rule({
        timezone: "Europe/London",
        weekdays: [7],
        startDate: "2027-03-28",
        endDate: "2027-03-28",
        startTime: "01:30",
        endTime: "02:30",
      }),
      long_ago,
    ).skipped;
    expect(skipped.detail).toMatch(/does not exist or is ambiguous/);
    expect(skipped.detail).toMatch(/Europe\/London/);
  });
});

describe("dates that have already started", () => {
  it("skips them as PAST and keeps the rest", () => {
    const now = Date.parse("2027-01-06T13:00:00Z"); // after Wed 18:00 IST (12:30Z)
    const { occurrences, skipped } = expandSeries(rule(), now);
    expect(skipped.map((s) => [s.date, s.reason])).toEqual([
      ["2027-01-04", "PAST"],
      ["2027-01-06", "PAST"],
    ]);
    expect(occurrences.map((o) => o.date)).toEqual([
      "2027-01-11",
      "2027-01-13",
    ]);
  });
  it("treats a session starting exactly now as already started", () => {
    const now = Date.parse("2027-01-04T12:30:00Z");
    expect(expandSeries(rule(), now).skipped[0]).toMatchObject({
      date: "2027-01-04",
      reason: "PAST",
    });
    expect(expandSeries(rule(), now - 1).skipped).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives the same answer every time", () => {
    const a = expandSeries(rule(), long_ago),
      b = expandSeries(rule(), long_ago);
    expect(a).toEqual(b);
    expect(a.occurrences.map((o) => occurrenceId("s", o.date))).toEqual([
      "s:2027-01-04",
      "s:2027-01-06",
      "s:2027-01-11",
      "s:2027-01-13",
    ]);
  });
});
