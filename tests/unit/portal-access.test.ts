// Wave 2 (navigation): what the portal offers each role, and proof that hiding is never the permission check.
// Part 1 is pure: the navigation lists and which sections a role may open. Part 2 runs the real server checks for the
// same roles and shows that what the navigation hides is also refused (or empty) on the server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import { workspace } from "@/server/workspace-service";
import type { AcademyRole } from "@/domain/workspace";
import type { PortalSection } from "@/features/workspaces/portal-types";
import {
  canUseFees,
  homeLabelFor,
  homeSectionFor,
  navigationFor,
  sectionAllowed,
} from "@/features/workspaces/portal-access";
import {
  A,
  callRoute,
  contextFor,
  ids,
  seedApiFixture,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-portal-access-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const withFees = ["development", "reports", "communication", "fees"];
const withoutFees = ["development", "reports", "communication"];
const labels = (role: AcademyRole, modules: string[]) =>
  navigationFor(role, modules).map((entry) => entry.label);
const keys = (role: AcademyRole, modules: string[]) =>
  navigationFor(role, modules).map((entry) => entry.key);

describe("the navigation each role is offered", () => {
  it("staff see the approved items in the approved order, and the address of Overview is still ?section=home", () => {
    const expected = [
      "Overview",
      "Players",
      "Calendar",
      "Training",
      "Reports",
      "Fees",
      "Communications",
      "Settings",
    ];
    expect(labels("OWNER", withFees)).toEqual(expected);
    expect(labels("ADMIN", withFees)).toEqual(expected);
    expect(keys("OWNER", withFees)).toEqual([
      "home",
      "players",
      "calendar",
      "training",
      "reports",
      "fees",
      "messages",
      "settings",
    ]);
  });
  it("Fees is not listed for a coach, nor for anyone when the fees module is off (never shown disabled)", () => {
    expect(labels("COACH", withFees)).toEqual([
      "Overview",
      "Players",
      "Calendar",
      "Training",
      "Reports",
      "Communications",
      "Settings",
    ]);
    expect(labels("OWNER", withoutFees)).not.toContain("Fees");
    expect(labels("ADMIN", withoutFees)).not.toContain("Fees");
  });
  it("support is offered Players, Reports and Settings only", () => {
    expect(labels("SUPPORT", withFees)).toEqual(["Players", "Reports", "Settings"]);
  });
  it("the family keeps four items: Home, Progress, Messages, More", () => {
    expect(labels("PARENT", withFees)).toEqual(["Home", "Progress", "Messages", "More"]);
    expect(keys("PARENT", withFees)).toEqual(["home", "reports", "messages", "settings"]);
    // The family never sees the staff names, and staff never see "More" or "Home".
    for (const role of ["OWNER", "ADMIN", "COACH", "SUPPORT"] as const) {
      expect(labels(role, withFees)).not.toContain("More");
      expect(labels(role, withFees)).not.toContain("Home");
    }
    expect(labels("PARENT", withFees)).not.toContain("Overview");
  });
  it("every item that is listed can be opened by the role it is listed for, and no label repeats", () => {
    for (const role of ["OWNER", "ADMIN", "COACH", "SUPPORT", "PARENT"] as const)
      for (const modules of [withFees, withoutFees]) {
        const list = navigationFor(role, modules);
        for (const entry of list)
          expect(sectionAllowed(role, entry.key, modules), `${role} ${entry.key}`).toBe(true);
        expect(new Set(list.map((entry) => entry.label)).size).toBe(list.length);
        expect(new Set(list.map((entry) => entry.key)).size).toBe(list.length);
      }
  });
  it("the list is a fresh copy each time, so a caller cannot change what the next role is offered", () => {
    const first = navigationFor("OWNER", withFees);
    first[0].label = "Changed";
    expect(navigationFor("OWNER", withFees)[0].label).toBe("Overview");
  });
});

describe("which sections a role may open", () => {
  const sections: PortalSection[] = [
    "home",
    "players",
    "calendar",
    "training",
    "reports",
    "fees",
    "settings",
    "messages",
    "development",
    "practice",
  ];
  const open = (role: AcademyRole, modules = withFees) =>
    sections.filter((section) => sectionAllowed(role, section, modules));
  it("owner, admin and coach open everything except the family-only practice page (and Fees without finance access)", () => {
    const all = sections.filter((s) => s !== "practice");
    expect(open("OWNER")).toEqual(all);
    expect(open("ADMIN")).toEqual(all);
    expect(open("COACH")).toEqual(all.filter((s) => s !== "fees"));
    expect(open("OWNER", withoutFees)).toEqual(all.filter((s) => s !== "fees"));
  });
  it("support opens Players, Reports, Development and Settings only", () => {
    expect(open("SUPPORT")).toEqual(["players", "reports", "settings", "development"]);
  });
  it("a parent opens neither Players nor Training, and Fees only when finance is on", () => {
    expect(open("PARENT")).toEqual(["home", "calendar", "reports", "fees", "settings", "messages", "development", "practice"]);
    expect(open("PARENT", withoutFees)).not.toContain("fees");
  });
  it("a player's own login opens Home, Schedule and More only: no fees, messages, reports, plans or practice", () => {
    const list = navigationFor("PARENT", withFees, true);
    expect(list.map((e) => e.label)).toEqual(["Home", "Schedule", "More"]);
    expect(sections.filter((section) => sectionAllowed("PARENT", section, withFees, true))).toEqual(["home", "calendar", "settings"]);
    for (const entry of list) expect(sectionAllowed("PARENT", entry.key, withFees, true)).toBe(true);
    // The flag changes nothing for anyone else.
    expect(navigationFor("OWNER", withFees, true)).toEqual(navigationFor("OWNER", withFees));
    expect(open("PARENT")).toContain("fees");
  });
  it("only owner, admin and a parent can use fees, and only with the module on", () => {
    for (const role of ["OWNER", "ADMIN", "PARENT"] as const) {
      expect(canUseFees(role, withFees)).toBe(true);
      expect(canUseFees(role, withoutFees)).toBe(false);
    }
    for (const role of ["COACH", "SUPPORT"] as const) expect(canUseFees(role, withFees)).toBe(false);
  });
  it("the landing section is Reports for support and Overview or Home for everyone else", () => {
    expect(homeSectionFor("SUPPORT")).toBe("reports");
    expect(homeLabelFor("SUPPORT")).toBe("Reports");
    for (const role of ["OWNER", "ADMIN", "COACH"] as const) {
      expect(homeSectionFor(role)).toBe("home");
      expect(homeLabelFor(role)).toBe("Overview");
    }
    expect(homeLabelFor("PARENT")).toBe("Home");
  });
});

describe("what the navigation hides, the server still refuses", () => {
  const root = `/api/workspaces/${A}`;
  const records = (as: "ownerA" | "coachA" | "parent1", kind: string, json?: unknown) =>
    callRoute(json === undefined ? recordsRoute.GET : recordsRoute.POST, {
      path: `${root}/records/${kind}`,
      method: json === undefined ? "GET" : "POST",
      as,
      params: { academyId: A, kind },
      json,
    });
  it("a coach is not offered Fees, receives no fee records and cannot create one", async () => {
    expect(labels("COACH", withFees)).not.toContain("Fees");
    expect(workspace(contextFor("coachA")).records.fee).toEqual([]);
    const read = await records("coachA", "fee");
    expect(JSON.stringify(read.body)).not.toContain(ids.p1);
    const create = await records("coachA", "fee", { playerId: ids.p1, amountMinor: 100, currency: "INR", label: "x" });
    expect(create.status).toBe(403);
  });
  it("a coach is refused the finance view that the Fees page is built on", async () => {
    const response = await callRoute(financeRoute.GET, {
      path: `${root}/finance`,
      as: "coachA",
      params: { academyId: A },
    });
    expect(response.status).toBe(403);
  });
  it("a parent is not offered Players or Training, and cannot create a player or a session", async () => {
    expect(keys("PARENT", withFees)).not.toContain("players");
    expect(keys("PARENT", withFees)).not.toContain("training");
    for (const kind of ["player", "session"])
      // Exactly 403, not just "an error": the answer to a payload this thin would be 400 if validation ran before the permission check.
      expect((await records("parent1", kind, { name: "x" })).status, kind).toBe(403);
  });
  it("the owner, who is offered Fees, is not refused it", async () => {
    expect(labels("OWNER", withFees)).toContain("Fees");
    const response = await callRoute(financeRoute.GET, {
      path: `${root}/finance`,
      as: "ownerA",
      params: { academyId: A },
    });
    expect(response.status).toBe(200);
  });
});
