// A child's own login (an account marked in player_link_login after the owner confirmed it) never reads or receives what is
// written for parents and guardians. These tests use the same fixture as the other API tests: parent-1 is the guardian of
// player-1, who has an approved report, a plan and an invoice. The account is first read as an ordinary guardian (the
// positive control), then marked as a player login, then read again, so the only thing that changes is the marker.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { visibleRecords, visibleRecord } from "@/server/workspace-access";
import { saveRecord, reply } from "@/server/workspace-service";
import { communicationJobs, communicationView, authorisedGuardian } from "@/server/communication-service";
import { PLAYER_LOGIN_HIDDEN_KINDS } from "@/server/player-login";
import { trialView } from "@/server/trial-service";
import { playerAttendanceHistory, attendanceFollowUps } from "@/server/attendance-history-service";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as financePdfRoute from "@/app/api/workspaces/[academyId]/finance/[kind]/[recordId]/pdf/route";
import * as reportPdfRoute from "@/app/api/workspaces/[academyId]/reports/[reportId]/pdf/route";
import * as communicationRoute from "@/app/api/workspaces/[academyId]/communication/route";
import {
  A,
  ids,
  callRoute,
  contextFor,
  seedApiFixture,
  type Fixture,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-player-link-restrictions-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let fixture: Fixture;
const root = `/api/workspaces/${A}`;
const mark = () =>
  database()
    .prepare("INSERT OR REPLACE INTO player_link_login(academyId,userId,playerId,confirmedAt,confirmedBy) VALUES(?,?,?,?,?)")
    .run(A, ids.parent1, ids.p1, new Date().toISOString(), ids.ownerA);
const unmark = () => database().prepare("DELETE FROM player_link_login WHERE academyId=? AND userId=?").run(A, ids.parent1);
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};
beforeAll(() => {
  fixture = seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
});

describe("what a player login is refused by the server (not just hidden in the screen)", () => {
  it("the hidden kinds are exactly these: removing one is a deliberate decision", () => {
    expect([...PLAYER_LOGIN_HIDDEN_KINDS].sort()).toEqual(
      ["conversation", "dietary", "fee", "plan", "report", "update", "weekly"].sort(),
    );
  });

  it("control: before it is marked, the same account is an ordinary guardian and reads all of it", async () => {
    unmark();
    const ctx = contextFor("parent1");
    expect(visibleRecords(ctx, "report").map((r) => r.id)).toContain(fixture.reports[ids.p1]);
    expect(visibleRecords(ctx, "plan").length).toBeGreaterThan(0);
    expect((await callRoute(financeRoute.GET, { path: `${root}/finance`, as: "parent1", params: { academyId: A } })).status).toBe(200);
    expect(
      (await callRoute(recordsRoute.GET, { path: `${root}/records/report`, as: "parent1", params: { academyId: A, kind: "report" } })).body,
    ).toHaveLength(1);
    expect(() => communicationView(ctx)).not.toThrow();
  });

  it("reports, plans, fees and every other parent-only kind come back empty from every read path", async () => {
    mark();
    const ctx = contextFor("parent1");
    for (const kind of PLAYER_LOGIN_HIDDEN_KINDS) {
      expect(visibleRecords(ctx, kind as never), kind).toEqual([]);
      const listed = await callRoute(recordsRoute.GET, { path: `${root}/records/${kind}`, as: "parent1", params: { academyId: A, kind } });
      expect(listed.status, kind).toBe(200);
      expect(listed.body, kind).toEqual([]);
    }
    expect(status(() => visibleRecord(ctx, "report", fixture.reports[ids.p1]))).toBe(404);
    const one = await callRoute(recordRoute.GET, {
      path: `${root}/records/report/${fixture.reports[ids.p1]}`,
      as: "parent1",
      params: { academyId: A, kind: "report", recordId: fixture.reports[ids.p1] },
    });
    expect(one.status).toBe(404);
  });

  it("the report PDF and the invoice PDF are refused", async () => {
    mark();
    const report = await callRoute(reportPdfRoute.GET, {
      path: `${root}/reports/${fixture.reports[ids.p1]}/pdf`,
      as: "parent1",
      params: { academyId: A, reportId: fixture.reports[ids.p1] },
    });
    expect(report.status).toBe(404);
    const invoice = await callRoute(financePdfRoute.GET, {
      path: `${root}/finance/invoice/${fixture.invoices[ids.p1]}/pdf`,
      as: "parent1",
      params: { academyId: A, kind: "invoice", recordId: fixture.invoices[ids.p1] },
    });
    expect([403, 404]).toContain(invoice.status);
  });

  it("fees are refused (403)", async () => {
    mark();
    const response = await callRoute(financeRoute.GET, { path: `${root}/finance`, as: "parent1", params: { academyId: A } });
    expect(response.status).toBe(403);
  });

  it("the delivery history and communication settings are refused (403)", async () => {
    mark();
    const ctx = contextFor("parent1");
    expect(status(() => communicationView(ctx))).toBe(403);
    expect(status(() => communicationJobs(ctx, new URLSearchParams()))).toBe(403);
    const response = await callRoute(communicationRoute.GET, { path: `${root}/communication`, as: "parent1", params: { academyId: A } });
    expect(response.status).toBe(403);
  });

  it("the player's own record, and the guardian next door, are not affected", async () => {
    mark();
    const ctx = contextFor("parent1");
    expect(visibleRecords(ctx, "player").map((p) => p.id)).toEqual([ids.p1]);
    // another family's guardian keeps every one of those reads
    const other = contextFor("parent2");
    expect(visibleRecords(other, "report").length).toBeGreaterThan(0);
    expect((await callRoute(financeRoute.GET, { path: `${root}/finance`, as: "parent2", params: { academyId: A } })).status).toBe(200);
  });

  it("a player login is not a guardian contact, so no message can be addressed to it", () => {
    unmark();
    expect(authorisedGuardian(A, ids.parent1)).toBe(true);
    mark();
    expect(authorisedGuardian(A, ids.parent1)).toBe(false);
    expect(authorisedGuardian(A, ids.parent2)).toBe(true);
  });
});

describe("private conversations", () => {
  it("staff cannot start a private conversation addressed to a player login (403); a guardian still can", () => {
    unmark();
    const owner = contextFor("ownerA");
    const made = saveRecord(owner, "conversation", { playerId: ids.p1, guardianId: ids.parent1, subject: "Control: before marking" }) as { id: string };
    expect(made.id).toBeTruthy();
    mark();
    for (const who of ["ownerA", "adminA", "coachA"] as const)
      expect(
        status(() => saveRecord(contextFor(who), "conversation", { playerId: ids.p1, guardianId: ids.parent1, subject: "Hello" })),
        who,
      ).toBe(403);
    // the other family is unaffected
    expect(saveRecord(owner, "conversation", { playerId: ids.p2, guardianId: ids.parent2, subject: "Still allowed" })).toBeTruthy();
  });

  it("staff cannot reply into a conversation addressed to a player login, and the player login cannot read or write one", () => {
    unmark();
    const owner = contextFor("ownerA");
    const conversation = saveRecord(owner, "conversation", { playerId: ids.p1, guardianId: ids.parent1, subject: "Opened as a guardian" }) as { id: string };
    expect(reply(owner, conversation.id, { body: "Control reply" })).toBeTruthy();
    mark();
    expect(status(() => reply(owner, conversation.id, { body: "Should be refused" }))).toBe(403);
    const player = contextFor("parent1");
    expect(visibleRecords(player, "conversation")).toEqual([]);
    expect(status(() => reply(player, conversation.id, { body: "Hi" }))).toBe(403);
    expect(status(() => saveRecord(player, "conversation", { playerId: ids.p1, guardianId: ids.parent1, subject: "Hi coach" }))).toBe(403);
  });

  it("a player login cannot send a dietary note; a guardian can", () => {
    unmark();
    expect(saveRecord(contextFor("parent1"), "dietary", { playerId: ids.p1, note: "No nuts" })).toBeTruthy();
    mark();
    expect(status(() => saveRecord(contextFor("parent1"), "dietary", { playerId: ids.p1, note: "Anything" }))).toBe(403);
    unmark();
  });
});

describe("older own-login accounts are not changed", () => {
  it("an account with a player_self_login row and no marker keeps reports, fees and conversations", async () => {
    unmark();
    database().prepare("INSERT OR REPLACE INTO player_self_login(academyId,userId,playerId) VALUES(?,?,?)").run(A, ids.parent1, ids.p1);
    const ctx = contextFor("parent1");
    expect(visibleRecords(ctx, "report").length).toBeGreaterThan(0);
    expect((await callRoute(financeRoute.GET, { path: `${root}/finance`, as: "parent1", params: { academyId: A } })).status).toBe(200);
    expect(() => communicationView(ctx)).not.toThrow();
    expect(authorisedGuardian(A, ids.parent1)).toBe(true);
    expect(saveRecord(contextFor("ownerA"), "conversation", { playerId: ids.p1, guardianId: ids.parent1, subject: "Older account" })).toBeTruthy();
    database().prepare("DELETE FROM player_self_login WHERE academyId=? AND userId=?").run(A, ids.parent1);
  });
});

describe("recipient lists: the places that choose guardians to write to all leave a player login out", () => {
  // A ratchet. Every statement that selects from guardian_relationships in the server code is counted, with how many of them
  // carry the player_link_login exclusion. A new guardian query changes a number and fails here, so whoever adds it must
  // decide whether it is a recipient list (exclude) or the account's own read (leave). The reason is next to each file.
  const expected: Record<string, [total: number, excluded: number, why: string]> = {
    "attendance-history-service.ts": [1, 0, "a guardian reading their own child's attendance"],
    "batch-announcement-service.ts": [3, 2, "the send list and the share list exclude; the third is an account reading its own announcements"],
    "communication-service.ts": [2, 0, "authorisedGuardian refuses a player login in code; the other is an account reading its own contact"],
    "communication-worker.ts": [1, 1, "WhatsApp and email reminders"],
    "data-integrity.ts": [1, 0, "a consistency check, not a recipient list"],
    "finance-service.ts": [1, 1, "fee reminders"],
    "membership-service.ts": [1, 0, "accepting an invitation clears the account's own links"],
    "messaging-service.ts": [2, 0, "the recipient picker skips a player login in code (tested in player-links.test.ts); the other is an account reading its own messages"],
    "parent-schedule-service.ts": [2, 0, "an account reading its own children's schedule"],
    "period-service.ts": [1, 1, "weekly plan publication"],
    "session-notices.ts": [1, 1, "session notices"],
    "session-share-service.ts": [3, 2, "session and report share lists exclude; the third reads a coach's own relation"],
    "whatsapp-webhooks.ts": [1, 0, "an inbound reply from a known contact"],
    "workspace-service.ts": [4, 1, "update publication excludes; the others are staff lists, the conversation check (refused in code) and the roster"],
  };
  it("counts match the table", () => {
    const dir = join(process.cwd(), "src", "server");
    const found: Record<string, [number, number]> = {};
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      let total = 0,
        excluded = 0,
        at = text.indexOf("FROM guardian_relationships");
      while (at !== -1) {
        total++;
        const rest = text.slice(at, at + 700),
          end = rest.search(/["`]\s*,?\s*\r?\n/);
        if ((end === -1 ? rest : rest.slice(0, end)).includes("player_link_login")) excluded++;
        at = text.indexOf("FROM guardian_relationships", at + 1);
      }
      if (total) found[file] = [total, excluded];
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(expected).map(([file, [t, e]]) => [file, [t, e]])));
  });
});

describe("attendance history: a player login reads only its own", () => {
  it("control: an ordinary guardian reads the linked child's history, never another child's", () => {
    unmark();
    const ctx = contextFor("parent1");
    const own = playerAttendanceHistory(ctx, ids.p1);
    expect(own.playerId).toBe(ids.p1);
    expect(own.sessions.length).toBeGreaterThan(0);
    expect(status(() => playerAttendanceHistory(ctx, ids.p2))).toBe(404);
  });

  it("a player login reads its own history without the staff-only fields", () => {
    mark();
    const ctx = contextFor("parent1");
    const own = playerAttendanceHistory(ctx, ids.p1);
    expect(own.playerId).toBe(ids.p1);
    expect(own.sessions.length).toBeGreaterThan(0);
    expect(own.followUp).toBeFalsy();
    expect(JSON.stringify(own)).not.toContain("Synthetic Kabir");
  });

  it("a player login is refused every other player's history and the follow-up list", () => {
    mark();
    const ctx = contextFor("parent1");
    expect(status(() => playerAttendanceHistory(ctx, ids.p2))).toBe(404);
    expect(status(() => playerAttendanceHistory(ctx, "player-does-not-exist"))).toBe(404);
    expect(status(() => attendanceFollowUps(ctx))).toBe(403);
  });
});

describe("trial summaries", () => {
  it("control: an ordinary guardian can open the trial view; a player login is refused (403)", () => {
    unmark();
    const ctx = contextFor("parent1");
    expect(status(() => trialView(ctx))).toBe(200);
    mark();
    expect(status(() => trialView(ctx))).toBe(403);
    expect(status(() => trialView(ctx, ids.p1))).toBe(403);
  });
});
