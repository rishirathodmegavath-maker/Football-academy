// Email verification and password recovery through the real Better Auth
// handler configured by src/server/auth.ts, with the in-memory mail transport.
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
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Better Auth switches its origin and redirect checks OFF when NODE_ENV is "test"
// or the TEST variable (which Vitest sets) is truthy. Run this file the way
// production runs, with the checks on. "development" still allows the in-memory
// mail transport, which production refuses.
vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.TEST = "";
});
vi.mock("server-only", () => ({}));
// Starts Better Auth (migrations, scrypt password hashing): measured at 6-9 s on first use when the whole suite runs in parallel (default limit 5 s).
vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://academy.sportozen.app";
const filename = join(tmpdir(), `sportozen-authmail-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
const PASSWORD = "correct horse battery staple 1";
const NEW_PASSWORD = "another long passphrase 2";
const MAIL = {
  SPORTOZEN_EMAIL_TRANSPORT: "capture",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
};
const KEYS = [
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_EMAIL_VERIFICATION",
  "SPORTOZEN_PASSWORD_RECOVERY",
];

let hop = 0;
async function boot(env: Record<string, string>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const { authentication } = await import("@/server/auth");
  const mail = await import("@/server/email/transport");
  const outbox = await import("@/server/email/outbox");
  const { database } = await import("@/server/database");
  const auth = await authentication();
  mail.resetCapture();
  /** A request as the proxy would deliver it: one client address per call. */
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}`,
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
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // redirects and empty bodies
    }
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return {
      status: response.status,
      location: response.headers.get("location"),
      json,
      cookie,
    };
  };
  const send = () => outbox.processOutbox();
  return { auth, mail, outbox, db: database(), call, send };
}
type Env = Awaited<ReturnType<typeof boot>>;
const linkIn = (env: Env, index = -1) => {
  const message = env.mail.captured.at(index)!;
  const url = /https:\/\/academy\.sportozen\.app\S+/.exec(message.text)![0];
  return { url, path: url.replace(ORIGIN, "") };
};
const signUp = (env: Env, email: string) =>
  env.call("POST", "/api/auth/sign-up/email", {
    body: {
      email,
      password: PASSWORD,
      name: "Synthetic Person",
      callbackURL: "/sign-in?verified=1",
    },
  });
const signIn = (env: Env, email: string, password = PASSWORD) =>
  env.call("POST", "/api/auth/sign-in/email", { body: { email, password } });
/** Registers, follows the emailed link, and returns a signed-in session cookie. */
async function verifiedUser(env: Env, email: string) {
  await signUp(env, email);
  await env.send();
  const link = linkIn(env);
  const landing = await env.call("GET", link.path);
  expect(landing.status).toBe(302);
  const session = await signIn(env, email);
  expect(session.status).toBe(200);
  return session.cookie;
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
});
beforeAll(() => undefined);

describe("with e-mail disabled (the default) accounts work as before", () => {
  it("signs up straight into a session, signs in, and offers no password reset", async () => {
    const env = await boot({});
    const up = await signUp(env, "plain@sportozen.test");
    expect(up.status).toBe(200);
    expect(up.cookie).toContain("session_token");
    const again = await signIn(env, "plain@sportozen.test");
    expect(again.status).toBe(200);
    const reset = await env.call("POST", "/api/auth/request-password-reset", {
      body: { email: "plain@sportozen.test", redirectTo: "/reset-password" },
    });
    expect(reset.status).toBeGreaterThanOrEqual(400);
    expect(env.db.prepare("SELECT COUNT(*) n FROM email_outbox").get()!.n).toBe(
      0,
    );
  });
});

describe("email verification", () => {
  it("blocks sign-in until the emailed link is followed, then lets the person in", async () => {
    const env = await boot({
      ...MAIL,
      SPORTOZEN_EMAIL_VERIFICATION: "required",
    });
    const up = await signUp(env, "verify@sportozen.test");
    expect(up.status).toBe(200);
    expect(up.cookie).not.toContain("session_token"); // no session before verification
    expect(await env.send()).toMatchObject({ sent: 1 });
    expect(env.mail.captured[0]).toMatchObject({ to: "verify@sportozen.test" });
    const blocked = await signIn(env, "verify@sportozen.test");
    expect(blocked.status).toBe(403);
    expect(blocked.cookie).not.toContain("session_token");
    // The blocked attempt sends a fresh link (sendOnSignIn).
    await env.send();
    expect(env.mail.captured).toHaveLength(2);
    const link = linkIn(env, 0);
    expect(new URL(link.url).searchParams.get("callbackURL")).toBe(
      "/sign-in?verified=1",
    );
    const landing = await env.call("GET", link.path);
    expect(landing.status).toBe(302);
    expect(landing.location).toContain("/sign-in?verified=1");
    expect(landing.cookie).not.toContain("session_token"); // explicit sign-in, no auto session
    const ok = await signIn(env, "verify@sportozen.test");
    expect(ok.status).toBe(200);
    expect(ok.cookie).toContain("session_token");
    expect(
      env.db
        .prepare("SELECT emailVerified FROM user WHERE email=?")
        .get("verify@sportozen.test")!.emailVerified,
    ).toBe(1);
    expect(
      env.db
        .prepare(
          "SELECT COUNT(*) n FROM workspace_audit WHERE action='Email address verified'",
        )
        .get()!.n,
    ).toBe(1);
  });
  it("rejects a tampered or foreign link", async () => {
    const env = await boot({
      ...MAIL,
      SPORTOZEN_EMAIL_VERIFICATION: "required",
    });
    await signUp(env, "tamper@sportozen.test");
    await env.send();
    const link = linkIn(env);
    const url = new URL(link.url);
    const token = url.searchParams.get("token")!;
    url.searchParams.set("token", token.slice(0, -4) + "AAAA");
    const bad = await env.call("GET", url.pathname + url.search);
    expect(bad.location).toMatch(/error=/);
    expect((await signIn(env, "tamper@sportozen.test")).status).toBe(403);
    // A callback to another site is refused, not followed.
    const open = new URL(link.url);
    open.searchParams.set("callbackURL", "https://evil.example/steal");
    const refused = await env.call("GET", open.pathname + open.search);
    expect(refused.location ?? "").not.toContain("evil.example");
  });
  it("sends only same-origin links, whatever the request said", async () => {
    const env = await boot({
      ...MAIL,
      SPORTOZEN_EMAIL_VERIFICATION: "required",
    });
    await signUp(env, "origin@sportozen.test");
    await env.send();
    expect(linkIn(env).url.startsWith(`${ORIGIN}/api/auth/verify-email?`)).toBe(
      true,
    );
  });
});

describe("password recovery", () => {
  const recovery = {
    ...MAIL,
    SPORTOZEN_EMAIL_VERIFICATION: "required",
    SPORTOZEN_PASSWORD_RECOVERY: "on",
  };
  it("resets with a one-time emailed link, signs out every session and keeps the audit trail", async () => {
    const env = await boot(recovery);
    const email = "recover@sportozen.test";
    const oldSession = await verifiedUser(env, email);
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: oldSession }))
        .json,
    ).not.toBeNull();
    env.mail.resetCapture();
    const requested = await env.call(
      "POST",
      "/api/auth/request-password-reset",
      {
        body: { email, redirectTo: "/reset-password" },
      },
    );
    expect(requested.status).toBe(200);
    await env.send();
    expect(env.mail.captured).toHaveLength(1);
    expect(env.mail.captured[0]!.subject).toContain("Reset your");
    const link = linkIn(env);
    const landing = await env.call("GET", link.path);
    expect(landing.status).toBe(302);
    const token = new URL(landing.location!, ORIGIN).searchParams.get("token")!;
    expect(landing.location).toContain("/reset-password?token=");
    const weak = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: "short", token },
    });
    expect(weak.status).toBe(400);
    const done = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: NEW_PASSWORD, token },
    });
    expect(done.status).toBe(200);
    // Every earlier session ended; the old password is dead; the new one works.
    expect(
      (await env.call("GET", "/api/auth/get-session", { cookie: oldSession }))
        .json,
    ).toBeNull();
    expect((await signIn(env, email, PASSWORD)).status).toBe(401);
    expect((await signIn(env, email, NEW_PASSWORD)).status).toBe(200);
    // One use only.
    const reuse = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: "yet another passphrase 3", token },
    });
    expect(reuse.status).toBe(400);
    expect((await signIn(env, email, "yet another passphrase 3")).status).toBe(
      401,
    );
    expect(
      env.db
        .prepare(
          "SELECT COUNT(*) n FROM workspace_audit WHERE action='Password reset by emailed link'",
        )
        .get()!.n,
    ).toBe(1);
  });
  it("refuses an expired link", async () => {
    const env = await boot(recovery);
    const email = "expired@sportozen.test";
    await verifiedUser(env, email);
    env.mail.resetCapture();
    await env.call("POST", "/api/auth/request-password-reset", {
      body: { email, redirectTo: "/reset-password" },
    });
    await env.send();
    const landing = await env.call("GET", linkIn(env).path);
    const token = new URL(landing.location!, ORIGIN).searchParams.get("token")!;
    // Identifiers are stored hashed (WP6), so the only unconsumed row is this link's.
    env.db
      .prepare("UPDATE verification SET expiresAt=?")
      .run(new Date(Date.now() - 1000).toISOString());
    const late = await env.call("POST", "/api/auth/reset-password", {
      body: { newPassword: NEW_PASSWORD, token },
    });
    expect(late.status).toBe(400);
    expect((await signIn(env, email, NEW_PASSWORD)).status).toBe(401);
    expect((await signIn(env, email, PASSWORD)).status).toBe(200);
    const redirected = await env.call("GET", linkIn(env).path);
    expect(redirected.location).toMatch(/error=INVALID_TOKEN/);
  });
  it("answers the same for unknown addresses and sends nothing (no account enumeration)", async () => {
    const env = await boot(recovery);
    await verifiedUser(env, "known@sportozen.test");
    env.mail.resetCapture();
    const known = await env.call("POST", "/api/auth/request-password-reset", {
      body: { email: "known@sportozen.test", redirectTo: "/reset-password" },
    });
    const unknown = await env.call("POST", "/api/auth/request-password-reset", {
      body: {
        email: "nobody-here@sportozen.test",
        redirectTo: "/reset-password",
      },
    });
    await env.send();
    expect(unknown.status).toBe(known.status);
    expect(unknown.json).toEqual(known.json);
    expect(env.mail.captured.map((m) => m.to)).toEqual([
      "known@sportozen.test",
    ]);
  });
  it("limits reset requests per client address", async () => {
    const env = await boot(recovery);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await env.auth.handler(
        new Request(`${ORIGIN}/api/auth/request-password-reset`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-forwarded-for": "203.0.113.77",
          },
          body: JSON.stringify({
            email: `flood${i}@sportozen.test`,
            redirectTo: "/reset-password",
          }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
  it("never writes a token, link, address or password to the logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const env = await boot(recovery);
    const email = "quiet@sportozen.test";
    await verifiedUser(env, email);
    await signIn(env, email, "wrong password entirely 9");
    env.mail.resetCapture();
    await env.call("POST", "/api/auth/request-password-reset", {
      body: { email, redirectTo: "/reset-password" },
    });
    env.mail.scriptCapture(["transient", "ok"]);
    await env.send(); // transient failure
    await env.outbox.processOutbox({ now: () => Date.now() + 120_000 }); // the retry
    const secrets = env.mail.captured.flatMap((m) =>
      [...m.text.matchAll(/[A-Za-z0-9._-]{20,}/g)].map((x) => x[0]),
    );
    expect(secrets.length).toBeGreaterThan(0);
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const secret of [
      ...secrets,
      PASSWORD,
      NEW_PASSWORD,
      "wrong password entirely 9",
      email,
      "api/auth/reset-password",
      "verify-email?token",
    ])
      expect(logged, `log leaked: ${secret.slice(0, 12)}…`).not.toContain(
        secret,
      );
  });
  it("keeps queued message text only until it is sent", async () => {
    const env = await boot(recovery);
    await verifiedUser(env, "redact@sportozen.test");
    const kept = env.db
      .prepare(
        "SELECT COUNT(*) n FROM email_outbox WHERE status IN ('SENT','FAILED','EXPIRED','CANCELLED') AND textBody IS NOT NULL",
      )
      .get()!.n;
    expect(kept).toBe(0);
  });
});

// Registration, verification and password recovery for addresses from many
// countries and with international names. Mail delivery is the in-memory capture
// transport: this proves the application's handling, not delivery to a mailbox.
describe("any valid address, in any country", () => {
  const recovery = {
    ...MAIL,
    SPORTOZEN_EMAIL_VERIFICATION: "required",
    SPORTOZEN_PASSWORD_RECOVERY: "on",
  };
  const WORLD = [
    "rishi@gmail.com", // India
    "alex@yahoo.com", // USA
    "sarah@outlook.co.uk", // UK
    "ahmed@example.ae", // UAE
    "james@example.com.au", // Australia
    "anna@example.de", // Germany
    "priya.sharma+academy@example.in",
    "Mixed.Case@Example.ORG",
  ];
  let env: Env;
  beforeAll(async () => {
    env = await boot(recovery);
  });
  it.each(WORLD)(
    "registers %s, confirms the address, and recovers the password",
    async (address) => {
      const email = address.toLowerCase();
      env.mail.resetCapture();
      const up = await env.call("POST", "/api/auth/sign-up/email", {
        body: {
          email: address,
          password: PASSWORD,
          name: "Åsa Ñandú 李雷 अजय",
          callbackURL: "/sign-in?verified=1",
        },
      });
      expect(up.status, JSON.stringify(up.json)).toBe(200);
      await env.send();
      expect(env.mail.captured).toHaveLength(1);
      expect(env.mail.captured[0]).toMatchObject({ to: email });
      expect(env.mail.captured[0]!.text).toContain("Åsa Ñandú 李雷 अजय");
      expect(env.mail.captured[0]!.html).toContain("Åsa Ñandú 李雷 अजय");
      expect((await env.call("GET", linkIn(env).path)).status).toBe(302);
      expect((await signIn(env, address)).status).toBe(200);

      env.mail.resetCapture();
      expect(
        (
          await env.call("POST", "/api/auth/request-password-reset", {
            body: { email: address, redirectTo: "/reset-password" },
          })
        ).status,
      ).toBe(200);
      await env.send();
      expect(env.mail.captured).toHaveLength(1);
      expect(env.mail.captured[0]).toMatchObject({ to: email });
      const landing = await env.call("GET", linkIn(env).path);
      const token = new URL(landing.location!, ORIGIN).searchParams.get(
        "token",
      )!;
      expect(
        (
          await env.call("POST", "/api/auth/reset-password", {
            body: { newPassword: NEW_PASSWORD, token },
          })
        ).status,
      ).toBe(200);
      expect((await signIn(env, address, NEW_PASSWORD)).status).toBe(200);
    },
  );
  it("does not depend on the address to decide whether an address is valid", async () => {
    const { checkRecipient } = await import("@/server/email/address");
    for (const address of WORLD)
      expect(checkRecipient(address).ok, address).toBe(true);
  });
  it("what Better Auth itself accepts for internationalised addresses is recorded, not assumed", async () => {
    const outcomes: Record<string, number> = {};
    for (const address of ["joão@example.com.br", "anna@münchen.de", "测试@例え.jp"]) {
      const up = await env.call("POST", "/api/auth/sign-up/email", {
        body: { email: address, password: PASSWORD, name: "Intl Person" },
      });
      outcomes[address] = up.status;
    }
    // Printed so the report can state it; any 200/400 is acceptable here.
    console.info("better-auth sign-up status for internationalised addresses", outcomes);
    // ASCII addresses everywhere work (above); an internationalised domain is converted to ASCII first.
    expect(outcomes).toEqual({
      "joão@example.com.br": 400, // non-ASCII local part (SMTPUTF8): refused, documented
      "anna@münchen.de": 200,
      "测试@例え.jp": 400,
    });
    // The same person signing in as they type it is recognised (403 = found, not yet confirmed).
    expect((await signIn(env, "Anna@MÜNCHEN.de")).status).toBe(403);
    const sent = await env.send();
    expect(sent.sent).toBeGreaterThan(0);
    expect(env.mail.captured.some((m) => m.to === "anna@xn--mnchen-3ya.de")).toBe(true);
  });
});
