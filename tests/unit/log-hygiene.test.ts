// WP8: evidence that the logs carry no passwords, tokens, addresses, telephone
// numbers or children's names. Real flows run through the real Better Auth
// handler and the application's error path with planted sensitive values while
// every console stream is captured; the planted values must appear nowhere, and
// the events an operator needs must appear.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.TEST = "";
});
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = "https://academy.sportozen.app";
const filename = join(tmpdir(), `sportozen-hygiene-${randomUUID()}.sqlite`);
const AUTH_SECRET = "planted-auth-secret-" + randomUUID() + randomUUID();
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
process.env.SPORTOZEN_EMAIL_TRANSPORT = "capture";
process.env.SPORTOZEN_EMAIL_FROM =
  "Sportozen <notifications@academy.sportozen.app>";
process.env.SPORTOZEN_PASSWORD_RECOVERY = "on";
process.env.SPORTOZEN_SIGNIN_FAILURE_LIMIT = "3";

const PLANTED = {
  email: "guardian.private@example.org",
  otherEmail: "ghost.unknown@example.org",
  password: "Planted-Password-Value-1!",
  wrongPassword: "Wrong-Planted-Password-2!",
  phone: "+91 98765 43210",
  child: "Aarav Plantedchild",
  token: "PLANTEDTOKEN" + "a1b2c3d4e5f6".repeat(4),
};
const lines: string[] = [];
let hop = 0;
beforeEach(() => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      );
    });
});
afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDatabaseCleanly } = await import("@/server/shutdown");
  closeDatabaseCleanly();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true, maxRetries: 10, retryDelay: 100 });
});

async function boot() {
  vi.resetModules();
  const { authentication } = await import("@/server/auth");
  const mail = await import("@/server/email/transport");
  const outbox = await import("@/server/email/outbox");
  const auth = await authentication();
  mail.resetCapture();
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ) => {
    const headers: Record<string, string> = {
      "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}`,
      "x-request-id": "req-" + randomUUID(),
    };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers.origin = ORIGIN;
    }
    if (cookie) headers.cookie = cookie;
    const response = await auth.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      }),
    );
    await response.text();
    return {
      status: response.status,
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  };
  return { auth, mail, outbox, call };
}

describe("what the logs contain after real account activity", () => {
  it("records the operator-relevant events and none of the planted sensitive values", async () => {
    const { call, mail, outbox } = await boot();
    const up = await call("POST", "/api/auth/sign-up/email", {
      email: PLANTED.email,
      password: PLANTED.password,
      name: PLANTED.child,
    });
    expect(up.status).toBe(200);
    // Failed sign-ins for a real and an unknown address, until the account is paused.
    for (let i = 0; i < 5; i++) {
      await call("POST", "/api/auth/sign-in/email", {
        email: PLANTED.email,
        password: PLANTED.wrongPassword,
      });
      await call("POST", "/api/auth/sign-in/email", {
        email: PLANTED.otherEmail,
        password: PLANTED.wrongPassword,
      });
    }
    // A successful session, a password change and a second step.
    const { cookie } = await (async () => {
      // Wait out the pause by clearing the counter, as a successful earlier window would.
      const { database } = await import("@/server/database");
      database().exec("DELETE FROM request_rate_limits");
      return call("POST", "/api/auth/sign-in/email", {
        email: PLANTED.email,
        password: PLANTED.password,
      });
    })();
    await call(
      "POST",
      "/api/auth/change-password",
      {
        currentPassword: PLANTED.password,
        newPassword: PLANTED.password + "x",
      },
      cookie,
    );
    // A reset link whose token is planted in the mail the application builds.
    await call("POST", "/api/auth/request-password-reset", {
      email: PLANTED.email,
      redirectTo: "/reset-password",
    });
    await outbox.processOutbox();
    const message = mail.captured.at(-1)!;
    const link = /https:\/\/academy\.sportozen\.app\S+/.exec(message.text)![0];
    await call("POST", "/api/auth/reset-password", {
      newPassword: "Another-Planted-3!",
      token: link.split("/").pop()!.split("?")[0],
    });
    await call("POST", "/api/auth/reset-password", {
      newPassword: "Another-Planted-3!",
      token: PLANTED.token,
    });

    const output = lines.join("\n");
    // Not vacuous: the events an operator needs are there.
    for (const type of ["signin.failed", "signin.locked", "password.changed"])
      expect(output, type).toContain(`"type":"${type}"`);
    expect(output).toContain('"event":"security"');
    expect(output).toMatch(/"requestId":"req-[0-9a-f-]{36}"/);
    // Every line is a structured entry, except the one-line API-error messages
    // Better Auth prints in its own format from a path its logger option does
    // not cover (fixed message text such as "Too many sign-in attempts"; no
    // request data, which the planted-value check below confirms).
    const unstructured = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return (
          typeof parsed.event !== "string" || typeof parsed.level !== "string"
        );
      } catch {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        return !/^\S+ (?:ERROR|WARN) \[Better Auth\]: [A-Z][^{}@]{0,120}$/.test(
          plain,
        );
      }
    });
    expect(unstructured, "lines that are not structured log entries").toEqual(
      [],
    );
    expect(output).toContain('"event":"auth.library"');
    // And nothing sensitive is.
    const token = link.split("/").pop()!.split("?")[0];
    for (const [name, value] of Object.entries({
      email: PLANTED.email,
      otherEmail: PLANTED.otherEmail,
      password: PLANTED.password,
      wrongPassword: PLANTED.wrongPassword,
      child: PLANTED.child,
      token: PLANTED.token,
      resetToken: token,
      authSecret: AUTH_SECRET,
      localPart: "guardian.private",
    }))
      expect(output.includes(value), `log contains the planted ${name}`).toBe(
        false,
      );
  });
});

describe("what the logger and the error path do with hostile input", () => {
  it("redacts addresses, links, tokens and numbers from error messages and drops objects", async () => {
    const { apiError } = await import("@/server/http");
    const { log, errorFields } = await import("@/server/log");
    const failure = new Error(
      `could not save (${PLANTED.email}, ${PLANTED.phone}) via https://x.example/r?token=${PLANTED.token} Bearer ${PLANTED.token}`,
    );
    const response = apiError(
      failure,
      new Request(
        "https://academy.sportozen.app/api/workspaces/a/records/player",
        {
          method: "POST",
          headers: { "x-request-id": "req-hostile-0001" },
          body: JSON.stringify({ name: PLANTED.child, phone: PLANTED.phone }),
        },
      ),
    );
    expect(response.status).toBe(500);
    log("info", "test.event", {
      nested: { email: PLANTED.email } as never,
      note: `email ${PLANTED.email} phone ${PLANTED.phone}`,
      requestId: "req-visible-0002",
      userId: "user_AbC123xyz",
    });
    log("warn", "test.error", errorFields(failure));
    // The realistic leak: a library error that quotes the data it choked on.
    let parseError: unknown;
    try {
      JSON.parse(`${PLANTED.child} ${PLANTED.phone} is not json`);
    } catch (error) {
      parseError = error;
    }
    // Node quotes the start of the text it could not parse.
    expect(String((parseError as Error).message)).toContain("Aarav");
    log("error", "test.parse_failed", errorFields(parseError));
    apiError(parseError, new Request("https://academy.sportozen.app/api/x"));
    const output = lines.join("\n");
    for (const value of [
      PLANTED.email,
      PLANTED.phone,
      PLANTED.token,
      "x.example",
      "Aarav",
      "guardian.private",
    ])
      if (value) expect(output.includes(value), value).toBe(false);
    // The request id and an opaque user id survive redaction; the body was never read.
    expect(output).toContain('"requestId":"req-hostile-0001"');
    expect(output).toContain('"requestId":"req-visible-0002"');
    expect(output).toContain('"userId":"user_AbC123xyz"');
    expect(output).toContain('"event":"request.failed"');
    expect(output).toContain("[email]");
    expect(output).toContain("[link]");
    expect(output).not.toContain("nested");
  });
  it("lets an event name and fields be written but never override the envelope", async () => {
    const { log } = await import("@/server/log");
    log("info", "x.y", {
      ts: "forged",
      level: "error",
      event: "forged",
    } as never);
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("x.y");
    expect(entry.ts).not.toBe("forged");
  });
});

describe("startup diagnostics", () => {
  it("states the release and settings and never a secret, path or address", async () => {
    vi.resetModules();
    process.env.SPORTOZEN_TRUSTED_PROXIES = "10.0.0.0/8";
    const { logStartup } = await import("@/server/startup-diagnostics");
    logStartup();
    delete process.env.SPORTOZEN_TRUSTED_PROXIES;
    const line = lines.find((l) => l.includes('"event":"app.started"'))!;
    expect(line).toBeTruthy();
    const started = JSON.parse(line);
    expect(started).toMatchObject({
      level: "info",
      csp: "enforce",
      mfa: "off",
      emailTransport: "capture",
      passwordRecovery: true,
      sessionMaxHours: 8,
      sessionIdleMinutes: 0,
      trustedProxiesConfigured: true,
      httpsDeployment: true,
      ready: true,
    });
    expect(started.node).toMatch(/^v24\./);
    for (const forbidden of [
      AUTH_SECRET,
      filename,
      "10.0.0.0",
      "notifications@",
      "example.org",
    ])
      expect(line.includes(forbidden), forbidden).toBe(false);
  });
});
