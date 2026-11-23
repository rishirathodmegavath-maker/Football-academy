// "Invalid origin" at sign-in: the server learns its own port, trusts exactly
// its own loopback names in development, and still refuses every other origin
// (CSRF protection stays on). Real Better Auth handler, origin checks enabled.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Better Auth switches its origin and redirect checks OFF when NODE_ENV is
// "test" or the TEST variable (which Vitest sets) is truthy. Run the way the
// application really runs, with the checks on.
vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.TEST = "";
});
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });

const filename = join(tmpdir(), `sportozen-origin-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
// Local development writes mail to a folder; keep it out of the repository.
process.env.SPORTOZEN_EMAIL_PREVIEW_DIR = join(tmpdir(), `sportozen-origin-mail-${randomUUID()}`);
process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
const PASSWORD = "correct horse battery staple 1";
const KEYS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "PORT",
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_PASSWORD_RECOVERY",
  "SPORTOZEN_EMAIL_VERIFICATION",
];

let hop = 0;
async function boot(env: Record<string, string>, nodeEnv = "development") {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  vi.resetModules();
  const { authentication } = await import("@/server/auth");
  const auth = await authentication();
  const post = async (
    url: string,
    path: string,
    origin: string | null,
    body: unknown,
    cookie?: string,
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}`,
    };
    if (origin !== null) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const response = await auth.handler(
      new Request(`${url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      json: text ? (JSON.parse(text) as { code?: string }) : {},
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  };
  return { post };
}

afterAll(async () => {
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
});

describe("local development on a port other than 3000", () => {
  it("signs in from the origin the browser really sends, and refuses every other origin", async () => {
    const { post } = await boot({ PORT: "3005" });
    const email = `origin-${randomUUID()}@example.com`;
    const here = "http://localhost:3005";
    const up = await post(here, "/api/auth/sign-up/email", here, {
      email,
      password: PASSWORD,
      name: "Synthetic Person",
    });
    expect(up.status, JSON.stringify(up.json)).toBe(200);

    // Accepted: the three loopback names of this one server.
    for (const origin of [
      "http://localhost:3005",
      "http://127.0.0.1:3005",
      "http://[::1]:3005",
    ]) {
      const ok = await post(origin, "/api/auth/sign-in/email", origin, {
        email,
        password: PASSWORD,
      });
      expect(ok.status, origin).toBe(200);
    }
    // Refused with the origin error, and never reaching the password check.
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3006",
      "https://localhost:3005",
      "http://localhost:3005.evil.example",
      "http://evil.example",
      "null",
    ]) {
      const refused = await post(here, "/api/auth/sign-in/email", origin, {
        email: `nobody-${randomUUID()}@example.com`,
        password: PASSWORD,
      });
      expect(refused.status, origin).toBe(403);
      // "null" is reported as a missing origin; every other one as invalid.
      expect(["INVALID_ORIGIN", "MISSING_OR_NULL_ORIGIN"], origin).toContain(
        refused.json.code,
      );
    }
  });

  it("password-reset requests cannot be pointed at another site, or forged with a session cookie", async () => {
    const { post } = await boot({
      PORT: "3005",
      SPORTOZEN_EMAIL_TRANSPORT: "file",
      SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@localhost.test>",
      SPORTOZEN_PASSWORD_RECOVERY: "on",
    });
    const here = "http://localhost:3005";
    // The emailed link would lead to redirectTo: it must stay on a trusted origin.
    const elsewhere = await post(here, "/api/auth/request-password-reset", here, {
      email: "someone@example.com",
      redirectTo: "http://evil.example/steal",
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.json.code).toBe("INVALID_REDIRECT_URL");
    const fine = await post(here, "/api/auth/request-password-reset", here, {
      email: "someone@example.com",
      redirectTo: "/reset-password",
    });
    expect(fine.status).toBe(200);
  });

  it("a request carrying a session cookie from a forged origin is refused (CSRF)", async () => {
    const { post } = await boot({ PORT: "3005" });
    const here = "http://localhost:3005";
    const email = `csrf-${randomUUID()}@example.com`;
    const up = await post(here, "/api/auth/sign-up/email", here, {
      email,
      password: PASSWORD,
      name: "Synthetic Person",
    });
    expect(up.cookie).toContain("session_token");
    for (const origin of ["http://evil.example", "http://localhost:3000"]) {
      const forged = await post(here, "/api/auth/sign-out", origin, {}, up.cookie);
      expect(forged.status, origin).toBe(403);
      expect(forged.json.code, origin).toBe("INVALID_ORIGIN");
    }
    expect((await post(here, "/api/auth/sign-out", here, {}, up.cookie)).status).toBe(200);
  });
});

describe("a real deployment", () => {
  it("trusts only its own https origin: localhost is not accepted", async () => {
    const { post } = await boot(
      { BETTER_AUTH_URL: "https://academy.example.org" },
      "production",
    );
    const url = "https://academy.example.org";
    const email = `prod-${randomUUID()}@example.com`;
    expect(
      (
        await post(url, "/api/auth/sign-up/email", url, {
          email,
          password: PASSWORD,
          name: "Synthetic Person",
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(url, "/api/auth/sign-in/email", url, { email, password: PASSWORD }))
        .status,
    ).toBe(200);
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://academy.example.org",
      "https://academy.example.org.evil.example",
    ]) {
      const refused = await post(url, "/api/auth/sign-in/email", origin, {
        email: `nobody-${randomUUID()}@example.com`,
        password: PASSWORD,
      });
      expect(refused.json.code, origin).toBe("INVALID_ORIGIN");
    }
  });

  it("accepts an extra origin only when it is listed exactly", async () => {
    const { post } = await boot(
      {
        BETTER_AUTH_URL: "https://academy.example.org",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://www.example.org",
      },
      "production",
    );
    const ask = (origin: string) =>
      post("https://academy.example.org", "/api/auth/sign-in/email", origin, {
        email: `nobody-${randomUUID()}@example.com`,
        password: PASSWORD,
      });
    expect((await ask("https://www.example.org")).json.code).not.toBe("INVALID_ORIGIN");
    expect((await ask("https://other.example.org")).json.code).toBe("INVALID_ORIGIN");
  });

  it("refuses to start with a wildcard trusted origin", async () => {
    await expect(
      boot(
        {
          BETTER_AUTH_URL: "https://academy.example.org",
          BETTER_AUTH_TRUSTED_ORIGINS: "https://*.example.org",
        },
        "production",
      ),
    ).rejects.toThrow(/wildcards are not allowed/);
  });
});
