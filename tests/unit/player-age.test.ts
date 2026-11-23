// Players are under 18: the date rules, the refusals on the server, and the owner's age review.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { saveRecord } from "@/server/workspace-service";
import { reviewAge } from "@/server/player-age-service";
import type { AcademyConfiguration, AcademyRole, WorkspacePlayer } from "@/domain/workspace";
import {
  ageOn,
  ageState,
  daysBetween,
  isCalendarDay,
  isUnder18,
  turns18On,
} from "@/domain/player-age";
import { COUNTRY_CALLING_CODE, savedPhoneLink, gmailLink, outlookLink, mailtoLink, normalizePhone, whatsappLink } from "@/services/share-links";
import { actorFor, memberId, newAcademyConfig, seedAcademy, statusOf } from "./helpers/academy-fixture";

const filename = join(tmpdir(), `sportozen-player-age-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"])
    try {
      rmSync(filename + suffix, { force: true });
    } catch {
      /* the temp folder is disposable */
    }
});

describe("age: a player is under 18 until the day of their 18th birthday", () => {
  it("counts whole years and turns 18 on the birthday", () => {
    expect(ageOn("2008-06-15", "2026-06-14")).toBe(17);
    expect(ageOn("2008-06-15", "2026-06-15")).toBe(18);
    expect(isUnder18("2008-06-15", "2026-06-14")).toBe(true);
    expect(isUnder18("2008-06-15", "2026-06-15")).toBe(false);
    expect(turns18On("2008-06-15")).toBe("2026-06-15");
    expect(turns18On("2008-02-29")).toBe("2026-03-01");
    expect(daysBetween("2026-11-18", "2026-12-18")).toBe(30);
  });
  it("accepts only real calendar days", () => {
    expect(isCalendarDay("2014-02-28")).toBe(true);
    expect(isCalendarDay("2014-02-31")).toBe(false);
    expect(isCalendarDay("14-02-28")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });
  it("says where a player stands for the owner's review", () => {
    const today = "2026-11-18";
    expect(ageState({ birthDate: "", status: "ACTIVE" }, today)).toEqual({ kind: "BIRTH_DATE_MISSING" });
    expect(ageState({ birthDate: "2014-02-03", status: "ACTIVE" }, today)).toEqual({ kind: "OK" });
    expect(ageState({ birthDate: "2008-12-01", status: "ACTIVE" }, today)).toEqual({ kind: "TURNING_18", on: "2026-12-01", inDays: 13 });
    expect(ageState({ birthDate: "2008-11-18", status: "ACTIVE" }, today)).toEqual({ kind: "DECIDE", turnedOn: "2026-11-18" });
    expect(ageState({ birthDate: "2000-01-01", status: "ARCHIVED" }, today)).toEqual({ kind: "OK" });
    const keep = { decision: "KEEP" as const, reason: "Coaching until the season ends.", decidedBy: "o", decidedAt: "2026-11-01T00:00:00Z", recheckOn: "2027-01-31" };
    expect(ageState({ birthDate: "2000-01-01", status: "ACTIVE", ageDecision: keep }, today)).toEqual({ kind: "KEPT", until: "2027-01-31" });
    expect(ageState({ birthDate: "2000-01-01", status: "ACTIVE", ageDecision: keep }, "2027-02-01").kind).toBe("DECIDE");
  });
});

let academy: AcademyConfiguration;
const as = (role: AcademyRole) => actorFor(role, academy);
const coach = () => memberId("COACH", academy);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const make = (over: Record<string, unknown> = {}, role: AcademyRole = "OWNER") =>
  saveRecord(as(role), "player", {
    name: "Fictional Player",
    coachId: coach(),
    sportIds: ["football"],
    birthDate: yearsAgo(12),
    ...over,
  }) as WorkspacePlayer;

beforeEach(() => {
  academy = newAcademyConfig();
  seedAcademy(academy);
});

describe("the server refuses a player who is not under 18", () => {
  it("needs a date of birth", async () => {
    expect(await statusOf(() => make({ birthDate: undefined }))).toBe(400);
    expect(await statusOf(() => make({ birthDate: "" }))).toBe(400);
    expect(repo.list(academy.id, "player")).toHaveLength(0);
  });
  it("refuses 18 or older, today's 18th birthday, a future day and an impossible day", async () => {
    // (A future day is refused by the request schema before the age rule: no status, a validation error.)
    for (const birthDate of [yearsAgo(21), yearsAgo(18)])
      expect(await statusOf(() => make({ birthDate })), birthDate).toBe(400);
    for (const birthDate of [yearsAgo(-1), "2014-02-31"])
      expect(await statusOf(() => make({ birthDate })), birthDate).not.toBe(0);
    expect(repo.list(academy.id, "player")).toHaveLength(0);
  });
  it("accepts an under-18 player", () => {
    expect(make({ birthDate: yearsAgo(17) }).birthDate).toBe(yearsAgo(17));
  });
});

describe("the owner decides about a player who has turned 18", () => {
  /** As if the years had passed: the stored record is now 18 or older. */
  const overAge = () => {
    const player = make();
    repo.save(academy.id, "player", { ...player, recordVersion: undefined, birthDate: "2000-01-01" });
    return repo.find(academy.id, "player", player.id) as WorkspacePlayer;
  };
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it("an 18+ player with no decision cannot be edited, only archived", async () => {
    const player = overAge();
    const edit = { name: "Renamed", coachId: coach(), sportIds: ["football"], birthDate: "2000-01-01", expectedVersion: player.recordVersion };
    expect(await statusOf(() => saveRecord(as("OWNER"), "player", edit, player.id))).toBe(400);
    const archived = saveRecord(as("OWNER"), "player", { ...edit, status: "ARCHIVED" }, player.id) as WorkspacePlayer;
    expect(archived.status).toBe("ARCHIVED");
  });
  it("reject: keep for now needs a reason and a day ahead, and leaves the player active and editable", async () => {
    const player = overAge();
    expect(await statusOf(() => reviewAge(as("OWNER"), player.id, { decision: "KEEP", reason: "x", recheckOn: inDays(5) }))).toBe(422);
    expect(await statusOf(() => reviewAge(as("OWNER"), player.id, { decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: "2020-01-01" }))).toBe(422);
    expect(await statusOf(() => reviewAge(as("OWNER"), player.id, { decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: "2099-01-01" }))).toBe(422);
    const kept = reviewAge(as("OWNER"), player.id, { decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: inDays(5) }) as WorkspacePlayer;
    expect(kept.status).toBe("ACTIVE");
    expect(kept.ageDecision?.decision).toBe("KEEP");
    // Editing the profile keeps the decision and cannot change it.
    const edited = saveRecord(
      as("OWNER"),
      "player",
      { name: "Renamed", coachId: coach(), sportIds: ["football"], birthDate: "2000-01-01", expectedVersion: kept.recordVersion },
      player.id,
    ) as WorkspacePlayer;
    expect(edited.ageDecision?.recheckOn).toBe(inDays(5));
  });
  it("accept: archive keeps the record and clears the decision", () => {
    const player = overAge();
    const archived = reviewAge(as("OWNER"), player.id, { decision: "ARCHIVE" }) as WorkspacePlayer;
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.ageDecision).toBeNull();
    expect(repo.find(academy.id, "player", player.id)?.name).toBe("Fictional Player");
  });
  it("a player who does not need a decision is refused, and only the owner decides", async () => {
    const young = make();
    expect(await statusOf(() => reviewAge(as("OWNER"), young.id, { decision: "ARCHIVE" }))).toBe(409);
    const player = overAge();
    for (const role of ["ADMIN", "COACH", "PARENT", "SUPPORT"] as const)
      expect(await statusOf(() => reviewAge(as(role), player.id, { decision: "ARCHIVE" })), role).toBe(403);
  });
});

describe("free sharing links", () => {
  it("builds a wa.me chat with the number and the text, or WhatsApp's own chooser without one", () => {
    const text = "Hello Meera,\n\nTrial & fees: 50% off? #1";
    const link = whatsappLink("+91 98765-43210", text);
    expect(link.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(link.split("?text=")[1])).toBe(text);
    expect(link).not.toMatch(/[+ \n]/);
    expect(whatsappLink("98765 43210", "Hi", COUNTRY_CALLING_CODE.IN)).toBe("https://wa.me/919876543210?text=Hi");
    expect(whatsappLink("not a number", "Hi")).toBe("https://wa.me/?text=Hi");
    expect(whatsappLink(null, "Hi")).toBe("https://wa.me/?text=Hi");
    expect(normalizePhone("98765 43210", null)).toBeNull();
    for (const bad of ["", "abc", "+12", "++919876543210", "91+9876543210"]) expect(normalizePhone(bad, "91")).toBeNull();
  });
  it("builds a mailto: with recipient, subject and body encoded, and no header injection", () => {
    expect(mailtoLink("mother@example.test", "Trial day", "Line one\nLine two & more")).toBe(
      "mailto:mother@example.test?subject=Trial%20day&body=Line%20one%0ALine%20two%20%26%20more",
    );
    const injected = mailtoLink("a@b.test", "Subject\r\nBcc: evil@example.test", "x");
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toContain("Subject%0D%0ABcc%3A%20evil%40example.test");
  });
  it("a number the app saved as international digits opens that chat, not a doubled country code", () => {
    // Read through whatsappLink with a country code, 919876543210 would become 91919876543210.
    expect(whatsappLink("919876543210", "Hi", "91")).toBe("https://wa.me/91919876543210?text=Hi");
    expect(savedPhoneLink("919876543210", "Hi there")).toBe("https://wa.me/919876543210?text=Hi%20there");
    expect(savedPhoneLink("+919876543210", "Hi")).toBe("https://wa.me/919876543210?text=Hi");
  });
  it("builds Gmail and Outlook web compose links for computers with no mail app", () => {
    const g = gmailLink("mother@example.test", "Trial day", "Line one\nLine two & more");
    expect(g).toBe(
      "https://mail.google.com/mail/?view=cm&fs=1&to=mother%40example.test&su=Trial%20day&body=Line%20one%0ALine%20two%20%26%20more",
    );
    const o = outlookLink("mother@example.test", "Trial day", "Hi & bye");
    expect(o).toBe(
      "https://outlook.live.com/mail/0/deeplink/compose?to=mother%40example.test&subject=Trial%20day&body=Hi%20%26%20bye",
    );
    const injected = gmailLink("a@b.test", "Subject\r\nBcc: evil@example.test", "x");
    expect(injected).not.toMatch(/[\r\n ]/);
    expect(gmailLink(null, "S", "B")).toContain("&to=&su=S");
  });
});
