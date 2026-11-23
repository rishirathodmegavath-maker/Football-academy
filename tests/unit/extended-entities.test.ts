// WP2: the focused reads and the payload over the entities the baseline
// fixture lacks: payments, a trial, a published update, a conversation, a
// weekly plan, a platform administrator and an authorised support member.
// Roles, academy isolation and Support auditing are checked for each.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { homeSummary } from "@/server/home-summary-service";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as trialsRoute from "@/app/api/workspaces/[academyId]/trials/route";
import * as homeRoute from "@/app/api/workspaces/[academyId]/home/route";
import * as bootstrapRoute from "@/app/api/workspaces/[academyId]/bootstrap/route";
import * as platformRoute from "@/app/api/platform/accounts/route";
import type { FinancePayload } from "@/domain/finance";
import type { ReportSummary } from "@/domain/records-query";
import {
  A,
  B,
  ids,
  callRoute,
  contextFor,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";
import {
  extended,
  extendedContext,
  seedExtendedFixture,
  type ExtendedFixture,
} from "./helpers/extended-fixture";

const filename = join(tmpdir(), `sportozen-extended-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let extra: ExtendedFixture;
let base: ReturnType<typeof seedApiFixture>;
beforeAll(() => {
  base = seedApiFixture();
  extra = seedExtendedFixture(base);
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

type Viewer = Persona | { user: string };
const as = (viewer: Viewer) =>
  typeof viewer === "string"
    ? { as: viewer }
    : { headers: { "x-test-user": viewer.user } };
const support = { user: extended.support } as const;
const platformAdmin = { user: extended.platformAdmin } as const;
const records = (viewer: Viewer, kind: string, query = "", academyId = A) =>
  callRoute(recordsRoute.GET, {
    path: `/api/workspaces/${academyId}/records/${kind}${query}`,
    params: { academyId, kind },
    ...as(viewer),
  });
const list = (response: { body: unknown }) => response.body as { id: string }[];
const audits = () =>
  Number(
    database()
      .prepare(
        "SELECT COUNT(*) AS n FROM workspace_audit WHERE academyId=? AND action='Authorised support read'",
      )
      .get(A)!.n,
  );

describe("payments and invoices", () => {
  const finance = async (viewer: Viewer, academyId = A) =>
    callRoute(financeRoute.GET, {
      path: `/api/workspaces/${academyId}/finance`,
      params: { academyId },
      ...as(viewer),
    });
  it("shows the owner every invoice and both payments", async () => {
    const body = (await finance("ownerA")).body as FinancePayload;
    expect(body.invoices).toHaveLength(3);
    expect(body.payments.map((p) => p.id).sort()).toEqual(
      [extra.payments.verified, extra.payments.pending].sort(),
    );
    const byStatus = Object.fromEntries(
      body.payments.map((p) => [p.id, p.status]),
    );
    expect(byStatus[extra.payments.verified]).toBe("VERIFIED");
    expect(byStatus[extra.payments.pending]).toBe("PENDING");
  });
  it("shows a parent only their own child's invoice and payment, without staff notes", async () => {
    const one = (await finance("parent1")).body as FinancePayload;
    expect(one.invoices.map((i) => i.playerId)).toEqual([ids.p1]);
    expect(one.payments.map((p) => p.id)).toEqual([extra.payments.verified]);
    expect(one.payments.every((p) => p.decisionNote === undefined)).toBe(true);
    const two = (await finance("parent2")).body as FinancePayload;
    expect(two.payments.map((p) => p.id)).toEqual([extra.payments.pending]);
    expect(JSON.stringify(one)).not.toContain(extra.payments.pending);
  });
  it("refuses coaches, support, platform administrators and the other academy", async () => {
    expect((await finance("coachA")).status).toBe(403);
    expect((await finance(support)).status).toBe(403);
    expect((await finance(platformAdmin)).status).toBe(403);
    expect((await finance("ownerB", A)).status).toBe(403);
    const other = (await finance("ownerB", B)).body as FinancePayload;
    expect(other.payments).toEqual([]);
    expect(other.invoices).toEqual([]);
  });
});

describe("a trial", () => {
  const trials = (viewer: Viewer, player: string, academyId = A) =>
    callRoute(trialsRoute.GET, {
      path: `/api/workspaces/${academyId}/trials?player=${player}`,
      params: { academyId },
      ...as(viewer),
    });
  it("is readable by the owner and the player's coach, and by no other academy", async () => {
    for (const viewer of ["ownerA", "coachA"] as const) {
      const response = await trials(viewer, extra.trialPlayerId);
      expect(response.status, viewer).toBe(200);
      const body = response.body as { enrolments: { id: string }[] };
      expect(body.enrolments.map((e) => e.id)).toContain(extra.trial.id);
    }
    expect((await trials("coachB", extra.trialPlayerId)).status).not.toBe(200);
    expect((await trials("ownerB", extra.trialPlayerId, A)).status).toBe(403);
    expect((await trials("ownerB", extra.trialPlayerId, B)).status).not.toBe(
      200,
    );
  });
  it("does not reach a parent who is not that child's guardian", async () => {
    const response = await trials("parent1", extra.trialPlayerId);
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(extra.trial.id);
  });
  it("makes the trial player visible in the payload and Home counts, within scope", async () => {
    const owner = await records("ownerA", "player");
    expect(list(owner).map((p) => p.id)).toContain(extra.trialPlayerId);
    const coachB = await records("coachB", "player");
    expect(list(coachB).map((p) => p.id)).not.toContain(extra.trialPlayerId);
    expect(homeSummary(contextFor("ownerA")).activePlayers).toBe(4);
    expect(homeSummary(contextFor("coachB")).activePlayers).toBe(1);
  });
});

describe("a published update and a conversation", () => {
  it("shows the published update to its guardian and the child's staff only", async () => {
    expect(list(await records("parent1", "update")).map((u) => u.id)).toEqual([
      extra.update.id,
    ]);
    for (const viewer of ["parent2", "coachB", "outsider"] as const) {
      const response = await records(viewer, "update");
      expect(
        response.status === 403 || list(response).length === 0,
        viewer,
      ).toBe(true);
    }
    expect(list(await records("coachA", "update")).map((u) => u.id)).toContain(
      extra.update.id,
    );
  });
  it("shows a conversation to its guardian and staff without internal notes for the parent", async () => {
    const parent = list(
      await records("parent1", "conversation"),
    ) as unknown as {
      messages: { internal: boolean; body: string }[];
    }[];
    expect(parent).toHaveLength(1);
    expect(parent[0].messages.every((m) => !m.internal)).toBe(true);
    expect(JSON.stringify(parent)).not.toContain(
      "SYNTHETIC INTERNAL COACH NOTE",
    );
    expect(list(await records("parent2", "conversation"))).toEqual([]);
    expect(list(await records("coachB", "conversation"))).toEqual([]);
    const staff = list(await records("coachA", "conversation"));
    expect(staff).toHaveLength(1);
    expect(JSON.stringify(staff)).toContain("SYNTHETIC INTERNAL COACH NOTE");
    expect(homeSummary(contextFor("coachA")).openConversations).toBe(1);
    expect(homeSummary(contextFor("coachB")).openConversations).toBe(0);
  });
  it("filters conversations by player and status", async () => {
    expect(
      list(
        await records(
          "ownerA",
          "conversation",
          `?player=${ids.p1}&status=OPEN`,
        ),
      ),
    ).toHaveLength(1);
    expect(
      list(await records("ownerA", "conversation", `?player=${ids.p2}`)),
    ).toEqual([]);
    expect(
      list(await records("ownerA", "conversation", "?status=CLOSED")),
    ).toEqual([]);
  });
});

describe("a weekly plan", () => {
  it("is visible to staff of that batch and withheld from parents while a draft", async () => {
    const weeklyIds = async (viewer: Viewer) =>
      list(await records(viewer, "weekly")).map((w) => w.id);
    expect(await weeklyIds("ownerA")).toContain(extra.weekly.id);
    expect(await weeklyIds("coachA")).toContain(extra.weekly.id);
    expect(await weeklyIds("coachB")).not.toContain(extra.weekly.id);
    expect(extra.weekly.issuedAt).toBeUndefined();
    expect(list(await records("parent1", "weekly"))).toEqual([]);
  });
});

describe("Platform Admin", () => {
  it("manages accounts but has no academy role: every academy read is refused", async () => {
    const accounts = await callRoute(platformRoute.GET, {
      path: "/api/platform/accounts",
      ...as(platformAdmin),
    });
    expect(accounts.status).toBe(200);
    expect((accounts.body as { id: string }[]).map((a) => a.id).sort()).toEqual(
      [A, B],
    );
    expect(
      (
        await callRoute(platformRoute.GET, {
          path: "/api/platform/accounts",
          ...as("ownerA"),
        })
      ).status,
    ).toBe(403);
    for (const handler of [
      bootstrapRoute.GET,
      homeRoute.GET,
      workspaceRoute.GET,
    ]) {
      const response = await callRoute(handler, {
        path: `/api/workspaces/${A}`,
        params: { academyId: A },
        ...as(platformAdmin),
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "No active membership in this academy.",
      });
    }
    for (const kind of ["player", "report", "update", "conversation"])
      expect((await records(platformAdmin, kind)).status).toBe(403);
  });
});

describe("authorised Support", () => {
  it("reads only the linked child's approved reports, plans and player record", async () => {
    const reports = (await records(support, "report", "?view=summary"))
      .body as ReportSummary[];
    expect(reports.map((r) => r.id)).toEqual([base.reports[ids.p1]]);
    expect(reports.every((r) => r.status === "Approved" && r.hasSnapshot)).toBe(
      true,
    );
    expect(list(await records(support, "player")).map((p) => p.id)).toEqual([
      ids.p1,
    ]);
    expect(list(await records(support, "plan"))).toHaveLength(1);
  });
  it("is given nothing private: no training records, messages, updates or fees", async () => {
    for (const kind of [
      "session",
      "attendance",
      "evidence",
      "conversation",
      "update",
      "dietary",
      "preference",
      "fee",
      "weekly",
    ]) {
      const response = await records(support, kind);
      expect(response.status === 200 && list(response).length === 0, kind).toBe(
        true,
      );
    }
    expect(
      (
        await callRoute(financeRoute.GET, {
          path: `/api/workspaces/${A}/finance`,
          params: { academyId: A },
          ...as(support),
        })
      ).status,
    ).toBe(403);
  });
  it("is refused the Home summary, may open the bootstrap, and is audited on every record read", async () => {
    const before = audits();
    expect(
      (
        await callRoute(homeRoute.GET, {
          path: "/h",
          params: { academyId: A },
          ...as(support),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await callRoute(bootstrapRoute.GET, {
          path: "/b",
          params: { academyId: A },
          ...as(support),
        })
      ).status,
    ).toBe(200);
    expect(audits()).toBe(before);
    await records(support, "report", "?view=summary");
    await records(support, "report", "?view=summary&limit=1");
    expect(audits() - before).toBe(2);
    const payload = await callRoute(workspaceRoute.GET, {
      path: `/api/workspaces/${A}?kinds=player,report`,
      params: { academyId: A },
      ...as(support),
    });
    expect(payload.status).toBe(200);
    expect(audits() - before).toBeGreaterThanOrEqual(4);
    expect(extendedContext(extended.support).membership.role).toBe("SUPPORT");
  });
});

describe("academy isolation", () => {
  it("keeps every extended entity out of the other academy's reads", async () => {
    for (const kind of [
      "update",
      "conversation",
      "weekly",
      "report",
      "player",
    ]) {
      const response = await records("ownerB", kind, "", B);
      expect(JSON.stringify(response.body), kind).not.toContain(
        extra.update.id,
      );
      expect(JSON.stringify(response.body), kind).not.toContain(
        extra.conversation.id,
      );
      expect(JSON.stringify(response.body), kind).not.toContain(
        extra.weekly.id,
      );
    }
    expect(
      list(await records("ownerB", "player", "", B)).map((p) => p.id),
    ).toEqual([ids.bPlayer]);
  });
});
