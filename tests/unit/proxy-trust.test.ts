// Which client address Better Auth's sign-in limiter uses behind a reverse
// proxy. These tests drive the real Better Auth handler configured by
// src/server/auth.ts, not a copy of its logic.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("server-only", () => ({}));
// Starts Better Auth (migrations, scrypt password hashing): measured at 6-9 s on first use when the whole suite runs in parallel (default limit 5 s).
vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://academy.sportozen.app";
const filename = join(tmpdir(), `sportozen-proxy-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
import { invalidProxyEntries as preflightEntries } from "../../scripts/lib/preflight.mjs";
import { clientIpOptions, invalidProxyEntries } from "@/server/proxy-config";

const KEYS = ["SPORTOZEN_TRUSTED_PROXIES", "SPORTOZEN_CLIENT_IP_HEADER"];
async function authWith(env: Record<string, string> = {}) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { authentication } = await import("@/server/auth");
  return authentication();
}
/** One failed sign-in attempt; returns the HTTP status (429 when limited). */
async function attempt(
  auth: Awaited<ReturnType<typeof authWith>>,
  headers: Record<string, string>,
) {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...headers,
      },
      body: JSON.stringify({
        email: "nobody@sportozen.test",
        password: "not-the-password-0123",
      }),
    }),
  );
  return response.status;
}
const statuses = async (
  auth: Awaited<ReturnType<typeof authWith>>,
  headers: (index: number) => Record<string, string>,
  count = 6,
) => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(await attempt(auth, headers(i)));
  return out;
};
// Better Auth allows 3 sign-in attempts per 10 seconds per client address.
const limitedAfterThree = (codes: number[]) =>
  codes.slice(0, 3).every((code) => code !== 429) &&
  codes.slice(3).every((code) => code === 429);
const everyAllowed = (codes: number[]) => codes.every((code) => code !== 429);

beforeEach(async () => {
  const { database } = await import("@/server/database");
  const db = database();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE name='rateLimit'")
    .get();
  if (table) db.exec("DELETE FROM rateLimit");
  // These tests repeat one unknown address many times to exercise the
  // per-client-address limiter; the per-account counter (WP6) is not under test.
  db.exec(
    "DELETE FROM request_rate_limits WHERE scope LIKE 'signin-failure:%'",
  );
});
afterAll(async () => {
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
});

describe("proxy trust configuration", () => {
  it("defaults to the single-valued X-Forwarded-For", () => {
    expect(clientIpOptions({})).toEqual({
      ipAddressHeaders: ["x-forwarded-for"],
    });
  });
  it("accepts trusted proxy ranges and a client address header", () => {
    expect(
      clientIpOptions({
        SPORTOZEN_TRUSTED_PROXIES: "10.0.0.0/8, 192.0.2.7",
        SPORTOZEN_CLIENT_IP_HEADER: "CF-Connecting-IP",
      }),
    ).toEqual({
      ipAddressHeaders: ["cf-connecting-ip"],
      trustedProxies: ["10.0.0.0/8", "192.0.2.7"],
    });
  });
  it("stops start-up on an invalid value instead of trusting the wrong thing", () => {
    expect(() =>
      clientIpOptions({ SPORTOZEN_TRUSTED_PROXIES: "10.0.0.0/99" }),
    ).toThrow(/invalid/);
    expect(() =>
      clientIpOptions({ SPORTOZEN_CLIENT_IP_HEADER: "bad header" }),
    ).toThrow(/header name/);
  });
  it("agrees with the preflight checker on what is valid", () => {
    for (const value of [
      "10.0.0.0/8",
      "10.0.0.0/33",
      "::1",
      "fd00::/129",
      "fd00::/8",
      "nope",
      "1.2.3.4/8/9",
      "1.2.3.4, 5.6.7.8/24",
      "",
    ])
      expect(invalidProxyEntries(value)).toEqual(preflightEntries(value));
  });
});

describe("Better Auth sign-in limiter behind a proxy", () => {
  it("limits one client address", async () => {
    const auth = await authWith();
    expect(
      limitedAfterThree(
        await statuses(auth, () => ({ "x-forwarded-for": "203.0.113.5" })),
      ),
    ).toBe(true);
  });
  it("a client-supplied prefix cannot be used to dodge the limit", async () => {
    // A proxy that appended would deliver "<spoof>, <real>"; several values
    // resolve to no address, so every such request shares one bucket.
    const auth = await authWith();
    const codes = await statuses(auth, (i) => ({
      "x-forwarded-for": `198.51.100.${i + 10}, 203.0.113.5`,
    }));
    expect(limitedAfterThree(codes)).toBe(true);
  });
  it("rotating single values defeats the limit, so the proxy MUST overwrite the header", async () => {
    // Documents why deploy/nginx and deploy/caddy overwrite X-Forwarded-For:
    // if a client could set it directly, the limiter would be bypassable.
    const auth = await authWith();
    const codes = await statuses(auth, (i) => ({
      "x-forwarded-for": `198.51.100.${i + 20}`,
    }));
    expect(everyAllowed(codes)).toBe(true);
  });
  it("with trusted proxies the first untrusted address from the right is the client", async () => {
    const auth = await authWith({ SPORTOZEN_TRUSTED_PROXIES: "10.0.0.0/8" });
    const codes = await statuses(auth, (i) => ({
      "x-forwarded-for": `192.0.2.${i + 30}, 198.51.100.7, 10.0.0.2`,
    }));
    expect(limitedAfterThree(codes)).toBe(true);
  });
  it("trusted proxies still separate genuinely different clients", async () => {
    const auth = await authWith({ SPORTOZEN_TRUSTED_PROXIES: "10.0.0.0/8" });
    const codes = await statuses(auth, (i) => ({
      "x-forwarded-for": `198.51.100.${i + 40}, 10.0.0.2`,
    }));
    expect(everyAllowed(codes)).toBe(true);
  });
  it("a configured client address header is used and X-Forwarded-For ignored", async () => {
    const auth = await authWith({
      SPORTOZEN_CLIENT_IP_HEADER: "cf-connecting-ip",
    });
    const codes = await statuses(auth, (i) => ({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": `198.51.100.${i + 50}`,
    }));
    expect(limitedAfterThree(codes)).toBe(true);
  });
});
