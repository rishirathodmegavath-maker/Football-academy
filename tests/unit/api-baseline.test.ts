// API baseline: status codes, error contracts, role/academy authorization and
// recorded payload sizes and SQL statement counts, against an isolated
// synthetic SQLite file. Route handlers run for real; only Better Auth's
// session lookup is replaced (tests/unit/helpers/mock-auth.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import * as workspacesRoute from "@/app/api/workspaces/route";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import * as actionsRoute from "@/app/api/workspaces/[academyId]/actions/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as financePdfRoute from "@/app/api/workspaces/[academyId]/finance/[kind]/[recordId]/pdf/route";
import * as reportPdfRoute from "@/app/api/workspaces/[academyId]/reports/[reportId]/pdf/route";
import * as trainingRoute from "@/app/api/workspaces/[academyId]/training/route";
import * as periodsRoute from "@/app/api/workspaces/[academyId]/periods/route";
import * as trialsRoute from "@/app/api/workspaces/[academyId]/trials/route";
import * as communicationRoute from "@/app/api/workspaces/[academyId]/communication/route";
import * as announcementsRoute from "@/app/api/workspaces/[academyId]/communication/announcements/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as platformRoute from "@/app/api/platform/accounts/route";
import {
  A,
  B,
  ids,
  callRoute,
  countQueries,
  seedApiFixture,
  type Fixture,
  type Persona,
} from "./helpers/api-harness";
import { warmPdfRenderer } from "./helpers/warm-pdf";

const filename = join(
  tmpdir(),
  `sportozen-api-baseline-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let fixture: Fixture;
beforeAll(() => {
  fixture = seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const SIGN_IN = "Sign in to access academy workspaces.",
  NOT_MEMBER = "No active membership in this academy.",
  NOT_VISIBLE = "Record not available in this academy and role.",
  WRONG_ROLE = "Your academy role cannot perform this action.",
  SAME_ORIGIN = "A same-origin request is required.",
  INVALID = "Check the required fields and valid record links.",
  INVALID_JSON = "Send the request details as valid JSON.";
const root = (academyId = A) => `/api/workspaces/${academyId}`;
const validPlayer = {
  name: "Synthetic New Player",
  coachId: ids.coachA,
  squadId: "",
};

describe("API baseline: status codes and error contracts", () => {
  const cases: {
    name: string;
    handler: unknown;
    path: string;
    method?: string;
    as?: Persona;
    params?: Record<string, string>;
    json?: unknown;
    rawBody?: string;
    origin?: string | null;
    status: number;
    error?: string;
  }[] = [
    {
      name: "signed-out academy payload",
      handler: workspaceRoute.GET,
      path: root(),
      params: { academyId: A },
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "account without membership",
      handler: workspaceRoute.GET,
      path: root(),
      as: "outsider",
      params: { academyId: A },
      status: 403,
      error: NOT_MEMBER,
    },
    {
      name: "owner of another academy",
      handler: workspaceRoute.GET,
      path: root(),
      as: "ownerB",
      params: { academyId: A },
      status: 403,
      error: NOT_MEMBER,
    },
    {
      name: "owner reading own academy",
      handler: workspaceRoute.GET,
      path: root(),
      as: "ownerA",
      params: { academyId: A },
      status: 200,
    },
    {
      name: "unknown record kind",
      handler: recordsRoute.GET,
      path: `${root()}/records/unknown`,
      as: "ownerA",
      params: { academyId: A, kind: "unknown" },
      status: 404,
      error: "Unknown resource.",
    },
    {
      name: "parent reading own child",
      handler: recordRoute.GET,
      path: `${root()}/records/player/${ids.p1}`,
      as: "parent1",
      params: { academyId: A, kind: "player", recordId: ids.p1 },
      status: 200,
    },
    {
      name: "parent reading another family's child",
      handler: recordRoute.GET,
      path: `${root()}/records/player/${ids.p2}`,
      as: "parent1",
      params: { academyId: A, kind: "player", recordId: ids.p2 },
      status: 404,
      error: NOT_VISIBLE,
    },
    {
      name: "coach reading own player",
      handler: recordRoute.GET,
      path: `${root()}/records/player/${ids.p1}`,
      as: "coachA",
      params: { academyId: A, kind: "player", recordId: ids.p1 },
      status: 200,
    },
    {
      name: "coach reading another coach's player",
      handler: recordRoute.GET,
      path: `${root()}/records/player/${ids.p3}`,
      as: "coachA",
      params: { academyId: A, kind: "player", recordId: ids.p3 },
      status: 404,
      error: NOT_VISIBLE,
    },
    {
      name: "another academy's record id under this academy",
      handler: recordRoute.GET,
      path: `${root()}/records/player/${ids.bPlayer}`,
      as: "ownerA",
      params: { academyId: A, kind: "player", recordId: ids.bPlayer },
      status: 404,
      error: NOT_VISIBLE,
    },
    {
      name: "parent creating a player",
      handler: recordsRoute.POST,
      path: `${root()}/records/player`,
      method: "POST",
      as: "parent1",
      params: { academyId: A, kind: "player" },
      json: validPlayer,
      status: 403,
      error: WRONG_ROLE,
    },
    {
      name: "write without an Origin header",
      handler: recordsRoute.POST,
      path: `${root()}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      json: validPlayer,
      origin: null,
      status: 403,
      error: SAME_ORIGIN,
    },
    {
      name: "write from another origin",
      handler: recordsRoute.POST,
      path: `${root()}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      json: validPlayer,
      origin: "https://attacker.example",
      status: 403,
      error: SAME_ORIGIN,
    },
    {
      name: "invalid player payload",
      handler: recordsRoute.POST,
      path: `${root()}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      json: { name: "x" },
      status: 400,
      error: INVALID,
    },
    // DEF-01: was 500 ("The request could not be completed.") before readJson.
    {
      name: "malformed JSON body",
      handler: recordsRoute.POST,
      path: `${root()}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      rawBody: "{",
      status: 400,
      error: INVALID_JSON,
    },
    {
      name: "conversation PUT is refused",
      handler: recordRoute.PUT,
      path: `${root()}/records/conversation/c1`,
      method: "PUT",
      as: "ownerA",
      params: { academyId: A, kind: "conversation", recordId: "c1" },
      json: {},
      status: 405,
      error:
        "Use conversation actions to preserve private notes and thread history.",
    },
    {
      name: "coach preparing an invitation",
      handler: actionsRoute.POST,
      path: `${root()}/actions`,
      method: "POST",
      as: "coachA",
      params: { academyId: A },
      json: {
        action: "invite",
        data: { email: "x@example.test", role: "COACH", playerIds: [] },
      },
      status: 403,
      error: WRONG_ROLE,
    },
    {
      name: "unknown action",
      handler: actionsRoute.POST,
      path: `${root()}/actions`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
      json: { action: "nothing", id: "x" },
      status: 400,
      error: "Unknown action.",
    },
    {
      name: "coach reading finance",
      handler: financeRoute.GET,
      path: `${root()}/finance`,
      as: "coachA",
      params: { academyId: A },
      status: 403,
      error: WRONG_ROLE,
    },
    {
      name: "parent reading finance",
      handler: financeRoute.GET,
      path: `${root()}/finance`,
      as: "parent1",
      params: { academyId: A },
      status: 200,
    },
    {
      name: "parent reading another family's report PDF",
      handler: reportPdfRoute.GET,
      path: `${root()}/reports/x/pdf`,
      as: "parent2",
      params: { academyId: A, reportId: "REPORT:p1" },
      status: 404,
      error: NOT_VISIBLE,
    },
    {
      name: "signed-out training command",
      handler: trainingRoute.POST,
      path: `${root()}/training`,
      method: "POST",
      params: { academyId: A },
      json: {},
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "signed-out period command",
      handler: periodsRoute.POST,
      path: `${root()}/periods`,
      method: "POST",
      params: { academyId: A },
      json: {},
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "signed-out trials",
      handler: trialsRoute.GET,
      path: `${root()}/trials`,
      params: { academyId: A },
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "signed-out communication",
      handler: communicationRoute.GET,
      path: `${root()}/communication`,
      params: { academyId: A },
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "signed-out announcements",
      handler: announcementsRoute.GET,
      path: `${root()}/communication/announcements`,
      params: { academyId: A },
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "invitation token of the wrong shape",
      handler: acceptRoute.POST,
      path: "/api/invitations/accept",
      method: "POST",
      as: "outsider",
      json: { token: "short" },
      status: 400,
      error: INVALID,
    },
    {
      name: "academy owner at platform administration",
      handler: platformRoute.GET,
      path: "/api/platform/accounts",
      as: "ownerA",
      status: 403,
      error: "Platform administration is not an academy role.",
    },
    {
      name: "signed-out academy list",
      handler: workspacesRoute.GET,
      path: "/api/workspaces",
      status: 401,
      error: SIGN_IN,
    },
    // DEF-01: both returned 500 before; they now authenticate before reading.
    {
      name: "signed-out academy creation with malformed JSON",
      handler: workspacesRoute.POST,
      path: "/api/workspaces",
      method: "POST",
      rawBody: "{",
      status: 401,
      error: SIGN_IN,
    },
    {
      name: "signed-out invitation acceptance with malformed JSON",
      handler: acceptRoute.POST,
      path: "/api/invitations/accept",
      method: "POST",
      rawBody: "{",
      status: 401,
      error: SIGN_IN,
    },
  ];
  it.each(cases)("$name → $status", async (c) => {
    const params = { ...c.params };
    if (params.reportId === "REPORT:p1")
      params.reportId = fixture.reports[ids.p1];
    const response = await callRoute(c.handler, { ...c, params });
    expect(response.status).toBe(c.status);
    if (c.error) expect(response.body).toEqual({ error: c.error });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
});

const KINDS = [
  "player",
  "session",
  "attendance",
  "evidence",
  "report",
  "plan",
  "squad",
  "venue",
  "branch",
  "drill",
] as const;
async function payload(as: Persona, academyId = A) {
  const response = await callRoute(workspaceRoute.GET, {
    path: root(academyId),
    as,
    params: { academyId },
  });
  expect(response.status).toBe(200);
  const body = response.body as {
    records: Record<string, { id: string }[]>;
    [key: string]: unknown;
  };
  return {
    response,
    body,
    counts: Object.fromEntries(
      KINDS.map((kind) => [kind, body.records[kind].length]),
    ),
  };
}

describe("API baseline: role and academy authorization", () => {
  beforeAll(warmPdfRenderer, 30_000);
  it("returns each role exactly its permitted records", async () => {
    expect((await payload("ownerA")).counts).toEqual({
      player: 3,
      session: 8,
      attendance: 12,
      evidence: 12,
      report: 3,
      plan: 3,
      squad: 2,
      venue: 1,
      branch: 1,
      drill: 1,
    });
    expect((await payload("coachA")).counts).toEqual({
      player: 2,
      session: 4,
      attendance: 8,
      evidence: 8,
      report: 2,
      plan: 2,
      squad: 1,
      venue: 1,
      branch: 1,
      drill: 1,
    });
    expect((await payload("coachB")).counts).toEqual({
      player: 1,
      session: 4,
      attendance: 4,
      evidence: 4,
      report: 1,
      plan: 1,
      squad: 1,
      venue: 1,
      branch: 1,
      drill: 1,
    });
    expect((await payload("parent1")).counts).toEqual({
      player: 1,
      session: 0,
      attendance: 0,
      evidence: 0,
      report: 1,
      plan: 1,
      squad: 0,
      venue: 0,
      branch: 0,
      drill: 0,
    });
  });
  it("keeps the payload's top-level contract per role", async () => {
    const keys = async (as: Persona) =>
      Object.keys((await payload(as)).body).sort();
    expect(await keys("ownerA")).toEqual([
      "academy",
      "guardians",
      "members",
      "membership",
      "monthlyReportReview",
      "records",
      "subscription",
      "viewer",
    ]);
    expect(await keys("coachA")).toEqual([
      "academy",
      "guardians",
      "members",
      "membership",
      "monthlyReportReview",
      "records",
      "viewer",
    ]);
    // `parentClosures` is new with P1-08: closed days as families may read
    // them (dates, scope and the family note only).
    expect(await keys("parent1")).toEqual([
      "academy",
      "members",
      "membership",
      "parentClosures",
      "parentSchedule",
      "records",
      "viewer",
    ]);
  });
  it("never shows a parent another family's child or staff-only notes", async () => {
    const { body, response } = await payload("parent1");
    const text = JSON.stringify(body);
    expect(body.records.player.map((p) => p.id)).toEqual([ids.p1]);
    expect(text).not.toContain("Synthetic Kabir Two");
    expect(text).not.toContain("Synthetic Meera Three");
    expect(text).not.toContain("SYNTHETIC STAFF-ONLY NOTE");
    expect(response.bytes).toBeGreaterThan(0);
  });
  it("never shows a coach another coach's players", async () => {
    const { body } = await payload("coachA");
    expect(body.records.player.map((p) => p.id).sort()).toEqual([
      ids.p1,
      ids.p2,
    ]);
    expect(JSON.stringify(body)).not.toContain("Synthetic Meera Three");
  });
  it("keeps academies isolated from each other", async () => {
    const { body } = await payload("ownerB", B);
    expect(body.records.player.map((p) => p.id)).toEqual([ids.bPlayer]);
    expect(JSON.stringify(body)).not.toContain("Synthetic Academy A");
    const finance = await callRoute(financeRoute.GET, {
      path: `${root(B)}/finance`,
      as: "ownerB",
      params: { academyId: B },
    });
    expect((finance.body as { invoices: unknown[] }).invoices).toEqual([]);
    const crossInvoice = await callRoute(financePdfRoute.GET, {
      path: `${root(B)}/finance/invoice/x/pdf`,
      as: "ownerB",
      params: {
        academyId: B,
        kind: "invoice",
        recordId: fixture.invoices[ids.p1],
      },
    });
    expect(crossInvoice.status).toBe(404);
  });
  it("limits a parent's finance view and invoice PDFs to their own child", async () => {
    const finance = await callRoute(financeRoute.GET, {
      path: `${root()}/finance`,
      as: "parent1",
      params: { academyId: A },
    });
    const invoices = (finance.body as { invoices: { playerId: string }[] })
      .invoices;
    expect(invoices.map((invoice) => invoice.playerId)).toEqual([ids.p1]);
    const other = await callRoute(financePdfRoute.GET, {
      path: `${root()}/finance/invoice/x/pdf`,
      as: "parent1",
      params: {
        academyId: A,
        kind: "invoice",
        recordId: fixture.invoices[ids.p2],
      },
    });
    expect(other.status).toBe(404);
    const own = await callRoute(financePdfRoute.GET, {
      path: `${root()}/finance/invoice/x/pdf`,
      as: "parent1",
      params: {
        academyId: A,
        kind: "invoice",
        recordId: fixture.invoices[ids.p1],
      },
    });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toContain("application/pdf");
    // A download, never rendered in the page; private; named from a server-made id.
    expect(own.headers.get("content-disposition")).toMatch(
      /^attachment; filename="invoice-[0-9a-f-]{36}\.pdf"$/,
    );
    expect(own.headers.get("cache-control")).toBe("no-store, private");
  });
});

describe("API baseline: recorded payload sizes and SQL statement counts", () => {
  it("records the read baseline for each role", async () => {
    const rows: Record<string, unknown>[] = [];
    const measure = async (
      label: string,
      run: () => Promise<{ bytes: number; status: number }>,
    ) => {
      const { result, queries } = await countQueries(run);
      expect(result.status).toBe(200);
      expect(queries).toBeGreaterThan(0);
      rows.push({
        request: label,
        status: result.status,
        bytes: result.bytes,
        queries,
      });
    };
    for (const as of ["ownerA", "coachA", "coachB", "parent1"] as const)
      await measure(`${as} GET workspace`, () =>
        callRoute(workspaceRoute.GET, {
          path: root(),
          as,
          params: { academyId: A },
        }),
      );
    for (const as of ["ownerA", "parent1"] as const)
      await measure(`${as} GET finance`, () =>
        callRoute(financeRoute.GET, {
          path: `${root()}/finance`,
          as,
          params: { academyId: A },
        }),
      );
    for (const as of ["ownerA", "coachA"] as const)
      await measure(`${as} GET records/attendance`, () =>
        callRoute(recordsRoute.GET, {
          path: `${root()}/records/attendance`,
          as,
          params: { academyId: A, kind: "attendance" },
        }),
      );
    await measure("coachA GET records/player/:id", () =>
      callRoute(recordRoute.GET, {
        path: `${root()}/records/player/${ids.p1}`,
        as: "coachA",
        params: { academyId: A, kind: "player", recordId: ids.p1 },
      }),
    );
    mkdirSync("test-results", { recursive: true });
    writeFileSync(
      "test-results/api-baseline.json",
      JSON.stringify(
        {
          fixture: {
            players: 3,
            sessions: fixture.sessions.length,
            attendance: fixture.attendance,
            evidence: fixture.evidence,
            reports: 3,
            invoices: 3,
          },
          rows,
        },
        null,
        2,
      ),
    );
    console.table(rows);
  });
});
