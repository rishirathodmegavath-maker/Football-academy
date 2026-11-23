import { describe, expect, it } from "vitest";
import { attendanceHistory } from "../../src/services/attendance-history";
import type {
  FootballAttendance,
  FootballSession,
} from "../../src/domain/training";

const P = "player-1";
const squads = new Map([["sq", "U12 Tuesday"]]);
let n = 0;
function session(
  day: number,
  status: FootballSession["status"] = "COMPLETED",
  roster = [P],
): FootballSession {
  const date = `2027-03-${String(day).padStart(2, "0")}`;
  return {
    id: `s${day}-${++n}`,
    academyId: "a",
    sportId: "football",
    version: 1,
    updatedAt: "",
    updatedBy: "",
    branchId: "b",
    squadId: "sq",
    location: "Ground",
    coachIds: ["c"],
    timezone: "Asia/Kolkata",
    startLocal: `${date}T18:00`,
    endLocal: `${date}T19:00`,
    startAt: `${date}T12:30:00.000Z`,
    endAt: `${date}T13:30:00.000Z`,
    theme: "",
    status,
    roster: roster.map((playerId) => ({ playerId, name: playerId })),
    agenda: [],
    objectives: [],
  };
}
function mark(
  s: FootballSession,
  status: FootballAttendance["status"],
  correctionReason = "",
  playerId = P,
): FootballAttendance {
  return {
    id: `${s.id}:${playerId}`,
    academyId: "a",
    sportId: "football",
    version: 1,
    updatedAt: "",
    updatedBy: "",
    sessionId: s.id,
    playerId,
    status,
    correctionReason,
  };
}
/** Marks in chronological order, e.g. ["PRESENT","ABSENT"]. */
function history(
  statuses: FootballAttendance["status"][],
  staff = true,
  extra: {
    sessions?: FootballSession[];
    attendance?: FootballAttendance[];
  } = {},
) {
  const sessions = statuses.map((_, i) => session(i + 1)),
    attendance = statuses.map((status, i) => mark(sessions[i], status));
  return attendanceHistory({
    playerId: P,
    playerName: "Asha",
    sessions: [...sessions, ...(extra.sessions ?? [])],
    attendance: [...attendance, ...(extra.attendance ?? [])],
    squadNames: squads,
    staff,
  });
}

describe("attendance percentage", () => {
  it("is present / (present + absent + excused), to one decimal", () => {
    const h = history([
      "PRESENT",
      "PRESENT",
      "ABSENT",
      "EXCUSED",
      "PRESENT",
      "PRESENT",
      "ABSENT",
    ]);
    expect([h.present, h.absent, h.excused, h.counted]).toEqual([4, 2, 1, 7]);
    expect(h.percentage).toBe(57.1);
  });
  it("counts an excused absence in the denominator", () => {
    expect(history(["PRESENT", "EXCUSED"]).percentage).toBe(50);
    expect(history(["EXCUSED", "EXCUSED"]).percentage).toBe(0);
  });
  it("is null, not zero, when nothing has been recorded", () => {
    const h = history([]);
    expect(h.percentage).toBeNull();
    expect(h.counted).toBe(0);
    expect(h.consecutiveAbsences).toBe(0);
    expect(h.followUp).toBe(false);
  });
  it("is 100 for full attendance", () => {
    expect(history(["PRESENT", "PRESENT", "PRESENT"]).percentage).toBe(100);
  });
});

describe("which sessions count", () => {
  it("ignores cancelled, scheduled and in-progress sessions", () => {
    const cancelled = session(20, "CANCELLED"),
      scheduled = session(21, "SCHEDULED"),
      running = session(22, "IN_PROGRESS");
    const h = history(["PRESENT"], true, {
      sessions: [cancelled, scheduled, running],
      attendance: [
        mark(cancelled, "ABSENT"),
        mark(scheduled, "ABSENT"),
        mark(running, "ABSENT"),
      ],
    });
    expect(h.counted).toBe(1);
    expect(h.absent).toBe(0);
    expect(h.sessions).toHaveLength(1);
  });
  it("ignores an unmarked mark and a session the player was not on", () => {
    const stranger = session(20, "COMPLETED", ["other"]),
      unmarked = session(21);
    const h = history(["PRESENT"], true, {
      sessions: [stranger, unmarked],
      attendance: [
        mark(stranger, "ABSENT", "", "other"),
        mark(unmarked, "UNMARKED"),
      ],
    });
    expect(h.counted).toBe(1);
    expect(h.sessions.map((r) => r.status)).toEqual(["PRESENT"]);
  });
  it("ignores another player's marks on the same session", () => {
    const s = session(5, "COMPLETED", [P, "other"]);
    const h = attendanceHistory({
      playerId: P,
      playerName: "Asha",
      sessions: [s],
      attendance: [mark(s, "ABSENT", "", "other"), mark(s, "PRESENT")],
      squadNames: squads,
      staff: true,
    });
    expect([h.present, h.absent]).toEqual([1, 0]);
  });
  it("lists newest first with the academy-local date", () => {
    const h = history(["PRESENT", "ABSENT", "EXCUSED"]);
    expect(h.sessions.map((r) => r.date)).toEqual([
      "2027-03-03",
      "2027-03-02",
      "2027-03-01",
    ]);
    expect(h.sessions[0]).toMatchObject({
      status: "EXCUSED",
      squadName: "U12 Tuesday",
    });
  });
});

describe("consecutive absences", () => {
  it("counts the latest run of absences", () => {
    expect(history(["PRESENT", "ABSENT", "ABSENT"]).consecutiveAbsences).toBe(
      2,
    );
    expect(
      history(["ABSENT", "ABSENT", "PRESENT", "ABSENT"]).consecutiveAbsences,
    ).toBe(1);
  });
  it("is zero when the latest session was attended", () => {
    expect(
      history(["ABSENT", "ABSENT", "ABSENT", "PRESENT"]).consecutiveAbsences,
    ).toBe(0);
  });
  it("is not reset by an excused absence and does not count it", () => {
    const h = history(["ABSENT", "EXCUSED", "ABSENT", "EXCUSED", "ABSENT"]);
    expect(h.consecutiveAbsences).toBe(3);
    expect(h.followUp).toBe(true);
  });
  it("is not raised by excused absences alone", () => {
    const h = history(["EXCUSED", "EXCUSED", "EXCUSED", "EXCUSED"]);
    expect(h.consecutiveAbsences).toBe(0);
    expect(h.followUp).toBe(false);
  });
  it("flags at exactly three and not at two", () => {
    expect(history(["PRESENT", "ABSENT", "ABSENT"]).followUp).toBe(false);
    expect(history(["PRESENT", "ABSENT", "ABSENT", "ABSENT"]).followUp).toBe(
      true,
    );
  });
  it("clears the flag once the player attends", () => {
    expect(history(["ABSENT", "ABSENT", "ABSENT", "PRESENT"]).followUp).toBe(
      false,
    );
  });
  it("does not let a cancelled session break or extend the run", () => {
    const cancelled = session(15, "CANCELLED");
    const h = history(["ABSENT", "ABSENT", "ABSENT"], true, {
      sessions: [cancelled],
      attendance: [mark(cancelled, "PRESENT")],
    });
    expect(h.consecutiveAbsences).toBe(3);
  });
  it("orders by session time, not by input order", () => {
    const sessions = [session(1), session(2), session(3)];
    const marks = [
      mark(sessions[0], "ABSENT"),
      mark(sessions[1], "ABSENT"),
      mark(sessions[2], "PRESENT"),
    ];
    const h = attendanceHistory({
      playerId: P,
      playerName: "Asha",
      sessions: [sessions[2], sessions[0], sessions[1]],
      attendance: [marks[1], marks[2], marks[0]],
      squadNames: squads,
      staff: true,
    });
    expect(h.consecutiveAbsences).toBe(0);
    expect(h.sessions.map((r) => r.date)).toEqual([
      "2027-03-03",
      "2027-03-02",
      "2027-03-01",
    ]);
  });
});

describe("what a parent may see", () => {
  it("omits the follow-up flag and correction reasons for a parent", () => {
    const sessions = [session(1), session(2), session(3)];
    const h = attendanceHistory({
      playerId: P,
      playerName: "Asha",
      sessions,
      attendance: sessions.map((s) => mark(s, "ABSENT", "Coach noted a call")),
      squadNames: squads,
      staff: false,
    });
    expect(h.consecutiveAbsences).toBe(3);
    expect("followUp" in h).toBe(false);
    expect(h.sessions.every((r) => !("correctionReason" in r))).toBe(true);
    expect(JSON.stringify(h)).not.toContain("Coach noted");
  });
  it("shows correction reasons to staff", () => {
    const s = session(1);
    const h = attendanceHistory({
      playerId: P,
      playerName: "Asha",
      sessions: [s],
      attendance: [mark(s, "ABSENT", "Marked in error, was late")],
      squadNames: squads,
      staff: true,
    });
    expect(h.sessions[0].correctionReason).toBe("Marked in error, was late");
  });
});
