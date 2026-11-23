// WP2.2: large GET JSON responses are gzip-compressed when the client accepts
// gzip. The decoded body, status, content type and cache headers must be
// identical to the uncompressed response, for every role, and errors and small
// responses must be untouched.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import {
  MIN_COMPRESSED_JSON_BYTES,
  compressibleJson,
  privateJson,
} from "@/server/http";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import * as financeRoute from "@/app/api/workspaces/[academyId]/finance/route";
import * as homeRoute from "@/app/api/workspaces/[academyId]/home/route";
import {
  A,
  callRoute,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-compression-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

type CallOptions = {
  name: string;
  handler: unknown;
  path: string;
  params: Record<string, string>;
  as: Persona;
};
const asking = (acceptEncoding?: string) =>
  new Request("http://127.0.0.1:3000/x", {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
  });
const big = {
  rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "abc" })),
};
const small = { ok: true };

describe("compressibleJson", () => {
  it("compresses a large body for a client that accepts gzip", async () => {
    const response = compressibleJson(asking("gzip, deflate, br"), big);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
    const wire = Buffer.from(await response.arrayBuffer());
    expect(JSON.parse(gunzipSync(wire).toString("utf8"))).toEqual(big);
    expect(wire.byteLength).toBeLessThan(JSON.stringify(big).length / 5);
  });
  it("sends the same bytes uncompressed when gzip is not accepted", async () => {
    for (const header of [undefined, "identity", "br", "gzip;q=0", "deflate"]) {
      const response = compressibleJson(asking(header), big);
      expect(
        response.headers.get("content-encoding"),
        String(header),
      ).toBeNull();
      expect(await response.json()).toEqual(big);
    }
  });
  it("honours quality values and wildcards", () => {
    const encoded = (header: string) =>
      compressibleJson(asking(header), big).headers.get("content-encoding");
    expect(encoded("gzip;q=0.5")).toBe("gzip");
    expect(encoded("*")).toBe("gzip");
    expect(encoded("*;q=0")).toBeNull();
    expect(encoded("gzip;q=0, *")).toBeNull();
    expect(encoded("GZIP")).toBe("gzip");
  });
  it("leaves small bodies uncompressed", async () => {
    expect(JSON.stringify(small).length).toBeLessThan(
      MIN_COMPRESSED_JSON_BYTES,
    );
    const response = compressibleJson(asking("gzip"), small);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual(small);
  });
  it("keeps the status code and matches privateJson's headers otherwise", () => {
    const plain = privateJson(big, 201),
      packed = compressibleJson(asking("gzip"), big, 201);
    expect(packed.status).toBe(201);
    for (const name of ["content-type", "cache-control"])
      expect(packed.headers.get(name)).toBe(plain.headers.get(name));
  });
});

describe("compressed API responses decode to the uncompressed responses", () => {
  const roles: Persona[] = ["ownerA", "coachA", "parent1"];
  const calls = (as: Persona): CallOptions[] => [
    {
      name: "academy payload",
      handler: workspaceRoute.GET,
      path: `/api/workspaces/${A}`,
      params: { academyId: A },
      as,
    },
    {
      name: "player records",
      handler: recordsRoute.GET,
      path: `/api/workspaces/${A}/records/report`,
      params: { academyId: A, kind: "report" },
      as,
    },
    {
      name: "finance",
      handler: financeRoute.GET,
      path: `/api/workspaces/${A}/finance`,
      params: { academyId: A },
      as,
    },
  ];
  it.each(roles)("%s", async (persona) => {
    for (const call of calls(persona)) {
      const plain = await callRoute(call.handler, call),
        packed = await callRoute(call.handler, {
          ...call,
          headers: { "accept-encoding": "gzip" },
        });
      expect(packed.status, call.name).toBe(plain.status);
      expect(packed.body, call.name).toEqual(plain.body);
      expect(packed.bytes, call.name).toBe(plain.bytes);
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(packed.headers.get("cache-control")).toBe("no-store, private");
      // Errors (a coach asking for finance) use privateJson and are never encoded.
      if (plain.status !== 200) {
        expect(packed.headers.get("content-encoding"), call.name).toBeNull();
        continue;
      }
      expect(packed.headers.get("vary")).toContain("Accept-Encoding");
      if (plain.bytes >= MIN_COMPRESSED_JSON_BYTES) {
        expect(packed.headers.get("content-encoding"), call.name).toBe("gzip");
        expect(packed.wireBytes, call.name).toBeLessThan(plain.wireBytes);
      }
    }
  });
  it("shrinks the academy payload by far more than 4x on the fixture", async () => {
    const options = {
      path: `/api/workspaces/${A}`,
      params: { academyId: A },
      as: "ownerA" as const,
    };
    const plain = await callRoute(workspaceRoute.GET, options),
      packed = await callRoute(workspaceRoute.GET, {
        ...options,
        headers: { "accept-encoding": "gzip" },
      });
    expect(packed.wireBytes).toBeLessThan(plain.wireBytes / 4);
  });
  it("leaves errors and the small Home summary alone", async () => {
    const gzip = { "accept-encoding": "gzip" };
    const denied = await callRoute(workspaceRoute.GET, {
      path: `/api/workspaces/${A}`,
      params: { academyId: A },
      headers: gzip,
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-encoding")).toBeNull();
    expect(denied.body).toEqual({
      error: "Sign in to access academy workspaces.",
    });
    const forbidden = await callRoute(workspaceRoute.GET, {
      path: `/api/workspaces/${A}`,
      params: { academyId: A },
      as: "outsider",
      headers: gzip,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("content-encoding")).toBeNull();
    const home = await callRoute(homeRoute.GET, {
      path: `/api/workspaces/${A}/home`,
      params: { academyId: A },
      as: "ownerA",
      headers: gzip,
    });
    expect(home.status).toBe(200);
    expect((home.body as { academyId: string }).academyId).toBe(A);
  });
});
