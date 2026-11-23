// Free calendar links and "tell everyone": the calendar text, the private feed, the lists of people to tell, and the
// phone numbers behind the WhatsApp buttons. All names and addresses are fictional.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({
  WorkspaceError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authenticatedUser: vi.fn(),
}));
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { saveRecord } from "@/server/workspace-service";
import { announcementRepository } from "@/server/batch-announcement-repository";
import { announcementShare } from "@/server/batch-announcement-service";
import {
  calendarFeed,
  issueCalendarToken,
} from "@/server/calendar-feed-service";
import {
  reportShare,
  sessionShare,
  setMemberPhone,
} from "@/server/session-share-service";
import { buildIcs, foldLine, googleCalendarLink, icsText } from "@/services/calendar-ics";
import { sessionMessage } from "@/services/session-message";
import type { AcademyConfiguration, AcademyRole, WorkspacePlayer } from "@/domain/workspace";
import { actorFor, linkGuardian, memberId, newAcademyConfig, seedAcademy, statusOf } from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-calendar-sharing-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});

describe("calendar text", () => {
  it("escapes text, folds long lines at 75 octets and ends every line with CRLF", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = foldLine(`DESCRIPTION:${"é".repeat(120)}`);
    for (const line of long.split("\r\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    const text = buildIcs("Academy, training", [
      {
        uid: "s1@sportozen",
        title: "U12 training",
        startAt: "2026-11-20T11:30:00.000Z",
        endAt: "2026-11-20T13:00:00.000Z",
        location: "Main ground",
        description: "Drills:\n1. Passing (10 min)",
      },
    ]);
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(text).toContain("DTSTART:20261120T113000Z");
    expect(text).toContain("DTEND:20261120T130000Z");
    expect(text).toContain("X-WR-CALNAME:Academy\\, training");
    expect(text).toContain("DESCRIPTION:Drills:\\n1. Passing (10 min)");
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("drops an event with an impossible time instead of writing a broken file", () => {
    const text = buildIcs("x", [{ uid: "a", title: "t", startAt: "nope", endAt: "2026-11-20T13:00:00Z" }]);
    expect(text).not.toContain("BEGIN:VEVENT");
  });
  it("builds a Google Calendar link that carries the time and place", () => {
    const url = googleCalendarLink({
      uid: "a",
      title: "U12 training",
      startAt: "2026-11-20T11:30:00Z",
      endAt: "2026-11-20T13:00:00Z",
      location: "Main ground",
    });
    expect(url).toContain("calendar.google.com/calendar/render");
    expect(url).toContain("dates=20261120T113000Z%2F20261120T130000Z");
  });
});

describe("the message a coach or parent receives", () => {
  const session = {
    status: "SCHEDULED",
    title: "U12 training",
    startAt: "2026-11-20T11:30:00.000Z",
    endAt: "2026-11-20T13:00:00.000Z",
    timezone: "Asia/Kolkata",
    location: "Main ground",
    drills: [{ name: "Passing square", minutes: 10 }],
  };
  it("names the time in the session's own zone, the place and the drills", () => {
    const m = sessionMessage({
      academyName: "Test Academy",
      session,
      person: { name: "Asha Rao", role: "PARENT", children: ["Rishi"] },
    });
    expect(m.text).toContain("Hello Asha,");
    expect(m.text).toContain("17:00–18:30 (Asia/Kolkata)");
    expect(m.text).toContain("Where: Main ground");
    expect(m.text).toContain("For: Rishi");
    expect(m.text).toContain("1. Passing square (10 min)");
    expect(m.subject).toContain("U12 training");
  });
  it("a cancellation says so and lists no drills", () => {
    const m = sessionMessage({
      academyName: "Test Academy",
      session: { ...session, status: "CANCELLED" },
      person: { name: "Coach Kumar", role: "COACH", children: [] },
    });
    expect(m.text).toContain("cancelled");
    expect(m.text).not.toContain("Drills:");
    expect(m.subject.startsWith("Cancelled:")).toBe(true);
  });
});

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const coachId = () => memberId("COACH", academy);
const parentId = () => memberId("PARENT", academy);
const ownerId = () => memberId("OWNER", academy);
const make = (name: string, over: Record<string, unknown> = {}) =>
  saveRecord(as("OWNER"), "player", {
    name,
    coachId: coachId(),
    sportIds: ["football"],
    birthDate: "2015-05-05",
    ...over,
  }) as WorkspacePlayer;
const addEmail = () => {
  const db = database();
  try {
    db.exec('ALTER TABLE "user" ADD COLUMN email TEXT');
  } catch {
    /* already there */
  }
  for (const role of ["OWNER", "COACH", "PARENT"] as const)
    db.prepare('UPDATE "user" SET email=? WHERE id=?').run(
      `${role.toLowerCase()}@example.test`,
      memberId(role, academy),
    );
};
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
function addSession(over: Record<string, unknown> = {}) {
  const id = (over.id as string) ?? randomUUID(),
    start = day(2),
    end = new Date(start.getTime() + 90 * 60_000);
  repo.save(academy.id, "session", {
    id,
    academyId: academy.id,
    sportId: "football",
    version: 3,
    updatedAt: new Date().toISOString(),
    updatedBy: ownerId(),
    branchId: "b1",
    squadId: "sq1",
    location: "Main ground",
    coachIds: [coachId()],
    timezone: "Asia/Kolkata",
    startLocal: "2026-11-20T17:00",
    endLocal: "2026-11-20T18:30",
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    theme: "Passing",
    status: "SCHEDULED",
    roster: [],
    agenda: [
      { drill: { name: "Passing square" } as never, duration: 10, drillVersion: 1 },
    ],
    objectives: [],
    ...over,
  } as never);
  return id;
}

beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
  addEmail();
});

describe("private calendar link", () => {
  it("shows a coach their own sessions with the drills, and no player names", () => {
    const rishi = make("Rishi Kapoor");
    addSession({ roster: [{ playerId: rishi.id, name: rishi.name }] });
    addSession({ coachIds: ["someone-else"], theme: "Other", id: "other" });
    const { token } = issueCalendarToken(as("COACH"));
    const text = calendarFeed(token)!;
    expect(text).toContain("BEGIN:VEVENT");
    expect(text).toContain("Passing square (10 min)");
    expect(text).toContain("1 player");
    expect(text).not.toContain("Rishi");
    expect(text).not.toContain("other@sportozen");
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
  it("stores only a hash of the secret", () => {
    const { token } = issueCalendarToken(as("COACH"));
    const rows = database().prepare("SELECT tokenHash FROM calendar_feeds WHERE academyId=?").all(academy.id);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].tokenHash)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(String(rows[0].tokenHash)).not.toContain(token);
  });
  it("owner sees every session; a draft is never shown", () => {
    addSession();
    addSession({ coachIds: ["someone-else"] });
    addSession({ status: "DRAFT" });
    const text = calendarFeed(issueCalendarToken(as("OWNER")).token)!;
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
  it("a parent sees only sessions their own child is on, with only that child's first name", () => {
    const mine = make("Rishi Kapoor"),
      other = make("Meera Shah");
    linkGuardian(academy, parentId(), mine.id);
    addSession({ id: "s-mine", roster: [{ playerId: mine.id, name: mine.name }, { playerId: other.id, name: other.name }] });
    addSession({ id: "s-other", roster: [{ playerId: other.id, name: other.name }] });
    const text = calendarFeed(issueCalendarToken(as("PARENT")).token)!;
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain("UID:s-mine@sportozen");
    expect(text).toContain("Rishi");
    expect(text).not.toContain("Meera");
    expect(text).not.toContain("Kapoor");
  });
  it("shows a cancelled session as cancelled", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    addSession({ status: "CANCELLED", cancelledFrom: "SCHEDULED", roster: [{ playerId: kid.id, name: kid.name }] });
    const text = calendarFeed(issueCalendarToken(as("PARENT")).token)!;
    expect(text).toContain("STATUS:CANCELLED");
    expect(text).toContain("SUMMARY:Cancelled:");
  });
  it("a new link stops the old one, and a wrong link gives nothing", () => {
    const first = issueCalendarToken(as("COACH")).token,
      second = issueCalendarToken(as("COACH")).token;
    expect(first).not.toBe(second);
    expect(calendarFeed(first)).toBeNull();
    expect(calendarFeed(second)).not.toBeNull();
    expect(calendarFeed("x".repeat(43))).toBeNull();
    expect(calendarFeed("short")).toBeNull();
    expect(calendarFeed("../../etc/passwd")).toBeNull();
  });
  it("stops when the person leaves or the academy is suspended", () => {
    const token = issueCalendarToken(as("COACH")).token;
    database().prepare("UPDATE platform_entitlements SET status='SUSPENDED' WHERE academyId=?").run(academy.id);
    expect(calendarFeed(token)).toBeNull();
    database().prepare("UPDATE platform_entitlements SET status='ACTIVE' WHERE academyId=?").run(academy.id);
    expect(calendarFeed(token)).not.toBeNull();
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?").run(academy.id, coachId());
    expect(calendarFeed(token)).toBeNull();
  });
  it("is not available to a support account", async () => {
    expect(await statusOf(() => issueCalendarToken(as("SUPPORT")))).toBe(403);
  });
});

describe("telling the coaches and parents of a session", () => {
  it("lists the coach and the parents, with children's first names", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const id = addSession({ roster: [{ playerId: kid.id, name: kid.name }] });
    const share = sessionShare(as("OWNER"), id);
    expect(share.people.map((p) => p.role)).toEqual(["COACH", "PARENT"]);
    const parent = share.people.find((p) => p.role === "PARENT")!;
    expect(parent.children).toEqual(["Rishi"]);
    expect(parent.email).toBe("parent@example.test");
    expect(share.session.drills).toEqual([{ name: "Passing square", minutes: 10 }]);
  });
  it("is closed to a parent and to a coach who is not on the session, and to a draft", async () => {
    const id = addSession(),
      other = addSession({ coachIds: ["someone-else"] }),
      draft = addSession({ status: "DRAFT" });
    expect(await statusOf(() => sessionShare(as("PARENT"), id))).toBe(403);
    expect(await statusOf(() => sessionShare(as("COACH"), other))).not.toBe(0);
    expect(await statusOf(() => sessionShare(as("OWNER"), draft))).toBe(409);
  });
  it("skips a parent whose membership has ended", () => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const id = addSession({ roster: [{ playerId: kid.id, name: kid.name }] });
    database().prepare("UPDATE academy_memberships SET active=0 WHERE academyId=? AND userId=?").run(academy.id, parentId());
    expect(sessionShare(as("OWNER"), id).people.map((p) => p.role)).toEqual(["COACH"]);
  });
});

describe("phone numbers behind the WhatsApp buttons", () => {
  const kid = () => {
    const k = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), k.id);
    return k;
  };
  it("the owner saves a number in international form and the list then offers it", () => {
    const k = kid(),
      id = addSession({ roster: [{ playerId: k.id, name: k.name }] });
    expect(setMemberPhone(as("OWNER"), { userId: parentId(), phone: "98765 43210" }).phone).toBe("919876543210");
    const parent = sessionShare(as("OWNER"), id).people.find((p) => p.role === "PARENT")!;
    expect(parent.phone).toBe("919876543210");
    expect(setMemberPhone(as("OWNER"), { userId: parentId(), phone: "" }).phone).toBeNull();
  });
  it("refuses a number that is not one, and a person who is not a member", async () => {
    kid();
    expect(await statusOf(() => setMemberPhone(as("OWNER"), { userId: parentId(), phone: "abc" }))).toBe(400);
    expect(await statusOf(() => setMemberPhone(as("OWNER"), { userId: "nobody", phone: "+919876543210" }))).toBe(404);
  });
  it("a coach may add it for a parent of their own player; a parent only for themselves", async () => {
    kid();
    expect(setMemberPhone(as("COACH"), { userId: parentId(), phone: "+919876543210" }).phone).toBe("919876543210");
    expect(setMemberPhone(as("PARENT"), { userId: parentId(), phone: "+919876543211" }).phone).toBe("919876543211");
    expect(await statusOf(() => setMemberPhone(as("PARENT"), { userId: coachId(), phone: "+919876543212" }))).toBe(403);
  });
  it("a coach cannot set the number of a parent who has no child with them", async () => {
    expect(await statusOf(() => setMemberPhone(as("COACH"), { userId: parentId(), phone: "+919876543210" }))).toBe(403);
  });
});

describe("sharing an approved report", () => {
  const report = (status: string, withSnapshot = true) => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    const id = randomUUID();
    repo.save(academy.id, "report", {
      id,
      academyId: academy.id,
      sportId: "football",
      playerId: kid.id,
      planId: "p",
      period: "November 2026",
      observation: "",
      evidenceType: "COACH_OBSERVATION",
      nextStep: "",
      closingNote: "",
      status,
      externalDeliveryStatus: "NOT_SENT",
      ...(withSnapshot ? { snapshot: { player: "Rishi Kapoor", period: "November 2026" } } : {}),
    } as never);
    return id;
  };
  it("lists the child's parents for an approved report", () => {
    const share = reportShare(as("OWNER"), report("Approved"));
    expect(share.report.childFirstName).toBe("Rishi");
    expect(share.people.map((p) => p.email)).toEqual(["parent@example.test"]);
  });
  it("refuses a draft, a report with nothing approved, and a parent", async () => {
    expect(await statusOf(() => reportShare(as("OWNER"), report("Draft")))).toBe(409);
    expect(await statusOf(() => reportShare(as("OWNER"), report("Approved", false)))).toBe(409);
    expect(await statusOf(() => reportShare(as("PARENT"), report("Approved")))).toBe(403);
  });
});

describe("sending an approved announcement yourself", () => {
  const announcement = (status: string, expiresInDays = 3) => {
    const kid = make("Rishi Kapoor");
    linkGuardian(academy, parentId(), kid.id);
    repo.save(academy.id, "squad", {
      id: "sq-ann",
      academyId: academy.id,
      sportId: "football",
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: ownerId(),
      name: "U12 Blue",
      branchId: "b1",
      playerIds: [kid.id],
    } as never);
    const id = randomUUID(),
      now = new Date().toISOString();
    announcementRepository.save({
      id,
      academyId: academy.id,
      version: 2,
      authorId: ownerId(),
      createdAt: now,
      updatedAt: now,
      kind: "TIME_CHANGED",
      urgency: "NORMAL",
      batchIds: ["sq-ann"],
      body: "Training moves to 6 pm on Friday.",
      expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
      status,
      approval: { reviewerId: ownerId(), approvedAt: now, fingerprint: "f", renderedBody: "x", templateName: "", recipients: [] },
    } as never);
    return id;
  };
  it("lists the parents of the batch with the approved wording", () => {
    const share = announcementShare(as("OWNER"), announcement("APPROVED"));
    expect(share.body).toBe("Training moves to 6 pm on Friday.");
    expect(share.heading).toBe("Training time changed");
    expect(share.people.map((p) => [p.email, p.children])).toEqual([["parent@example.test", ["Rishi"]]]);
  });
  it("offers a saved number and leaves out a parent who opted out", () => {
    const id = announcement("APPROVED");
    setMemberPhone(as("OWNER"), { userId: parentId(), phone: "+919876543210" });
    expect(announcementShare(as("OWNER"), id).people[0].phone).toBe("919876543210");
  });
  it("refuses a draft, an expired announcement and a parent", async () => {
    expect(await statusOf(() => announcementShare(as("OWNER"), announcement("DRAFT")))).toBe(409);
    expect(await statusOf(() => announcementShare(as("OWNER"), announcement("APPROVED", -1)))).toBe(409);
    expect(await statusOf(() => announcementShare(as("PARENT"), announcement("APPROVED")))).toBe(403);
  });
});
