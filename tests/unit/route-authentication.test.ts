// WP7: every API route refuses an anonymous caller, found by calling the real
// handlers rather than by reading them. Routes that are deliberately open are
// listed with the reason; a new unauthenticated route fails this test until it
// is reviewed and added.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { callRoute } from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-routeauth-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const OPEN: Record<string, string> = {
  "auth/[...all]":
    "Better Auth's own handler: sign-up, sign-in and the rest are its endpoints, limited and checked there (auth-lifecycle.test.ts)",
  health: "liveness probe: answers 200 and nothing else",
  ready: "readiness probe: database and migration state, no data",
  "csp-report":
    "browser-posted violation reports: size- and rate-limited, logs only allow-listed fields (csp-report.ts)",
  "whatsapp/[academyId]":
    "provider webhook: authenticated by its HMAC signature (whatsapp-webhooks.ts)",
  "invitations/confirm-email":
    "invitation page, before sign-in: authenticated by the single-use 256-bit invitation token in the body (a wrong or used token changes nothing); the only effect is confirming the address that token was issued for",
  "calendar/[token]":
    "a person's private calendar subscription: the unguessable 256-bit secret in the path is the whole credential (only its hash is stored); a wrong or replaced secret answers 404 and writes nothing; the feed follows the person's own visibility, membership and the academy's operational state (calendar-sharing.test.ts)",
  "email/webhooks/[provider]":
    "provider webhook: authenticated by HTTP Basic credentials compared in constant time, and closed (404) until they are configured; tested in email-global.test.ts",
};
const modules = import.meta.glob("../../src/app/api/**/route.ts");
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
const routes = Object.entries(modules).map(([file, load]) => {
  const name = file
    .replace(/^.*\/src\/app\/api\//, "")
    .replace(/\/route\.ts$/, "");
  const params: Record<string, string> = {};
  const path =
    "/api/" +
    name.replace(/\[([^\]]+)\]/g, (_, key: string) => {
      params[key] =
        key === "academyId" ? "academy-a" : key === "kind" ? "player" : "x";
      return params[key];
    });
  return { name, path, params, load };
});

describe("API routes", () => {
  it("are all found", () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
    for (const open of Object.keys(OPEN))
      expect(
        routes.map((r) => r.name),
        open,
      ).toContain(open);
  });
  for (const route of routes.filter((r) => !(r.name in OPEN)))
    it(`/api/${route.name} refuses an anonymous caller on every method it exports`, async () => {
      const handlers = (await route.load()) as Record<string, unknown>;
      const methods = METHODS.filter((m) => typeof handlers[m] === "function");
      expect(methods.length, "exports no handler").toBeGreaterThan(0);
      for (const method of methods) {
        const res = await callRoute(handlers[method], {
          // A well-formed request, so the refusal is the authentication one.
          path: route.path + (method === "GET" ? "?player=x" : ""),
          method,
          params: route.params,
          json: method === "GET" ? undefined : {},
        });
        expect(res.status, `${method} ${route.path}`).toBe(401);
        // Nothing but the refusal itself is returned.
        expect(Object.keys(res.body as object)).toEqual(["error"]);
      }
    });
  it("the open routes are probed anonymously and give away nothing", async () => {
    const load = async (name: string) =>
      (await routes.find((r) => r.name === name)!.load()) as Record<
        string,
        unknown
      >;
    const health = await callRoute((await load("health")).GET, {
      path: "/api/health",
    });
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });
    const ready = await callRoute((await load("ready")).GET, {
      path: "/api/ready",
    });
    expect([200, 503]).toContain(ready.status);
    expect(Object.keys(ready.body as object).sort()).toEqual([
      "checks",
      "ready",
    ]);
    expect(
      Object.values(
        (ready.body as { checks: Record<string, string> }).checks,
      ).every((v) => ["ok", "failed", "draining"].includes(v)),
    ).toBe(true);
    const report = await callRoute((await load("csp-report")).POST, {
      path: "/api/csp-report",
      method: "POST",
      rawBody: "not a report",
      origin: null,
    });
    expect(report.status).toBe(204);
    // The webhook refuses an unsigned or wrongly signed delivery, and an oversized one.
    const hook = (await load("whatsapp/[academyId]")).POST;
    const unsigned = await callRoute(hook, {
      path: "/api/whatsapp/academy-a",
      method: "POST",
      params: { academyId: "academy-a" },
      rawBody: "{}",
      origin: null,
    });
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
    expect(unsigned.status).toBeLessThan(500);
    const wrong = await callRoute(hook, {
      path: "/api/whatsapp/academy-a",
      method: "POST",
      params: { academyId: "academy-a" },
      rawBody: "{}",
      origin: null,
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    const huge = await callRoute(hook, {
      path: "/api/whatsapp/academy-a",
      method: "POST",
      params: { academyId: "academy-a" },
      rawBody: "x".repeat(1024 * 1024 + 1),
      origin: null,
    });
    expect(huge.status).toBe(413);
    // The invitation page's confirm step: a made-up or malformed token does nothing.
    const confirm = (await load("invitations/confirm-email")).POST;
    const unknown = await callRoute(confirm, {
      path: "/api/invitations/confirm-email",
      method: "POST",
      json: { token: "0".repeat(64) },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ confirmed: false });
    const malformed = await callRoute(confirm, {
      path: "/api/invitations/confirm-email",
      method: "POST",
      json: { token: "short" },
    });
    expect(malformed.status).toBe(400);
    // A calendar link that is made up, malformed or traversing answers 404 and nothing else.
    const feed = (await load("calendar/[token]")).GET;
    for (const token of ["x".repeat(43) + ".ics", "short", "..%2F..%2Fetc"]) {
      const miss = await callRoute(feed, {
        path: `/api/calendar/${token}`,
        params: { token },
      });
      expect(miss.status, token).toBe(404);
    }
  });
  it("lists exactly the reviewed open routes", () => {
    // A new route that is not authenticated must be added to OPEN with a reason
    // (and probed above); a new authenticated one is covered by the loop.
    expect(
      routes
        .filter((r) => r.name in OPEN)
        .map((r) => r.name)
        .sort(),
    ).toEqual(
      [
        "auth/[...all]",
        "calendar/[token]",
        "csp-report",
        "email/webhooks/[provider]",
        "health",
        "invitations/confirm-email",
        "ready",
        "whatsapp/[academyId]",
      ].sort(),
    );
  });
});
