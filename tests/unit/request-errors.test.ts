// Request parsing and error classification (DEF-01): malformed or oversized
// client bodies are 4xx, invalid input stays 400, and failures caused by stored
// data or code stay 500, are logged with a reference and are never relabelled
// as client mistakes.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { migrateIntegrityGuards } from "@/server/migrations/008-integrity-guards";
import { readJson, MAX_JSON_BODY_BYTES } from "@/server/http";
import { WorkspaceError } from "./helpers/mock-auth";
import * as workspacesRoute from "@/app/api/workspaces/route";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as recordRoute from "@/app/api/workspaces/[academyId]/records/[kind]/[recordId]/route";
import * as actionsRoute from "@/app/api/workspaces/[academyId]/actions/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as trainingRoute from "@/app/api/workspaces/[academyId]/training/route";
import * as periodsRoute from "@/app/api/workspaces/[academyId]/periods/route";
import * as trialsRoute from "@/app/api/workspaces/[academyId]/trials/route";
import * as communicationRoute from "@/app/api/workspaces/[academyId]/communication/route";
import * as announcementsRoute from "@/app/api/workspaces/[academyId]/communication/announcements/route";
import * as placesRoute from "@/app/api/workspaces/[academyId]/places/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as platformRoute from "@/app/api/platform/accounts/route";
import {
  A,
  B,
  ids,
  callRoute,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-request-errors-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
  database()
    .prepare("INSERT INTO platform_administrators(userId) VALUES(?)")
    .run(ids.outsider);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const INVALID_JSON = "Send the request details as valid JSON.",
  TOO_LARGE = "The request is too large to process.",
  INVALID = "Check the required fields and valid record links.",
  INTERNAL = "The request could not be completed.",
  SIGN_IN = "Sign in to access academy workspaces.";
const root = `/api/workspaces/${A}`;

describe("readJson", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:3000/x", {
      method: "POST",
      body,
      headers,
      duplex: "half",
    } as RequestInit);
  const refusal = async (request: Request, limit?: number) => {
    const error = await readJson(request, limit).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    return {
      status: (error as WorkspaceError).status,
      message: (error as WorkspaceError).message,
    };
  };
  it("parses a valid JSON body, including non-object JSON", async () => {
    expect(await readJson(post('{"a":[1,"₹"]}'))).toEqual({ a: [1, "₹"] });
    expect(await readJson(post("null"))).toBeNull();
  });
  it("accepts a leading UTF-8 byte-order mark, as Request.json() does", async () => {
    const body = '﻿{"a":[1,"₹"]}';
    expect(await readJson(post(body))).toEqual(await post(body).json());
    expect(await readJson(post(body))).toEqual({ a: [1, "₹"] });
    // The mark alone is still an empty body.
    expect(await refusal(post("﻿"))).toEqual({
      status: 400,
      message: INVALID_JSON,
    });
  });
  it("refuses malformed, truncated and empty bodies as client errors", async () => {
    for (const body of ["{", '{"a":', "not json", "", null])
      expect(await refusal(post(body))).toEqual({
        status: 400,
        message: INVALID_JSON,
      });
  });
  it("refuses a declared length over the limit without reading the body", async () => {
    const request = post("{}", {
      "content-length": String(MAX_JSON_BODY_BYTES + 1),
    });
    expect(await refusal(request)).toEqual({ status: 413, message: TOO_LARGE });
    expect(request.bodyUsed).toBe(false);
  });
  it("stops reading a streamed body once it passes the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        if (pulled > 50) controller.close();
      },
    });
    expect(await refusal(post(stream), 4 * 1024)).toEqual({
      status: 413,
      message: TOO_LARGE,
    });
    expect(pulled).toBeLessThan(10);
  });
  it("accepts a body exactly at the limit", async () => {
    const body = JSON.stringify("x".repeat(100 - 2));
    expect(body.length).toBe(100);
    expect(await readJson(post(body), 100)).toBe("x".repeat(98));
  });
});

describe("routes answer malformed JSON with 400, not 500", () => {
  const routes: {
    name: string;
    handler: unknown;
    path: string;
    method: string;
    as: Persona;
    params?: Record<string, string>;
  }[] = [
    {
      name: "academy settings",
      handler: workspaceRoute.PATCH,
      path: root,
      method: "PATCH",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "record create",
      handler: recordsRoute.POST,
      path: `${root}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
    },
    {
      name: "record update",
      handler: recordRoute.PUT,
      path: `${root}/records/player/${ids.p1}`,
      method: "PUT",
      as: "ownerA",
      params: { academyId: A, kind: "player", recordId: ids.p1 },
    },
    {
      name: "actions",
      handler: actionsRoute.POST,
      path: `${root}/actions`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "finance",
      handler: financeRoute.POST,
      path: `${root}/finance`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "training",
      handler: trainingRoute.POST,
      path: `${root}/training`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "periods",
      handler: periodsRoute.POST,
      path: `${root}/periods`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "trials",
      handler: trialsRoute.POST,
      path: `${root}/trials`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "communication",
      handler: communicationRoute.POST,
      path: `${root}/communication`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "announcements",
      handler: announcementsRoute.POST,
      path: `${root}/communication/announcements`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "places",
      handler: placesRoute.POST,
      path: `${root}/places`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A },
    },
    {
      name: "academy creation",
      handler: workspacesRoute.POST,
      path: "/api/workspaces",
      method: "POST",
      as: "ownerA",
    },
    {
      name: "invitation acceptance",
      handler: acceptRoute.POST,
      path: "/api/invitations/accept",
      method: "POST",
      as: "outsider",
    },
    {
      name: "platform account change",
      handler: platformRoute.PATCH,
      path: "/api/platform/accounts",
      method: "PATCH",
      as: "outsider",
    },
  ];
  it.each(routes)("$name", async (route) => {
    const errors = vi.spyOn(console, "error");
    for (const rawBody of ["{", ""]) {
      const response = await callRoute(route.handler, { ...route, rawBody });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: INVALID_JSON });
    }
    expect(errors).not.toHaveBeenCalled();
  });
  it("answers an oversized body with 413", async () => {
    const response = await callRoute(recordsRoute.POST, {
      path: `${root}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      rawBody: JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: TOO_LARGE });
  });
  it("parses a BOM-prefixed body and reaches the route's own validation", async () => {
    const response = await callRoute(acceptRoute.POST, {
      path: "/api/invitations/accept",
      method: "POST",
      as: "outsider",
      rawBody: '﻿{"token":"short"}',
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: INVALID });
  });
  it("authenticates before reading the body on the three routes that used to read first", async () => {
    for (const [handler, path] of [
      [workspacesRoute.POST, "/api/workspaces"],
      [acceptRoute.POST, "/api/invitations/accept"],
      [platformRoute.PATCH, "/api/platform/accounts"],
    ] as const) {
      const response = await callRoute(handler, {
        path,
        method: path.includes("platform") ? "PATCH" : "POST",
        rawBody: "{",
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: SIGN_IN });
    }
    const notAdmin = await callRoute(platformRoute.PATCH, {
      path: "/api/platform/accounts",
      method: "PATCH",
      as: "ownerA",
      rawBody: "{",
    });
    expect(notAdmin.status).toBe(403);
  });
});

describe("validation errors stay distinct from internal errors", () => {
  it("keeps invalid input at 400 with the existing message", async () => {
    const response = await callRoute(recordsRoute.POST, {
      path: `${root}/records/player`,
      method: "POST",
      as: "ownerA",
      params: { academyId: A, kind: "player" },
      json: { name: "x" },
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: INVALID });
  });
  it("reports a corrupted stored record as an internal error, logged with a reference", async () => {
    const db = database();
    const original = db
      .prepare(
        "SELECT body FROM workspace_records WHERE academyId=? AND kind='player' AND id=?",
      )
      .get(A, ids.p3)!.body;
    // This simulates corruption that predates the write guard, which now
    // refuses malformed bodies. Drop the guard for this test and restore it.
    db.exec("DROP TRIGGER workspace_records_owner_update");
    db.prepare(
      "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
    ).run("{corrupted", A, ids.p3);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await callRoute(recordsRoute.GET, {
        path: `${root}/records/player`,
        as: "ownerA",
        params: { academyId: A, kind: "player" },
      });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: INTERNAL });
      const reference = response.headers.get("x-error-reference");
      expect(reference).toMatch(/^[0-9a-f]{8}$/);
      expect(errors).toHaveBeenCalledTimes(1);
      // One structured line: event, the reference the caller was given, the route.
      expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({
        level: "error",
        event: "request.failed",
        reference,
        route: `GET ${root}/records/player`,
        errorName: "SyntaxError",
        stack: expect.stringContaining("SyntaxError"),
      });
    } finally {
      db.prepare(
        "UPDATE workspace_records SET body=? WHERE academyId=? AND kind='player' AND id=?",
      ).run(original, A, ids.p3);
      migrateIntegrityGuards(db);
    }
  });
  it("reports an invalid stored academy setting as internal, but a bad submitted one as 400", async () => {
    const db = database();
    const stored = db
      .prepare("SELECT config FROM academy_workspaces WHERE id=?")
      .get(B)!.config as string;
    const settings = (body: unknown) =>
      callRoute(workspaceRoute.PATCH, {
        path: `/api/workspaces/${B}`,
        method: "PATCH",
        as: "ownerB",
        params: { academyId: B },
        json: body,
      });
    expect(
      (await settings({ expectedVersion: 0, contactEmail: "not an email" }))
        .status,
    ).toBe(400);
    db.prepare("UPDATE academy_workspaces SET config=? WHERE id=?").run(
      JSON.stringify({
        ...JSON.parse(stored),
        contactEmail: "corrupted stored value",
      }),
      B,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await settings({
        expectedVersion: 0,
        name: "Synthetic Academy B renamed",
      });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: INTERNAL });
      expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({
        errorMessage: "Stored academy configuration failed validation.",
      });
      // Correcting the stored field in the same request is the client's own input.
      expect(
        (
          await settings({
            expectedVersion: 0,
            contactEmail: "fixed@example.test",
          })
        ).status,
      ).toBe(200);
    } finally {
      db.prepare("UPDATE academy_workspaces SET config=? WHERE id=?").run(
        stored,
        B,
      );
    }
  });
  it("does not relabel an unexpected code failure as a client error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new TypeError("synthetic code failure");
    const response = await callRoute(
      async (request: Request) => {
        const { apiError } = await import("@/server/http");
        return apiError(failure, request);
      },
      { path: `${root}/anything`, as: "ownerA" },
    );
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: INTERNAL });
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({
      errorName: "TypeError",
      errorMessage: "synthetic code failure",
    });
  });
});
