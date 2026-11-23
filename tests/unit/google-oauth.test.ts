// Google sign-in through the real Better Auth handler configured by
// src/server/auth.ts, with a STAND-IN for Google: the one network call Better
// Auth makes to Google (the token exchange) is answered locally, and the
// authorization step is played by the test (it reads the URL Better Auth
// builds and returns to the callback with a code). Nothing reaches Google, no
// credential is real, no mail is sent.
import {
  afterAll,
  beforeAll,
  beforeEach,
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
// or the TEST variable is truthy. Run this file the way production runs.
vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.TEST = "";
});
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = "https://academy.sportozen.app";
const CLIENT_ID = "stand-in-client.apps.googleusercontent.com";
const CLIENT_SECRET = `stand-in-secret-${randomUUID()}`;
const PASSWORD = "correct horse battery staple 1";
const SETTINGS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SPORTOZEN_EMAIL_TRANSPORT",
  "SPORTOZEN_EMAIL_FROM",
  "SPORTOZEN_EMAIL_VERIFICATION",
  "SPORTOZEN_PASSWORD_RECOVERY",
  "SPORTOZEN_MFA",
];
const GOOGLE_ON = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
};
const VERIFYING = {
  SPORTOZEN_EMAIL_TRANSPORT: "capture",
  SPORTOZEN_EMAIL_FROM: "Sportozen <notifications@academy.sportozen.app>",
  SPORTOZEN_EMAIL_VERIFICATION: "required",
};
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();

type Claims = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
};
const codeFor = (claims: Claims) =>
  Buffer.from(
    JSON.stringify({ email_verified: true, name: "Google Person", ...claims }),
  ).toString("base64url");
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** An ID token as the token endpoint would return it. Better Auth reads its
 * claims from the response of its own TLS call to Google; there is no signature
 * to check on this path, so the stand-in does not sign. */
const unsigned = (claims: Record<string, unknown>) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.stand-in`;

/** Every request the stand-in saw. */
const tokenExchanges: {
  body: URLSearchParams;
  headers: Headers;
}[] = [];
const outside: string[] = [];
function standInForGoogle() {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(
      input instanceof Request ? input.url : (input as URL | string),
    );
    if (url !== "https://oauth2.googleapis.com/token") {
      outside.push(url);
      throw new Error(`Unexpected network call to ${url}`);
    }
    const body = new URLSearchParams(String(init?.body ?? ""));
    tokenExchanges.push({ body, headers: new Headers(init?.headers) });
    const code = body.get("code") ?? "";
    if (code === "rejected" || code === "")
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const claims = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: "stand-in-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: unsigned({
        iss: "https://accounts.google.com",
        aud: body.get("client_id"),
        iat: now,
        exp: now + 3600,
        ...claims,
      }),
    });
  });
}

class Jar {
  private cookies = new Map<string, string>();
  absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0]!,
        at = pair.indexOf("="),
        name = pair.slice(0, at),
        value = pair.slice(at + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get names() {
    return [...this.cookies.keys()];
  }
  get empty() {
    return this.cookies.size === 0;
  }
}

let hop = 0;
let boots = 0;
async function boot(env: Record<string, string>) {
  for (const key of SETTINGS) delete process.env[key];
  Object.assign(process.env, env);
  process.env.SPORTOZEN_DATABASE_PATH = join(
    tmpdir(),
    `sportozen-google-${randomUUID()}.sqlite`,
  );
  files.push(process.env.SPORTOZEN_DATABASE_PATH);
  boots++;
  vi.resetModules();
  standInForGoogle();
  const { authentication } = await import("@/server/auth");
  const { database } = await import("@/server/database");
  closers.push(() => database().close());
  const auth = await authentication();
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; jar?: Jar; extra?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}`,
    };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers.origin = ORIGIN;
    }
    if (options.jar && !options.jar.empty) headers.cookie = options.jar.header;
    Object.assign(headers, options.extra);
    const response = await auth.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
      }),
    );
    options.jar?.absorb(response);
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { response, status: response.status, text, json };
  };
  /** The button's request and the redirect to Google. */
  const start = async (jar: Jar, body: unknown = google) => {
    const started = await call("POST", "/api/auth/sign-in/social", {
      body,
      jar,
    });
    const url = started.json?.url ? new URL(String(started.json.url)) : null;
    return { ...started, url };
  };
  /** Google returning to the callback. */
  const back = async (
    jar: Jar,
    query: Record<string, string>,
    extra?: Record<string, string>,
  ) => {
    const result = await call(
      "GET",
      `/api/auth/callback/google?${new URLSearchParams(query)}`,
      { jar, extra },
    );
    return { ...result, location: result.response.headers.get("location") };
  };
  /** The whole thing: click, Google, callback. */
  const googleSignIn = async (claims: Claims, jar = new Jar()) => {
    const started = await start(jar);
    expect(started.url, "Better Auth returns Google's address").not.toBeNull();
    const finished = await back(jar, {
      code: codeFor(claims),
      state: started.url!.searchParams.get("state")!,
    });
    return { jar, started, ...finished };
  };
  const session = async (jar: Jar) => {
    const result = await call("GET", "/api/auth/get-session", { jar });
    return result.json as {
      user: { id: string; email: string; emailVerified: boolean };
      session: { token: string };
    } | null;
  };
  const register = async (email: string, name = "Local Person") => {
    const result = await call("POST", "/api/auth/sign-up/email", {
      body: { email, password: PASSWORD, name },
    });
    expect(result.status, result.text).toBe(200);
    return String((result.json as { user: { id: string } }).user.id);
  };
  const passwordSignIn = (email: string, jar = new Jar()) =>
    call("POST", "/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
      jar,
    }).then((r) => ({ ...r, jar }));
  const verify = (email: string) =>
    database()
      .prepare('UPDATE "user" SET emailVerified=1 WHERE email=?')
      .run(email);
  const users = (email: string) =>
    database()
      .prepare(
        'SELECT id,emailVerified,twoFactorEnabled FROM "user" WHERE email=?',
      )
      .all(email.toLowerCase());
  const accounts = (userId: string) =>
    database()
      .prepare(
        "SELECT providerId,accountId,password FROM account WHERE userId=? ORDER BY providerId",
      )
      .all(userId);
  const count = (table: string) =>
    Number(database().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n);
  return {
    auth,
    call,
    start,
    back,
    googleSignIn,
    session,
    register,
    passwordSignIn,
    verify,
    users,
    accounts,
    count,
    database,
  };
}
type App = Awaited<ReturnType<typeof boot>>;
const google = { provider: "google", callbackURL: "/workspace" };
const files: string[] = [];
const closers: (() => void)[] = [];
const email = (label: string) =>
  `${label}.${randomUUID().slice(0, 8)}@example.test`;
const sub = () => `g-${randomUUID()}`;
const GOOGLE_ERROR = "/sign-in?source=google&error=";
/** A redirect back to the sign-in screen, without any description text. */
const refusal = (location: string | null) => {
  if (!location) return location;
  const url = new URL(location, ORIGIN);
  return `${url.pathname}?source=${url.searchParams.get("source")}&error=${url.searchParams.get("error")}`;
};

afterAll(() => {
  vi.unstubAllGlobals();
  // Close every database this file opened before deleting it (Windows will not
  // delete an open file).
  for (const close of closers)
    try {
      close();
    } catch {
      // already closed
    }
  for (const file of files)
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(file + suffix, { force: true });
});

describe("configuration", () => {
  it("is off without the two variables: no provider, the button's request is refused, nothing else changes", async () => {
    const app = await boot({});
    const result = await app.start(new Jar());
    expect(result.status).toBe(404);
    expect(result.url).toBeNull();
    // Password sign-up and sign-in are as before.
    const address = email("plain");
    await app.register(address);
    expect((await app.passwordSignIn(address)).status).toBe(200);
  });
  it("refuses to start with only one of the two variables", async () => {
    const { googleOAuthConfig } = await import("@/server/google-oauth");
    expect(googleOAuthConfig({})).toBeNull();
    expect(
      googleOAuthConfig({ GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "" }),
    ).toBeNull();
    expect(() => googleOAuthConfig({ GOOGLE_CLIENT_ID: "x" })).toThrow(
      /both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
    );
    expect(() => googleOAuthConfig({ GOOGLE_CLIENT_SECRET: "x" })).toThrow(
      /both/,
    );
    expect(
      googleOAuthConfig({
        GOOGLE_CLIENT_ID: " id ",
        GOOGLE_CLIENT_SECRET: " s ",
      }),
    ).toEqual({ clientId: "id", clientSecret: "s" });
    // The screen asks only a yes/no question and never fails on a half setting.
    process.env.GOOGLE_CLIENT_ID = "only-one";
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { googleSignInAvailable } = await import("@/server/google-oauth");
    expect(googleSignInAvailable()).toBe(false);
    delete process.env.GOOGLE_CLIENT_ID;
  });
});

describe("the request the button makes", () => {
  let app: App;
  let baseline = 0;
  beforeAll(async () => {
    app = await boot(GOOGLE_ON);
  });
  beforeEach(() => {
    baseline = app.count("user");
  });

  it("builds Google's authorization address with PKCE and a state, and never puts the secret in it", async () => {
    const { url, status, text } = await app.start(new Jar());
    expect(status).toBe(200);
    expect(url!.origin + url!.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const q = url!.searchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(q.get("state")).toMatch(/\S{20,}/);
    expect(q.get("prompt")).toBe("select_account");
    expect(q.get("scope")!.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(q.has("include_granted_scopes")).toBe(false);
    expect(url!.toString() + text).not.toContain(CLIENT_SECRET);
  });
  it("understands only the button's own two fields: scopes, hints, role, academy and extra destinations are refused", async () => {
    for (const extra of [
      { scopes: ["https://www.googleapis.com/auth/drive"] },
      { loginHint: "victim@example.test" },
      { requestSignUp: true },
      { role: "OWNER" },
      { academyId: "academy-1" },
      { additionalData: { role: "OWNER" } },
      { newUserCallbackURL: "/elsewhere" },
      { errorCallbackURL: "/not-the-sign-in-page" },
      { disableRedirect: true },
    ]) {
      const result = await app.start(new Jar(), {
        provider: "google",
        callbackURL: "/workspace",
        ...extra,
      });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect(result.url).toBeNull();
    }
    expect(app.count("user")).toBe(baseline);
  });
  it("fixes the destinations: whatever callbackURL says, a success lands on /workspace and a failure on the sign-in screen", async () => {
    const jar = new Jar();
    const googleId = sub();
    const address = email("fixed");
    const { url } = await app.start(jar, {
      provider: "google",
      callbackURL: "/somewhere-else",
    });
    expect(url, "the request is understood").not.toBeNull();
    const finished = await app.back(jar, {
      code: codeFor({ sub: googleId, email: address }),
      state: url!.searchParams.get("state")!,
    });
    expect(finished.location).toBe("/workspace");
    // The same for a person who is already known (a different redirect is used).
    const returning = new Jar();
    const third = await app.start(returning, {
      provider: "google",
      callbackURL: "/somewhere-else",
    });
    expect(
      (
        await app.back(returning, {
          code: codeFor({ sub: googleId, email: address }),
          state: third.url!.searchParams.get("state")!,
        })
      ).location,
    ).toBe("/workspace");
    const again = new Jar();
    const second = await app.start(again, {
      provider: "google",
      callbackURL: "/somewhere-else",
    });
    const failed = await app.back(again, {
      error: "access_denied",
      state: second.url!.searchParams.get("state")!,
    });
    expect(refusal(failed.location)).toBe(`${GOOGLE_ERROR}access_denied`);
  });
  it("refuses a destination on another site before anything starts", async () => {
    for (const field of [
      "callbackURL",
      "newUserCallbackURL",
      "errorCallbackURL",
    ]) {
      const result = await app.start(new Jar(), {
        provider: "google",
        [field]: "https://evil.example/steal",
      });
      expect(result.status, field).toBeGreaterThanOrEqual(400);
      expect(result.url, field).toBeNull();
    }
  });
  it("refuses other providers and a browser-supplied ID token", async () => {
    const other = await app.call("POST", "/api/auth/sign-in/social", {
      body: { provider: "github", callbackURL: "/workspace" },
    });
    expect(other.status).toBe(400);
    const idToken = await app.call("POST", "/api/auth/sign-in/social", {
      body: {
        provider: "google",
        idToken: { token: unsigned({ sub: "x", email: "x@example.test" }) },
      },
    });
    expect(idToken.status).toBe(400);
    expect(app.count("user")).toBe(baseline);
  });
  it("only starts from this application's own pages: another site, or no Origin at all, is refused", async () => {
    for (const origin of [
      "https://evil.example",
      "http://academy.sportozen.app",
      "",
    ]) {
      const result = await app.call("POST", "/api/auth/sign-in/social", {
        body: google,
        extra: { origin },
      });
      expect(result.status, origin).toBe(403);
      expect(result.json?.url, origin).toBeUndefined();
    }
  });
});

describe("new Google users", () => {
  let app: App;
  beforeAll(async () => {
    app = await boot(GOOGLE_ON);
  });

  it("opens an account with no role and no academy, then lands on /workspace", async () => {
    const address = email("new");
    const googleId = sub();
    const { jar, location, status } = await app.googleSignIn({
      sub: googleId,
      email: address,
      name: "Nina New",
    });
    expect(status).toBe(302);
    expect(location).toBe("/workspace");
    const me = await app.session(jar);
    expect(me!.user.email).toBe(address);
    expect(me!.user.emailVerified).toBe(true);
    const [row] = app.users(address);
    expect(app.users(address)).toHaveLength(1);
    // One Google account row, no password.
    expect(app.accounts(String(row.id))).toEqual([
      { providerId: "google", accountId: googleId, password: null },
    ]);
    // No authority comes with the account.
    const db = app.database();
    for (const table of ["academy_memberships", "platform_administrators"])
      expect(
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE userId=?`)
          .get(String(row.id))!.n,
      ).toBe(0);
    const academies = await listWorkspaces(app, jar);
    expect(academies.status).toBe(200);
    expect(academies.body.workspaces).toEqual([]);
  });
  it("exchanged the code with the secret, the PKCE verifier and the exact redirect address, once", async () => {
    tokenExchanges.length = 0;
    await app.googleSignIn({ sub: sub(), email: email("exchange") });
    expect(tokenExchanges).toHaveLength(1);
    const body = tokenExchanges[0]!.body;
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
    expect(outside).toEqual([]);
  });
  it("is refused when Google has not confirmed the address; nothing is created", async () => {
    const address = email("unconfirmed");
    const before = app.count("user");
    const result = await app.googleSignIn({
      sub: sub(),
      email: address,
      email_verified: false,
    });
    expect(refusal(result.location)).toBe(`${GOOGLE_ERROR}email_not_verified`);
    expect(result.jar.names.filter((n) => /session_token/.test(n))).toEqual([]);
    expect(app.count("user")).toBe(before);
    expect(app.users(address)).toHaveLength(0);
  });
  it("cannot sign a person in twice into two accounts: the same Google identity, or the same address in another case, is one account", async () => {
    const googleId = sub();
    const address = email("dup");
    await app.googleSignIn({ sub: googleId, email: address });
    await app.googleSignIn({ sub: googleId, email: address });
    await app.googleSignIn({ sub: googleId, email: address.toUpperCase() });
    expect(app.users(address)).toHaveLength(1);
    expect(app.accounts(String(app.users(address)[0]!.id))).toHaveLength(1);
  });
  it("makes one account when the very same sign-in finishes twice at the same moment", async () => {
    const address = email("race");
    const googleId = sub();
    const results = await Promise.all(
      [0, 1, 2].map(() => app.googleSignIn({ sub: googleId, email: address })),
    );
    expect(app.users(address)).toHaveLength(1);
    expect(app.accounts(String(app.users(address)[0]!.id))).toHaveLength(1);
    // At least one of them is signed in; none left a half-made account.
    const signedIn = await Promise.all(results.map((r) => app.session(r.jar)));
    expect(signedIn.some(Boolean)).toBe(true);
  });
});

describe("an existing e-mail and password account", () => {
  describe("with e-mail verification not required (the local default)", () => {
    verifiedAndUnverified({});
  });
  describe("with e-mail verification required", () => {
    verifiedAndUnverified(VERIFYING);
  });
});
function verifiedAndUnverified(extra: Record<string, string>) {
  let app: App;
  beforeAll(async () => {
    app = await boot({ ...GOOGLE_ON, ...extra });
  });
  const hash = (id: string) =>
    String(
      app.accounts(id).find((a) => a.providerId === "credential")!.password,
    );

  it("is linked when its address is already verified, and keeps its password", async () => {
    const address = email("verified");
    const id = await app.register(address);
    app.verify(address);
    const passwordBefore = hash(id);
    const googleId = sub();
    const { jar, location } = await app.googleSignIn({
      sub: googleId,
      email: address,
    });
    expect(location).toBe("/workspace");
    expect(app.users(address)).toHaveLength(1);
    expect((await app.session(jar))!.user.id).toBe(id);
    expect(app.accounts(id).map((a) => a.providerId)).toEqual([
      "credential",
      "google",
    ]);
    expect(hash(id)).toBe(passwordBefore);
    expect((await app.passwordSignIn(address)).status).toBe(200);
    // A second sign-in with Google just signs in.
    const again = await app.googleSignIn({ sub: googleId, email: address });
    expect(again.location).toBe("/workspace");
    expect(app.accounts(id)).toHaveLength(2);
  });
  it("is NOT linked when its address is unverified: no link, still unverified, password untouched, a clear error", async () => {
    const address = email("unverified");
    const id = await app.register(address);
    const passwordBefore = hash(id);
    // Registering signs the person in with the password: that one session is not Google's.
    const sessionsBefore = Number(
      app
        .database()
        .prepare("SELECT COUNT(*) AS n FROM session WHERE userId=?")
        .get(id)!.n,
    );
    const attempt = await app.googleSignIn({ sub: sub(), email: address });
    expect(refusal(attempt.location)).toBe(`${GOOGLE_ERROR}account_not_linked`);
    // No session of any kind was created.
    expect(attempt.jar.names.filter((n) => /session_token/.test(n))).toEqual(
      [],
    );
    expect(
      Number(
        app
          .database()
          .prepare("SELECT COUNT(*) AS n FROM session WHERE userId=?")
          .get(id)!.n,
      ),
    ).toBe(sessionsBefore);
    // Nothing about the account changed.
    expect(app.users(address)).toHaveLength(1);
    expect(Number(app.users(address)[0]!.emailVerified)).toBe(0);
    expect(app.accounts(id).map((a) => a.providerId)).toEqual(["credential"]);
    expect(hash(id)).toBe(passwordBefore);
    // The password still works (or, with verification required, asks for it).
    const signIn = await app.passwordSignIn(address);
    expect(signIn.status).toBe(extra.SPORTOZEN_EMAIL_VERIFICATION ? 403 : 200);
    // And the screen explains what to do (the message the error code selects).
    const { googleErrorMessage } =
      await import("@/services/google-sign-in-errors");
    const message = googleErrorMessage("account_not_linked", {
      verificationRequired: !!extra.SPORTOZEN_EMAIL_VERIFICATION,
    });
    expect(message).toMatch(/already exists/);
    expect(message).toMatch(/not been confirmed/);
    expect(message).toMatch(/email and password/);
    expect(message).toMatch(
      extra.SPORTOZEN_EMAIL_VERIFICATION
        ? /confirmation link/
        : /platform administrator/,
    );
  });
  it("is linked once its address has been verified, after an earlier refusal", async () => {
    const address = email("later");
    const id = await app.register(address);
    const googleId = sub();
    expect(
      refusal(
        (await app.googleSignIn({ sub: googleId, email: address })).location,
      ),
    ).toBe(`${GOOGLE_ERROR}account_not_linked`);
    app.verify(address);
    const retry = await app.googleSignIn({ sub: googleId, email: address });
    expect(retry.location).toBe("/workspace");
    expect(app.accounts(id).map((a) => a.providerId)).toEqual([
      "credential",
      "google",
    ]);
  });
  it("is not linked when Google itself has not confirmed the address, even if the account is verified", async () => {
    const address = email("googleunverified");
    const id = await app.register(address);
    app.verify(address);
    const attempt = await app.googleSignIn({
      sub: sub(),
      email: address,
      email_verified: false,
    });
    expect(attempt.location).toMatch(
      /error=(account_not_linked|email_not_verified)$/,
    );
    expect(app.accounts(id).map((a) => a.providerId)).toEqual(["credential"]);
  });
  it("cannot be linked by a signed-in person from the API either (the only way is signing in with Google)", async () => {
    const address = email("linkapi");
    await app.register(address);
    app.verify(address);
    const signedIn = await app.passwordSignIn(address);
    const result = await app.call("POST", "/api/auth/link-social", {
      body: { provider: "google", callbackURL: "/workspace" },
      jar: signedIn.jar,
    });
    expect(result.status).toBe(403);
  });
}

describe("a person who uses two-step verification", () => {
  it("must sign in with the password and code: Google would skip the second step", async () => {
    const app = await boot(GOOGLE_ON);
    // Already linked, then two-step turned on.
    const linked = email("twostep-linked");
    const googleId = sub();
    await app.googleSignIn({ sub: googleId, email: linked });
    app
      .database()
      .prepare('UPDATE "user" SET twoFactorEnabled=1 WHERE email=?')
      .run(linked);
    const refused = await app.googleSignIn({ sub: googleId, email: linked });
    expect(refusal(refused.location)).toBe(`${GOOGLE_ERROR}two_step_required`);
    expect(refused.jar.names.filter((n) => /session_token/.test(n))).toEqual(
      [],
    );
    // A verified password account with two-step on is not linked either.
    const local = email("twostep-local");
    const id = await app.register(local);
    app.verify(local);
    app
      .database()
      .prepare('UPDATE "user" SET twoFactorEnabled=1 WHERE email=?')
      .run(local);
    const second = await app.googleSignIn({ sub: sub(), email: local });
    expect(refusal(second.location)).toBe(`${GOOGLE_ERROR}two_step_required`);
    expect(app.accounts(id).map((a) => a.providerId)).toEqual(["credential"]);
  });
});

describe("failed, cancelled and forged callbacks", () => {
  let app: App;
  let baseline = 0;
  beforeAll(async () => {
    app = await boot(GOOGLE_ON);
  });
  beforeEach(() => {
    baseline = app.count("user");
  });
  const noSession = (jar: Jar) =>
    expect(jar.names.filter((n) => /session_token/.test(n))).toEqual([]);

  it("cancelled at Google (access_denied) returns to the sign-in screen without a session", async () => {
    const jar = new Jar();
    const { url } = await app.start(jar);
    const result = await app.back(jar, {
      error: "access_denied",
      state: url!.searchParams.get("state")!,
    });
    expect(refusal(result.location)).toBe(`${GOOGLE_ERROR}access_denied`);
    noSession(jar);
    expect(app.count("user")).toBe(baseline);
  });
  it("a callback with an invented state is turned away", async () => {
    const jar = new Jar();
    const result = await app.back(jar, {
      code: codeFor({ sub: sub(), email: email("forged") }),
      state: "invented-state-value",
    });
    expect(result.location).toMatch(/^\/sign-in\?source=google&error=[a-z_]+$/);
    noSession(jar);
    expect(app.count("user")).toBe(baseline);
  });
  it("a callback with no state, or no code, is turned away", async () => {
    const jar = new Jar();
    const none = await app.back(jar, {
      code: codeFor({ sub: sub(), email: email("nostate") }),
    });
    expect(none.location).toMatch(/^\/sign-in\?source=google&error=/);
    const { url } = await app.start(jar);
    const noCode = await app.back(jar, {
      state: url!.searchParams.get("state")!,
    });
    expect(refusal(noCode.location)).toBe(`${GOOGLE_ERROR}no_code`);
    noSession(jar);
    expect(app.count("user")).toBe(baseline);
  });
  it("a code Google rejects ends the sign-in, with no account", async () => {
    const jar = new Jar();
    const { url } = await app.start(jar);
    const result = await app.back(jar, {
      code: "rejected",
      state: url!.searchParams.get("state")!,
    });
    expect(refusal(result.location)).toBe(`${GOOGLE_ERROR}invalid_code`);
    noSession(jar);
    expect(app.count("user")).toBe(baseline);
  });
  it("a state works once: replaying the same callback signs nobody in", async () => {
    const jar = new Jar();
    const { url } = await app.start(jar);
    const query = {
      code: codeFor({ sub: sub(), email: email("replay") }),
      state: url!.searchParams.get("state")!,
    };
    expect((await app.back(jar, query)).location).toBe("/workspace");
    const users = app.count("user");
    const again = new Jar();
    const replay = await app.back(again, query);
    expect(replay.location).toMatch(/^\/sign-in\?source=google&error=/);
    noSession(again);
    expect(app.count("user")).toBe(users);
  });
  it("a state started in one browser cannot be finished in another", async () => {
    const victim = new Jar();
    const { url } = await app.start(victim);
    const attacker = new Jar(); // no state cookie
    const result = await app.back(attacker, {
      code: codeFor({ sub: sub(), email: email("fixation") }),
      state: url!.searchParams.get("state")!,
    });
    expect(result.location).toMatch(/^\/sign-in\?source=google&error=/);
    noSession(attacker);
  });
  it("a callback for any other provider name does nothing", async () => {
    const result = await app.call(
      "GET",
      "/api/auth/callback/github?code=x&state=y",
    );
    expect(result.response.headers.get("location") ?? "").toMatch(
      /^\/sign-in\?source=google&error=/,
    );
  });
  it("the sign-in screen shows a fixed message for each code and ignores anything else in the address", async () => {
    const { googleErrorMessage } =
      await import("@/services/google-sign-in-errors");
    const context = { verificationRequired: false };
    for (const code of [
      "access_denied",
      "account_not_linked",
      "two_step_required",
      "email_not_verified",
      "email_not_found",
      "invalid_code",
      "state_mismatch",
      "<script>alert(1)</script>",
    ]) {
      const message = googleErrorMessage(code, context);
      expect(message.length, code).toBeGreaterThan(40);
      expect(message).not.toContain("<");
    }
    expect(googleErrorMessage("anything-else", context)).toBe(
      googleErrorMessage("state_mismatch", context),
    );
  });
});

describe("what is recorded", () => {
  it("writes a refusal to the security log by its code only, and a link to the audit trail", async () => {
    const app = await boot(GOOGLE_ON);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A refusal: the address is not verified.
      const refused = email("recorded-refused");
      const refusedId = await app.register(refused);
      await app.googleSignIn({ sub: sub(), email: refused });
      const lines = warn.mock.calls.map((call) => String(call[0]));
      const entry = lines.find((line) =>
        line.includes("signin.google_refused"),
      );
      expect(entry, "a security line was written").toBeDefined();
      expect(JSON.parse(entry!)).toMatchObject({
        event: "security",
        type: "signin.google_refused",
        reason: "account_not_linked",
      });
      // Never an address, a token or a code.
      expect(lines.join(" ")).not.toContain(refused);
      expect(lines.join(" ")).not.toContain(CLIENT_SECRET);
      const audit = (userId: string) =>
        app
          .database()
          .prepare("SELECT action FROM workspace_audit WHERE userId=?")
          .all(userId)
          .map((row) => String(row.action));
      expect(audit(refusedId)).not.toContain(
        "Google sign-in linked to the account",
      );
      // A link: the address is verified.
      const linked = email("recorded-linked");
      const linkedId = await app.register(linked);
      app.verify(linked);
      await app.googleSignIn({ sub: sub(), email: linked });
      expect(audit(linkedId)).toContain("Google sign-in linked to the account");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("logout, then sign in again", () => {
  it("signs out, the old session is dead, and the next Google sign-in is the same account with a new session", async () => {
    const app = await boot(GOOGLE_ON);
    const address = email("logout");
    const googleId = sub();
    const first = await app.googleSignIn({ sub: googleId, email: address });
    const meBefore = await app.session(first.jar);
    expect(meBefore).not.toBeNull();
    const oldCookie = first.jar.header;
    const out = await app.call("POST", "/api/auth/sign-out", {
      jar: first.jar,
      body: {},
    });
    expect(out.status).toBe(200);
    // The old cookie, replayed, is worth nothing.
    const replay = new Jar();
    const stale = await app.auth.handler(
      new Request(`${ORIGIN}/api/auth/get-session`, {
        headers: { cookie: oldCookie },
      }),
    );
    expect(await stale.text()).toBe("null");
    expect(replay.empty).toBe(true);
    const second = await app.googleSignIn({ sub: googleId, email: address });
    const meAfter = await app.session(second.jar);
    expect(meAfter!.user.id).toBe(meBefore!.user.id);
    expect(meAfter!.session.token).not.toBe(meBefore!.session.token);
    expect(app.users(address)).toHaveLength(1);
  });
});

describe("sessions made by Google are checked like any other", () => {
  let app: App;
  let routes: Awaited<ReturnType<typeof loadRoutes>>;
  beforeAll(async () => {
    app = await boot(GOOGLE_ON);
    routes = await loadRoutes();
  });
  beforeEach(() => {
    app.database().exec("DELETE FROM request_rate_limits");
  });

  /** A Google person, signed in. */
  const person = async (label: string) => {
    const address = email(label);
    const { jar } = await app.googleSignIn({
      sub: sub(),
      email: address,
      name: label,
    });
    return { jar, address };
  };
  const api = (
    jar: Jar,
    method: string,
    path: string,
    params?: Record<string, string>,
    json?: unknown,
  ) => callApi(routes, jar, method, path, params, json);

  async function academyWithPeople() {
    const owner = await person("owner");
    const created = await api(
      owner.jar,
      "POST",
      "/api/workspaces",
      undefined,
      academyBody("Google Academy"),
    );
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    return { owner, id };
  }
  const approve = (id: string, state = "ACTIVE") =>
    app
      .database()
      .prepare(
        "INSERT OR REPLACE INTO academy_lifecycle(academyId,state,version,submissions,updatedAt) VALUES(?,?,5,1,?)",
      )
      .run(id, state, new Date().toISOString());
  const branch = (jar: Jar, id: string) =>
    api(
      jar,
      "POST",
      `/api/workspaces/${id}/records/branch`,
      { academyId: id, kind: "branch" },
      { name: "Main", timezone: "Asia/Kolkata" },
    );

  it("an owner who signs in with Google still waits for academy approval (when the deployment requires a review)", async () => {
    // Direct opening is the default; this test is about the review a deployment switches on.
    vi.stubEnv("SPORTOZEN_ACADEMY_APPROVAL", "required");
    const { owner, id } = await academyWithPeople();
    expect(
      app
        .database()
        .prepare("SELECT state FROM academy_lifecycle WHERE academyId=?")
        .get(id)!.state,
    ).toBe("CONFIGURING");
    const blocked = await branch(owner.jar, id);
    expect(blocked.status).toBe(403);
    approve(id);
    expect((await branch(owner.jar, id)).status).toBe(201);
    // Suspension closes it again for the same session.
    approve(id, "SUSPENDED");
    expect((await branch(owner.jar, id)).status).toBe(403);
  });
  it("a coach and a parent get exactly what their invitation gives, nothing from Google", async () => {
    const { owner, id } = await academyWithPeople();
    approve(id);
    const coachGoogle = await person("coach");
    const parentGoogle = await person("parent");
    // The invitation is for these addresses; the owner is the only one who can issue it.
    const coachInvite = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/actions`,
      { academyId: id },
      { action: "invite", data: { email: coachGoogle.address, role: "COACH" } },
    );
    expect(coachInvite.status, JSON.stringify(coachInvite.body)).toBeLessThan(
      300,
    );
    const coach = String((await app.session(coachGoogle.jar))!.user.id);
    const accepted = await api(
      coachGoogle.jar,
      "POST",
      "/api/invitations/accept",
      undefined,
      { token: coachInvite.body.token },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(
      app
        .database()
        .prepare(
          "SELECT role FROM academy_memberships WHERE academyId=? AND userId=?",
        )
        .get(id, coach)!.role,
    ).toBe("COACH");
    // The coach cannot do what only owners do.
    const notAllowed = await api(
      coachGoogle.jar,
      "POST",
      `/api/workspaces/${id}/actions`,
      { academyId: id },
      { action: "invite", data: { email: email("x"), role: "COACH" } },
    );
    expect(notAllowed.status).toBe(403);
    // A parent is linked to one child and sees only that child.
    const mine = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/records/player`,
      { academyId: id, kind: "player" },
      {
        name: "Linked Child",
        birthDate: "2015-05-05",
        squad: "U12",
        ageCategory: "U12",
        coachId: coach,
        sportIds: ["football"],
        status: "ACTIVE",
      },
    );
    const other = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/records/player`,
      { academyId: id, kind: "player" },
      {
        name: "Someone Else",
        birthDate: "2015-05-05",
        squad: "U12",
        ageCategory: "U12",
        coachId: coach,
        sportIds: ["football"],
        status: "ACTIVE",
      },
    );
    expect(mine.status).toBe(201);
    expect(other.status).toBe(201);
    const parentInvite = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/actions`,
      { academyId: id },
      {
        action: "invite",
        data: {
          email: parentGoogle.address,
          role: "PARENT",
          playerIds: [mine.body.id],
          guardianVerified: true,
        },
      },
    );
    expect(parentInvite.status, JSON.stringify(parentInvite.body)).toBeLessThan(
      300,
    );
    expect(
      (
        await api(
          parentGoogle.jar,
          "POST",
          "/api/invitations/accept",
          undefined,
          { token: parentInvite.body.token },
        )
      ).status,
    ).toBe(200);
    const view = await api(
      parentGoogle.jar,
      "GET",
      `/api/workspaces/${id}/records/player`,
      { academyId: id, kind: "player" },
    );
    expect(view.status).toBe(200);
    const names = (view.body as unknown as { name: string }[]).map(
      (p) => p.name,
    );
    expect(names).toEqual(["Linked Child"]);
    expect(JSON.stringify(view.body)).not.toContain("Someone Else");
    // Parents cannot configure the academy.
    expect((await branch(parentGoogle.jar, id)).status).toBe(403);
  });
  it("an invitation cannot be used by a different Google address, or without one", async () => {
    const { owner, id } = await academyWithPeople();
    approve(id);
    const invited = email("invited");
    const invite = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/actions`,
      { academyId: id },
      { action: "invite", data: { email: invited, role: "COACH" } },
    );
    const stranger = await person("stranger");
    const attempt = await api(
      stranger.jar,
      "POST",
      "/api/invitations/accept",
      undefined,
      { token: invite.body.token },
    );
    expect(attempt.status).toBe(403);
    // And a Google person with no invitation sees no academy at all.
    expect((await listWorkspaces(app, stranger.jar)).body.workspaces).toEqual(
      [],
    );
    expect(
      (
        await api(stranger.jar, "GET", `/api/workspaces/${id}`, {
          academyId: id,
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
  });
  it("academies stay separate: another academy's owner and coach see nothing of this one", async () => {
    const one = await academyWithPeople();
    const two = await academyWithPeople();
    approve(one.id);
    approve(two.id);
    for (const [who, other] of [
      [one.owner, two.id],
      [two.owner, one.id],
    ] as const) {
      const read = await api(who.jar, "GET", `/api/workspaces/${other}`, {
        academyId: other,
      });
      expect([403, 404]).toContain(read.status);
      expect((await branch(who.jar, other)).status).toBeGreaterThanOrEqual(403);
    }
  });
  it("a membership that was removed stops working at once, for the same Google session", async () => {
    const { owner, id } = await academyWithPeople();
    approve(id);
    const coachGoogle = await person("removed");
    const invite = await api(
      owner.jar,
      "POST",
      `/api/workspaces/${id}/actions`,
      { academyId: id },
      { action: "invite", data: { email: coachGoogle.address, role: "COACH" } },
    );
    await api(coachGoogle.jar, "POST", "/api/invitations/accept", undefined, {
      token: invite.body.token,
    });
    expect(
      (
        await api(coachGoogle.jar, "GET", `/api/workspaces/${id}`, {
          academyId: id,
        })
      ).status,
    ).toBe(200);
    app
      .database()
      .prepare("UPDATE academy_memberships SET active=0 WHERE academyId=?")
      .run(id);
    // Only the coach's membership was switched off here; the owner's too, so both are shut out.
    expect(
      (
        await api(coachGoogle.jar, "GET", `/api/workspaces/${id}`, {
          academyId: id,
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
  });
});

describe("the staff two-step rule applies to Google sign-ins as to any other", () => {
  it("a new Google person cannot create an academy until two-step verification is on", async () => {
    const app = await boot({ ...GOOGLE_ON, SPORTOZEN_MFA: "staff" });
    const routes = await loadRoutes();
    const { jar } = await app.googleSignIn({ sub: sub(), email: email("mfa") });
    const created = await callApi(
      routes,
      jar,
      "POST",
      "/api/workspaces",
      undefined,
      academyBody("Needs MFA"),
    );
    expect(created.status).toBe(403);
    expect(created.body.code).toBe("MFA_REQUIRED");
  });
  it("with e-mail verification required, a Google person (verified by Google) may create one, a password person who never verified may not", async () => {
    const app = await boot({ ...GOOGLE_ON, ...VERIFYING });
    const routes = await loadRoutes();
    const { jar } = await app.googleSignIn({ sub: sub(), email: email("gv") });
    app.database().exec("DELETE FROM request_rate_limits");
    expect(
      (
        await callApi(
          routes,
          jar,
          "POST",
          "/api/workspaces",
          undefined,
          academyBody("Verified By Google"),
        )
      ).status,
    ).toBe(201);
    const local = email("pw");
    await app.register(local);
    const signedIn = await app.passwordSignIn(local);
    expect(signedIn.status).toBe(403);
  });
});

// ---- helpers ---------------------------------------------------------------
async function loadRoutes() {
  return {
    workspaces: await import("@/app/api/workspaces/route"),
    workspace: await import("@/app/api/workspaces/[academyId]/route"),
    actions: await import("@/app/api/workspaces/[academyId]/actions/route"),
    records:
      await import("@/app/api/workspaces/[academyId]/records/[kind]/route"),
    accept: await import("@/app/api/invitations/accept/route"),
  };
}
async function callApi(
  routes: Awaited<ReturnType<typeof loadRoutes>>,
  jar: Jar,
  method: string,
  path: string,
  params?: Record<string, string>,
  json?: unknown,
) {
  const handler = (path === "/api/workspaces"
    ? routes.workspaces
    : path === "/api/invitations/accept"
      ? routes.accept
      : path.endsWith("/actions")
        ? routes.actions
        : path.includes("/records/")
          ? routes.records
          : routes.workspace) as unknown as Record<
    string,
    (r: Request, c: unknown) => Promise<Response>
  >;
  const headers: Record<string, string> = {
    "x-forwarded-for": `203.0.113.${(hop++ % 250) + 1}`,
  };
  if (!jar.empty) headers.cookie = jar.header;
  if (method !== "GET") {
    headers.origin = ORIGIN;
    headers["content-type"] = "application/json";
  }
  const response = await handler[method]!(
    new Request(ORIGIN + path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    }),
    { params: Promise.resolve(params ?? {}) },
  );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}
async function listWorkspaces(app: App, jar: Jar) {
  const routes = await loadRoutes();
  void app;
  const result = await callApi(routes, jar, "GET", "/api/workspaces");
  return {
    status: result.status,
    body: result.body as { workspaces: unknown[] },
  };
}
const academyBody = (name: string) => ({
  name,
  contactEmail: "office@example.test",
  country: "IN",
  language: "English",
  currency: "INR",
  timezone: "Asia/Kolkata",
  dateLocale: "en-IN",
  measurementSystem: "METRIC",
  brandAccent: "#008463",
  sportIds: ["football"],
  ageGroups: [],
  reviewFrequency: "Monthly",
  modules: ["development", "reports", "communication", "fees"],
  demo: false,
});
void boots;
