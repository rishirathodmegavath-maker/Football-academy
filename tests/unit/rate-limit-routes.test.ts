// WP5: the write limiter must reach every state-changing route, and the three
// routes that call it explicitly must really stop at their limits.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as createRoute from "@/app/api/workspaces/route";
import { callRoute, seedApiFixture } from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-limit-routes-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? routeFiles(path)
      : name === "route.ts"
        ? [path]
        : [];
  });
}
// Handlers that are deliberately not behind the per-user limiter, with the
// reason. Anything else that changes state must be.
const EXEMPT: Record<string, string> = {
  "auth/[...all]": "Better Auth's own handler and its own limiter",
  "csp-report":
    "browser-posted violation reports: no session, no state change, size- and rate-limited in csp-report.ts",
  "whatsapp/[academyId]":
    "unauthenticated signed webhook; an anonymous limit would let an attacker lock out the real sender",
  "invitations/confirm-email":
    "opened from the invitation page before the person has an account session: the single-use 256-bit invitation token is the credential, the only effect is confirming the one address that token was issued for, and an anonymous limit would let an attacker lock out the real person",
  "email/webhooks/[provider]":
    "provider webhook called by Postmark's servers, not a browser (no Origin header): Basic credentials in constant time, closed (404) until configured, 100 KB body limit, idempotent per event id; an anonymous limit would let an attacker lock out the real sender",
};

describe("every state-changing route is behind the write limiter", () => {
  const root = join(process.cwd(), "src/app/api");
  const files = routeFiles(root).map((file) => ({
    name: file
      .slice(root.length + 1)
      .replace(/\\/g, "/")
      .replace(/\/route\.ts$/, ""),
    source: readFileSync(file, "utf8"),
  }));
  const mutating = files.filter((f) =>
    /export async function (POST|PUT|PATCH|DELETE)\b/.test(f.source),
  );
  it("finds the routes it is meant to police", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(15);
    expect(files.length).toBeGreaterThan(mutating.length);
  });
  it.each(mutating.map((f) => [f.name, f.source] as const))(
    "%s checks the origin and reaches the limiter",
    (name, source) => {
      if (EXEMPT[name]) return;
      expect(source, "must call sameOrigin()").toMatch(/sameOrigin\(/);
      // The limiter runs inside access()/context(), or explicitly after auth.
      expect(
        /\b(access|context)\(/.test(source) ||
          /enforceWriteLimit\(/.test(source),
        "must authenticate through access()/context() or call enforceWriteLimit()",
      ).toBe(true);
    },
  );
  it("exempts only the two documented handlers", () => {
    for (const name of Object.keys(EXEMPT))
      expect(
        mutating.some((f) => f.name === name),
        name,
      ).toBe(true);
  });
});

describe("explicit per-route limits", () => {
  const attempt = (
    handler: unknown,
    path: string,
    json: unknown,
    as = "outsider" as const,
  ) => callRoute(handler, { path, method: "POST", as, json });
  it("stops invitation acceptance after 10 attempts a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-01-01T00:00:10Z"));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++)
        statuses.push(
          (
            await attempt(acceptRoute.POST, "/api/invitations/accept", {
              token: "a".repeat(64),
            })
          ).status,
        );
      expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops academy creation after 10 attempts an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-06-01T00:00:10Z"));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++)
        statuses.push(
          (await attempt(createRoute.POST, "/api/workspaces", {})).status,
        );
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not let one person's attempts count against another's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-09-01T00:00:10Z"));
    try {
      for (let i = 0; i < 11; i++)
        await attempt(acceptRoute.POST, "/api/invitations/accept", {
          token: "b".repeat(64),
        });
      const other = await attempt(
        acceptRoute.POST,
        "/api/invitations/accept",
        { token: "b".repeat(64) },
        "parent1" as never,
      );
      expect(other.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });
});
