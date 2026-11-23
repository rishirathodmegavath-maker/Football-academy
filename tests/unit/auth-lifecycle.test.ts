// WP6: the account lifecycle through the real Better Auth handler configured by
// src/server/auth.ts: profile-write limits, per-account sign-in throttling,
// password change, session limits, two-step verification, hashed tokens and
// enumeration behaviour. Origin and redirect checks are ON (see
// email-auth-flows.test.ts for why this file sets NODE_ENV and TEST).
import type { MockInstance } from "vitest";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.TEST = "";
});
vi.mock("server-only", () => ({}));
// Starts Better Auth (migrations, scrypt hashing) and signs up several accounts.
vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = "https://academy.sportozen.app";
const filename = join(tmpdir(), `sportozen-lifecycle-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
const PASSWORD = "correct horse battery staple 1";
const NEW_PASSWORD = "another long passphrase 2";
const KEYS = [
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_EMAIL_VERIFICATION",
  "SPORTOZEN_PASSWORD_RECOVERY",
  "SPORTOZEN_SESSION_IDLE_MINUTES",
  "SPORTOZEN_SESSION_MAX_HOURS",
  "SPORTOZEN_SIGNIN_FAILURE_LIMIT",
  "SPORTOZEN_MFA",
];

let hop = 0;
async function boot(env: Record<string, string> = {}) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { authentication } = await import("@/server/auth");
  const mail = await import("@/server/email/transport");
  const outbox = await import("@/server/email/outbox");
  const { database } = await import("@/server/database");
  const authModule = await import("@/server/auth");
  const auth = await authentication();
  mail.resetCapture();
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; ip?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "x-forwarded-for": options.ip ?? `198.51.100.${(hop++ % 250) + 1}`,
    };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers.origin = ORIGIN;
    }
    if (options.cookie) headers.cookie = options.cookie;
    const response = await auth.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
      }),
    );
    const raw = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // empty bodies
    }
    return {
      status: response.status,
      json,
      retryAfter: response.headers.get("retry-after"),
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  };
  return { auth, authModule, mail, outbox, db: database(), call };
}
type Env = Awaited<ReturnType<typeof boot>>;
const signUp = (env: Env, email: string, extra: Record<string, unknown> = {}) =>
  env.call("POST", "/api/auth/sign-up/email", {
    body: { email, password: PASSWORD, name: "Synthetic Person", ...extra },
  });
const signIn = (env: Env, email: string, password = PASSWORD, ip?: string) =>
  env.call("POST", "/api/auth/sign-in/email", {
    body: { email, password },
    ip,
  });
async function account(env: Env, email: string) {
  const up = await signUp(env, email);
  expect(up.status).toBe(200);
  return up.cookie;
}
const audits = (env: Env, action: string) =>
  env.db
    .prepare("SELECT userId,academyId FROM workspace_audit WHERE action=?")
    .all(action);

// RFC 6238 (HMAC-SHA1, 30 s, 6 digits) for the authenticator-app code.
function base32Decode(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const hash = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hash[19] & 0xf;
  const value =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}
/** Turns two-step verification on for a signed-in cookie; returns its secrets. */
async function enrol(env: Env, cookie: string) {
  const enable = await env.call("POST", "/api/auth/two-factor/enable", {
    body: { password: PASSWORD },
    cookie,
  });
  expect(enable.status).toBe(200);
  const uri = String(enable.json!.totpURI),
    secret = new URL(uri).searchParams.get("secret")!;
  const confirm = await env.call("POST", "/api/auth/two-factor/verify-totp", {
    body: { code: totp(secret) },
    cookie,
  });
  expect(confirm.status).toBe(200);
  return {
    secret,
    backupCodes: enable.json!.backupCodes as string[],
    cookie: confirm.cookie || cookie,
  };
}

// Security events are one JSON line each on the warning stream; keep test output
// readable and let the tests that care read the lines.
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
/** True when a Set-Cookie list carries a session token with a value (not a deletion). */
const hasSessionToken = (cookie: string) =>
  /session_token=[^;\s]+/.test(cookie);
afterAll(async () => {
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
});

describe("profile writes are bounded", () => {
  it("refuses profile images and over-long names, on sign-up and on update", async () => {
    const env = await boot();
    const image = await signUp(env, "image@sportozen.test", {
      image: "x".repeat(2_000_000),
    });
    expect(image.status).toBe(400);
    expect(
      (await signUp(env, "long@sportozen.test", { name: "n".repeat(101) }))
        .status,
    ).toBe(400);
    const cookie = await account(env, "profile@sportozen.test");
    const big = await env.call("POST", "/api/auth/update-user", {
      body: { image: "x".repeat(2_000_000) },
      cookie,
    });
    expect(big.status).toBe(400);
    const stored = env.db
      .prepare(
        "SELECT length(coalesce(image,'')) AS size FROM \"user\" WHERE email=?",
      )
      .get("profile@sportozen.test");
    expect(stored!.size).toBe(0);
    const renamed = await env.call("POST", "/api/auth/update-user", {
      body: { name: "New Name" },
      cookie,
    });
    expect(renamed.status).toBe(200);
  });
  it("refuses an oversized request to the authentication route before reading it", async () => {
    await boot();
    const route = await import("@/app/api/auth/[...all]/route");
    const huge = await route.POST(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          email: "a@b.test",
          password: "x".repeat(40_000),
        }),
      }),
    );
    expect(huge.status).toBe(413);
    const normal = await route.POST(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": "203.0.113.9",
        },
        body: JSON.stringify({
          email: "nobody@sportozen.test",
          password: PASSWORD,
        }),
      }),
    );
    // Reached Better Auth with the body intact: a normal "invalid" answer.
    expect(normal.status).toBe(401);
  });
});

describe("sign-in answers and throttling", () => {
  it("answers a wrong password and an unknown address identically", async () => {
    const env = await boot();
    await account(env, "known@sportozen.test");
    const wrong = await signIn(
      env,
      "known@sportozen.test",
      "wrong wrong wrong 1",
    );
    const unknown = await signIn(
      env,
      "nobody@sportozen.test",
      "wrong wrong wrong 1",
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.json).toEqual(wrong.json);
  });
  it("locks an account after repeated failures from many addresses, with the same answer for unknown accounts", async () => {
    const env = await boot({ SPORTOZEN_SIGNIN_FAILURE_LIMIT: "5" });
    await account(env, "target@sportozen.test");
    for (let i = 0; i < 5; i++)
      expect(
        (await signIn(env, "target@sportozen.test", "wrong wrong wrong 1"))
          .status,
      ).toBe(401);
    // Even the right password is refused for the rest of the window.
    const locked = await signIn(env, "target@sportozen.test");
    expect(locked.status).toBe(429);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
    // An address that has no account behaves exactly the same once it is "locked".
    for (let i = 0; i < 5; i++)
      await signIn(env, "ghost@sportozen.test", "wrong wrong wrong 1");
    const ghost = await signIn(env, "ghost@sportozen.test");
    expect(ghost.status).toBe(429);
    expect(ghost.json).toEqual(locked.json);
    // Other accounts are unaffected, and the counter is not keyed by the address in clear text.
    await account(env, "other@sportozen.test");
    expect((await signIn(env, "other@sportozen.test")).status).toBe(200);
    const scopes = env.db
      .prepare(
        "SELECT scope FROM request_rate_limits WHERE scope LIKE 'signin-failure:%'",
      )
      .all()
      .map((r) => String(r.scope));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.join(" ")).not.toContain("target");
    expect(scopes.join(" ")).not.toContain("ghost");
  });
  it("a successful sign-in clears earlier failures", async () => {
    const env = await boot({ SPORTOZEN_SIGNIN_FAILURE_LIMIT: "4" });
    await account(env, "forgetful@sportozen.test");
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++)
        await signIn(env, "forgetful@sportozen.test", "wrong wrong wrong 1");
      expect((await signIn(env, "forgetful@sportozen.test")).status).toBe(200);
    }
  });
  it("logs a sign-in failure without the address, the password or any token", async () => {
    const env = await boot();
    await account(env, "logged@sportozen.test");
    warn.mockClear();
    await signIn(env, "logged@sportozen.test", "wrong wrong wrong 1");
    const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain('"type":"signin.failed"');
    expect(lines).not.toContain("logged@sportozen.test");
    expect(lines).not.toContain("wrong wrong");
  });
});

describe("password change and sessions", () => {
  it("ends every other session, keeps the current one, and is audited", async () => {
    const env = await boot();
    const first = await account(env, "change@sportozen.test");
    const second = (await signIn(env, "change@sportozen.test")).cookie;
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: first })).json,
    ).not.toBeNull();
    const wrong = await env.call("POST", "/api/auth/change-password", {
      body: {
        currentPassword: "not the password 1",
        newPassword: NEW_PASSWORD,
      },
      cookie: second,
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    // A failed attempt changes nothing.
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: first })).json,
    ).not.toBeNull();
    // The client does not ask for revocation; the server does it anyway.
    const changed = await env.call("POST", "/api/auth/change-password", {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie: second,
    });
    expect(changed.status).toBe(200);
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: first })).json,
    ).toBeNull();
    expect(
      (
        await env.call("GET", "/api/auth/get-session", {
          cookie: changed.cookie,
        })
      ).json,
    ).not.toBeNull();
    expect((await signIn(env, "change@sportozen.test")).status).toBe(401);
    expect(
      (await signIn(env, "change@sportozen.test", NEW_PASSWORD)).status,
    ).toBe(200);
    expect(audits(env, "Password changed; other sessions ended")).toHaveLength(
      1,
    );
  });
  it("signs out other devices on request and audits it", async () => {
    const env = await boot();
    const first = await account(env, "devices@sportozen.test");
    const second = (await signIn(env, "devices@sportozen.test")).cookie;
    expect(
      (
        await env.call("POST", "/api/auth/revoke-other-sessions", {
          body: {},
          cookie: second,
        })
      ).status,
    ).toBe(200);
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: first })).json,
    ).toBeNull();
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: second })).json,
    ).not.toBeNull();
    expect(
      audits(env, "Other sessions signed out by the account owner"),
    ).toHaveLength(1);
  });
  it("records account creation", async () => {
    const env = await boot();
    await account(env, "created@sportozen.test");
    expect(audits(env, "Account created").length).toBeGreaterThan(0);
  });
});

describe("session lifetime", () => {
  it("keeps the 8 hour absolute limit by default and has no idle limit", async () => {
    const env = await boot();
    const cookie = await account(env, "default@sportozen.test");
    const session = (await env.call("GET", "/api/auth/get-session", { cookie }))
      .json as { session: { expiresAt: string } };
    const hours = (Date.parse(session.session.expiresAt) - Date.now()) / 3.6e6;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
  });
  it("ends a session older than the absolute limit even if it was renewed", async () => {
    const env = await boot();
    const cookie = await account(env, "old@sportozen.test");
    const headers = new Headers({ cookie });
    await expect(
      env.authModule.authenticatedUser(headers),
    ).resolves.toBeTruthy();
    env.db
      .prepare(
        'UPDATE session SET createdAt=? WHERE userId=(SELECT id FROM "user" WHERE email=?)',
      )
      .run(
        new Date(Date.now() - 9 * 3.6e6).toISOString(),
        "old@sportozen.test",
      );
    await expect(
      env.authModule.authenticatedUser(headers),
    ).rejects.toMatchObject({ status: 401 });
    // The row is gone, so the cookie is dead everywhere.
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).toBeNull();
  });
  it("applies a configured idle limit and absolute limit", async () => {
    const env = await boot({
      SPORTOZEN_SESSION_IDLE_MINUTES: "30",
      SPORTOZEN_SESSION_MAX_HOURS: "4",
    });
    const cookie = await account(env, "idle@sportozen.test");
    const session = (await env.call("GET", "/api/auth/get-session", { cookie }))
      .json as { session: { expiresAt: string } };
    const minutes =
      (Date.parse(session.session.expiresAt) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
  });
  it("rejects invalid session settings at start-up", async () => {
    const { sessionPolicy } = await import("@/server/account-security");
    expect(sessionPolicy({}).absoluteSeconds).toBe(8 * 3600);
    expect(() =>
      sessionPolicy({ SPORTOZEN_SESSION_IDLE_MINUTES: "2" }),
    ).toThrow();
    expect(() =>
      sessionPolicy({ SPORTOZEN_SESSION_MAX_HOURS: "100" }),
    ).toThrow();
    expect(() =>
      sessionPolicy({ SPORTOZEN_SESSION_IDLE_MINUTES: "abc" }),
    ).toThrow();
    expect(() =>
      sessionPolicy({
        SPORTOZEN_SESSION_MAX_HOURS: "1",
        SPORTOZEN_SESSION_IDLE_MINUTES: "90",
      }),
    ).toThrow();
  });
});

describe("two-step verification", () => {
  it("is optional to enrol, and sign-in is unchanged until the code is confirmed", async () => {
    const env = await boot();
    const cookie = await account(env, "pending@sportozen.test");
    const enable = await env.call("POST", "/api/auth/two-factor/enable", {
      body: { password: PASSWORD },
      cookie,
    });
    expect(enable.status).toBe(200);
    expect(enable.json!.backupCodes).toHaveLength(10);
    // Set up but never confirmed: no challenge yet.
    const again = await signIn(env, "pending@sportozen.test");
    expect(again.status).toBe(200);
    expect(again.json!.twoFactorRedirect).toBeUndefined();
    // A wrong password cannot start enrolment.
    const bad = await env.call("POST", "/api/auth/two-factor/enable", {
      body: { password: "not the password 1" },
      cookie,
    });
    expect(bad.status).toBe(400);
  });
  it("challenges sign-in with no session until a valid code, then allows it", async () => {
    const env = await boot();
    const cookie = await account(env, "mfa@sportozen.test");
    const { secret } = await enrol(env, cookie);
    const step1 = await signIn(env, "mfa@sportozen.test");
    expect(step1.status).toBe(200);
    expect(step1.json!.twoFactorRedirect).toBe(true);
    expect(hasSessionToken(step1.cookie)).toBe(false);
    // The password alone gives no access.
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: step1.cookie }))
        .json,
    ).toBeNull();
    const wrong = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: "000000" },
      cookie: step1.cookie,
    });
    expect(wrong.status).toBe(401);
    const right = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: totp(secret), trustDevice: true },
      cookie: step1.cookie,
    });
    expect(right.status).toBe(200);
    expect(hasSessionToken(right.cookie)).toBe(true);
    // "Trust this device" is ignored: no long-lived cookie that skips the second step.
    expect(right.cookie).not.toContain("trust_device");
    const next = await signIn(env, "mfa@sportozen.test");
    expect(next.json!.twoFactorRedirect).toBe(true);
    expect(
      audits(env, "Two-step verification turned on; other sessions ended"),
    ).toHaveLength(1);
  });
  it("accepts each recovery code once", async () => {
    const env = await boot();
    const cookie = await account(env, "recovery@sportozen.test");
    const { backupCodes } = await enrol(env, cookie);
    const use = async (code: string) => {
      const step1 = await signIn(env, "recovery@sportozen.test");
      return env.call("POST", "/api/auth/two-factor/verify-backup-code", {
        body: { code },
        cookie: step1.cookie,
      });
    };
    expect((await use(backupCodes[0])).status).toBe(200);
    expect((await use(backupCodes[0])).status).toBe(401);
    expect((await use(backupCodes[1])).status).toBe(200);
  });
  it("ends the challenge after repeated wrong codes, even if the right code follows", async () => {
    const env = await boot();
    const cookie = await account(env, "guess@sportozen.test");
    const { secret } = await enrol(env, cookie);
    const step1 = await signIn(env, "guess@sportozen.test");
    let last = 0;
    for (let i = 0; i < 6; i++)
      last = (
        await env.call("POST", "/api/auth/two-factor/verify-totp", {
          body: { code: "000000" },
          cookie: step1.cookie,
          ip: `203.0.113.${i + 1}`,
        })
      ).status;
    expect(last).toBeGreaterThanOrEqual(400);
    const late = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: totp(secret) },
      cookie: step1.cookie,
      ip: "203.0.113.50",
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(hasSessionToken(late.cookie)).toBe(false);
  });
  it("turning it off needs the password, ends the challenge and is audited", async () => {
    const env = await boot();
    const cookie = await account(env, "off@sportozen.test");
    const { cookie: fresh } = await enrol(env, cookie);
    const refused = await env.call("POST", "/api/auth/two-factor/disable", {
      body: { password: "not the password 1" },
      cookie: fresh,
    });
    expect(refused.status).toBe(400);
    const off = await env.call("POST", "/api/auth/two-factor/disable", {
      body: { password: PASSWORD },
      cookie: fresh,
    });
    expect(off.status).toBe(200);
    const next = await signIn(env, "off@sportozen.test");
    expect(next.json!.twoFactorRedirect).toBeUndefined();
    expect(audits(env, "Two-step verification turned off")).toHaveLength(1);
  });
  it("the operator reset removes the second step, ends sessions and is audited", async () => {
    const env = await boot();
    const cookie = await account(env, "lost@sportozen.test");
    await enrol(env, cookie);
    const { spawnSync } = await import("node:child_process");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["scripts/reset-mfa.mjs", ...args], {
        env: { ...process.env, SPORTOZEN_DATABASE_PATH: filename },
        encoding: "utf8",
      });
    // Refuses to run without the explicit identity confirmation, and for unknown accounts.
    expect(run(["lost@sportozen.test"]).status).toBe(2);
    expect(run(["nobody@sportozen.test", "--identity-verified"]).status).toBe(
      1,
    );
    const done = run(["lost@sportozen.test", "--identity-verified"]);
    expect(done.status).toBe(0);
    expect(done.stdout).not.toMatch(/secret|code=|[A-Z2-7]{16}/);
    const next = await signIn(env, "lost@sportozen.test");
    expect(next.status).toBe(200);
    expect(next.json!.twoFactorRedirect).toBeUndefined();
    expect(
      audits(
        env,
        "Two-step verification reset by local operator after an identity check; all sessions ended",
      ),
    ).toHaveLength(1);
  });
  it("does not store the authenticator secret or recovery codes in clear text", async () => {
    const env = await boot();
    const cookie = await account(env, "stored@sportozen.test");
    const { secret, backupCodes } = await enrol(env, cookie);
    const row = env.db
      .prepare('SELECT secret,backupCodes FROM "twoFactor"')
      .all()
      .map((r) => `${r.secret} ${r.backupCodes}`)
      .join(" ");
    expect(row).not.toContain(secret);
    for (const code of backupCodes) expect(row).not.toContain(code);
  });
});

describe("tokens at rest and enumeration", () => {
  it("stores reset and challenge identifiers as hashes, and the reset still works once", async () => {
    const env = await boot({
      SPORTOZEN_EMAIL_TRANSPORT: "capture",
      SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
      SPORTOZEN_PASSWORD_RECOVERY: "on",
    });
    await account(env, "reset@sportozen.test");
    await env.call("POST", "/api/auth/request-password-reset", {
      body: { email: "reset@sportozen.test", redirectTo: "/reset-password" },
    });
    await env.outbox.processOutbox();
    const link = /https:\/\/academy\.sportozen\.app\S+/.exec(
      env.mail.captured.at(-1)!.text,
    )![0];
    const token = new URL(link).pathname.split("/").pop()!;
    expect(token.length).toBeGreaterThan(10);
    const identifiers = env.db
      .prepare("SELECT identifier FROM verification")
      .all()
      .map((r) => String(r.identifier))
      .join(" ");
    expect(identifiers).not.toContain(token);
    expect(identifiers).not.toContain("reset-password:");
    const landing = await env.call("GET", link.replace(ORIGIN, ""));
    expect(landing.status).toBe(302);
    const apply = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: NEW_PASSWORD, token },
    });
    expect(apply.status).toBe(200);
    const reuse = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: "yet another passphrase 3", token },
    });
    expect(reuse.status).toBe(400);
  });
  it("with verification required, signing up an existing address looks the same as a new one", async () => {
    const env = await boot({
      SPORTOZEN_EMAIL_TRANSPORT: "capture",
      SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
      SPORTOZEN_EMAIL_VERIFICATION: "required",
    });
    const fresh = await signUp(env, "enum@sportozen.test");
    const duplicate = await signUp(env, "enum@sportozen.test");
    expect(duplicate.status).toBe(fresh.status);
    expect(Object.keys(duplicate.json ?? {}).sort()).toEqual(
      Object.keys(fresh.json ?? {}).sort(),
    );
    expect(duplicate.cookie).toBe("");
  });
  it("KNOWN LIMITATION: with verification off, a duplicate sign-up reveals that the address has an account", async () => {
    // Open registration without a mailbox check cannot hide this. The remedy is
    // the owner's decision to require verified e-mail (docs/AUTHENTICATION.md).
    const env = await boot();
    await signUp(env, "exists@sportozen.test");
    const duplicate = await signUp(env, "exists@sportozen.test");
    expect(duplicate.status).toBe(422);
  });
});

describe("review hardening (WP6 independent review)", () => {
  it("counts a sign-in attempt before checking the password, so a parallel burst cannot slip past the pause", async () => {
    const env = await boot({ SPORTOZEN_SIGNIN_FAILURE_LIMIT: "3" });
    await account(env, "burst@sportozen.test");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        signIn(
          env,
          "burst@sportozen.test",
          "wrong wrong wrong 1",
          `203.0.113.${i + 1}`,
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(9);
  });
  it("logs one line for a pause, not one per refused attempt", async () => {
    const env = await boot({ SPORTOZEN_SIGNIN_FAILURE_LIMIT: "2" });
    await account(env, "flood@sportozen.test");
    warn.mockClear();
    for (let i = 0; i < 8; i++)
      await signIn(env, "flood@sportozen.test", "wrong wrong wrong 1");
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(
      lines.filter((l) => l.includes('"type":"signin.locked"')),
    ).toHaveLength(1);
    expect(
      lines.filter((l) => l.includes('"type":"signin.failed"')),
    ).toHaveLength(2);
  });
  it("ends a session past the absolute limit on Better Auth's own endpoints too", async () => {
    const env = await boot();
    const cookie = await account(env, "ancient@sportozen.test");
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).not.toBeNull();
    env.db
      .prepare('UPDATE "session" SET createdAt=?')
      .run(new Date(Date.now() - 20 * 3.6e6).toISOString());
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).toBeNull();
    expect(
      (await env.call("GET", "/api/auth/list-sessions", { cookie })).status,
    ).toBe(401);
    expect(
      (
        await env.call("POST", "/api/auth/update-user", {
          body: { name: "Late" },
          cookie,
        })
      ).status,
    ).toBe(401);
  });
  it("applies the idle limit: an unused session expires, an active one is renewed", async () => {
    const env = await boot({ SPORTOZEN_SESSION_IDLE_MINUTES: "30" });
    const cookie = await account(env, "idler@sportozen.test");
    const mine = "(SELECT id FROM \"user\" WHERE email='idler@sportozen.test')";
    const expires = () =>
      Date.parse(
        String(
          env.db
            .prepare(`SELECT expiresAt FROM "session" WHERE userId=${mine}`)
            .get()!.expiresAt,
        ),
      );
    // Half-way through the idle window: the next request renews it to a full window.
    env.db
      .prepare(`UPDATE "session" SET expiresAt=? WHERE userId=${mine}`)
      .run(new Date(Date.now() + 1300_000).toISOString());
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).not.toBeNull();
    expect((expires() - Date.now()) / 60000).toBeGreaterThan(29);
    // Idle past the window: gone.
    env.db
      .prepare(`UPDATE "session" SET expiresAt=? WHERE userId=${mine}`)
      .run(new Date(Date.now() - 1000).toISOString());
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).toBeNull();
  });
  it("turning on two-step verification ends every other session of the account", async () => {
    const env = await boot();
    const first = await account(env, "enrol-others@sportozen.test");
    const second = (await signIn(env, "enrol-others@sportozen.test")).cookie;
    const { cookie } = await enrol(env, second);
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: first })).json,
    ).toBeNull();
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie })).json,
    ).not.toBeNull();
    const mine = env.db
      .prepare('SELECT id FROM "user" WHERE email=?')
      .get("enrol-others@sportozen.test")!.id;
    expect(
      audits(
        env,
        "Two-step verification turned on; other sessions ended",
      ).filter((row) => row.userId === mine),
    ).toHaveLength(1);
  });
  it("admits an enrolled person under the staff policy and refuses one who is not (real accounts)", async () => {
    const env = await boot();
    process.env.SPORTOZEN_MFA = "staff";
    const { requireMfa } = await import("@/server/mfa-policy");
    const plain = await account(env, "gate-plain@sportozen.test");
    const plainUser = await env.authModule.authenticatedUser(
      new Headers({ cookie: plain }),
    );
    expect(() => requireMfa(plainUser, "COACH")).toThrow(/two-step/i);
    expect(() => requireMfa(plainUser, "PARENT")).not.toThrow();
    const other = await account(env, "gate-enrolled@sportozen.test");
    const { cookie } = await enrol(env, other);
    const enrolled = await env.authModule.authenticatedUser(
      new Headers({ cookie }),
    );
    expect((enrolled as { twoFactorEnabled?: boolean }).twoFactorEnabled).toBe(
      true,
    );
    expect(() => requireMfa(enrolled, "COACH")).not.toThrow();
  });
  it("gives a wrong second-step code exactly five tries per challenge, then the challenge is dead", async () => {
    const env = await boot();
    const cookie = await account(env, "five@sportozen.test");
    const { secret } = await enrol(env, cookie);
    const step1 = await signIn(env, "five@sportozen.test");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (
          await env.call("POST", "/api/auth/two-factor/verify-totp", {
            body: { code: "000000" },
            cookie: step1.cookie,
            ip: `203.0.113.${100 + i}`,
          })
        ).status,
      );
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const sixth = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: "000000" },
      cookie: step1.cookie,
      ip: "203.0.113.120",
    });
    expect(sixth.status).toBe(400);
    const late = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: totp(secret) },
      cookie: step1.cookie,
      ip: "203.0.113.121",
    });
    expect([400, 401]).toContain(late.status);
    expect(hasSessionToken(late.cookie)).toBe(false);
  });
  it("pauses the second step for the account after ten wrong codes across challenges", async () => {
    const env = await boot({ SPORTOZEN_SIGNIN_FAILURE_LIMIT: "1000" });
    const cookie = await account(env, "ten@sportozen.test");
    const { secret } = await enrol(env, cookie);
    let n = 0;
    const wrongCode = async () => {
      const step1 = await signIn(
        env,
        "ten@sportozen.test",
        PASSWORD,
        `198.18.0.${++n}`,
      );
      return env.call("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: "000000" },
        cookie: step1.cookie,
        ip: `198.19.0.${n}`,
      });
    };
    for (let i = 0; i < 10; i++) expect((await wrongCode()).status).toBe(401);
    const paused = await wrongCode();
    expect(paused.status).toBe(429);
    // Even the right code is refused while the account is paused.
    const step1 = await signIn(
      env,
      "ten@sportozen.test",
      PASSWORD,
      "198.18.1.1",
    );
    const right = await env.call("POST", "/api/auth/two-factor/verify-totp", {
      body: { code: totp(secret) },
      cookie: step1.cookie,
      ip: "198.19.1.1",
    });
    expect(right.status).toBe(429);
    expect(hasSessionToken(right.cookie)).toBe(false);
  });
  it("refuses an oversized streamed (chunked) request to the authentication route", async () => {
    await boot();
    const route = await import("@/app/api/auth/[...all]/route");
    const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await route.POST(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });
});
