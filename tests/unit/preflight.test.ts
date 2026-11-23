// The production preflight refuses unsafe configuration and never prints a
// secret. Permission checks need POSIX modes and are skipped on Windows; the
// same CLI was run on Linux (see docs/PHASE2_REPORT.md).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  BAKED_HEADERS,
  failed,
  invalidProxyEntries,
  parseNodeVersion,
  runChecks,
} from "../../scripts/lib/preflight.mjs";

type Result = { level: string; name: string; message: string };
const SECRET = "s3cr3t-value-that-is-long-enough-0123456789abcdef";
let root: string, app: string, data: string, database: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sportozen-preflight-"));
  app = join(root, "release");
  data = join(root, "data");
  mkdirSync(app);
  mkdirSync(data);
  if (process.platform !== "win32") chmodSync(data, 0o700);
  database = join(data, "workspaces.sqlite");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const good = (): Record<string, string> => ({
  BETTER_AUTH_URL: "https://academy.sportozen.app",
  BETTER_AUTH_SECRET: SECRET,
  SPORTOZEN_DATABASE_PATH: database,
});
const without = (env: Record<string, string>, name: string) => {
  const copy = { ...env };
  delete copy[name];
  return copy;
};
const check = (
  env: Record<string, string>,
  mode = "start",
  cwd = app,
  nodeVersion = "v24.13.0",
) =>
  runChecks({
    env,
    cwd,
    nodeVersion,
    platform: process.platform,
    mode,
  }) as Result[];
const failures = (env: Record<string, string>, mode?: string, cwd?: string) =>
  failed(check(env, mode, cwd)).map((r: Result) => r.name);

describe("preflight configuration checks", () => {
  it("accepts a complete production configuration", () => {
    expect(failures(good())).toEqual([]);
  });
  it.each([
    ["http", "http://academy.sportozen.app"],
    ["a path", "https://academy.sportozen.app/app"],
    ["localhost", "https://localhost"],
    ["an IP address", "https://203.0.113.10"],
    ["a placeholder domain", "https://academy.example.com"],
    ["a .invalid domain", "https://app.sportozen.invalid"],
    ["credentials", ["https://user", "pass@academy.sportozen.app"].join(":")],
    ["not a URL", "academy"],
  ])("rejects BETTER_AUTH_URL with %s", (_label, url) => {
    expect(failures({ ...good(), BETTER_AUTH_URL: url })).toContain(
      "BETTER_AUTH_URL",
    );
  });
  it("rejects a missing, short or placeholder secret without printing it", () => {
    expect(failures(without(good(), "BETTER_AUTH_SECRET"))).toContain(
      "BETTER_AUTH_SECRET",
    );
    expect(failures({ ...good(), BETTER_AUTH_SECRET: "short" })).toContain(
      "BETTER_AUTH_SECRET",
    );
    expect(
      failures({ ...good(), BETTER_AUTH_SECRET: "changeme".repeat(6) }),
    ).toContain("BETTER_AUTH_SECRET");
    expect(JSON.stringify(check(good()))).not.toContain(SECRET);
  });
  it("requires the database on absolute persistent storage outside the app", () => {
    expect(failures(without(good(), "SPORTOZEN_DATABASE_PATH"))).toContain(
      "SPORTOZEN_DATABASE_PATH",
    );
    for (const path of [
      ".local/workspaces.sqlite",
      join(app, "db.sqlite"),
      join(root, "missing", "db.sqlite"),
    ])
      expect(failures({ ...good(), SPORTOZEN_DATABASE_PATH: path })).toContain(
        "SPORTOZEN_DATABASE_PATH",
      );
  });
  it.skipIf(process.platform === "win32")(
    "rejects a database directory or file readable by everyone",
    () => {
      const open = join(root, "open");
      mkdirSync(open);
      chmodSync(open, 0o755);
      expect(
        failures({
          ...good(),
          SPORTOZEN_DATABASE_PATH: join(open, "d.sqlite"),
        }),
      ).toContain("SPORTOZEN_DATABASE_PATH");
      writeFileSync(database, "x");
      chmodSync(database, 0o644);
      expect(failures(good())).toContain("SPORTOZEN_DATABASE_PATH");
      chmodSync(database, 0o600);
      expect(failures(good())).toEqual([]);
      rmSync(database);
    },
  );
  it("refuses a build that carries a QA flag", () => {
    for (const flag of [
      "SPORTOZEN_QA_BUILD",
      "SPORTOZEN_GALLERY_QA",
      "SPORTOZEN_FINAL_QA",
      "SPORTOZEN_HOME_UI_QA",
    ])
      expect(failures({ ...good(), [flag]: "1" })).toContain("QA flags");
  });
  it("accepts only supported Node versions", () => {
    const run = (version: string) =>
      failed(check(good(), "start", app, version)).map((r: Result) => r.name);
    expect(run("v24.13.0")).toEqual([]);
    expect(run("v24.14.2")).toEqual([]);
    expect(run("v24.12.9")).toContain("node");
    expect(run("v22.20.0")).toContain("node");
    expect(run("v25.0.0")).toContain("node");
    expect(parseNodeVersion("v24.13.0")).toEqual([24, 13, 0]);
  });
  it("validates trusted proxies and the client IP header", () => {
    expect(
      invalidProxyEntries("10.0.0.0/8, 192.168.1.5, ::1, fd00::/8"),
    ).toEqual([]);
    expect(invalidProxyEntries("10.0.0.0/33")).toEqual(["10.0.0.0/33"]);
    expect(invalidProxyEntries("nope, 1.2.3.4/8/9")).toHaveLength(2);
    expect(failures({ ...good(), SPORTOZEN_TRUSTED_PROXIES: "bad" })).toContain(
      "SPORTOZEN_TRUSTED_PROXIES",
    );
    expect(
      failures({ ...good(), SPORTOZEN_CLIENT_IP_HEADER: "x forwarded" }),
    ).toContain("SPORTOZEN_CLIENT_IP_HEADER");
  });
  it("validates the write limit", () => {
    expect(
      failures({ ...good(), SPORTOZEN_WRITE_LIMIT_PER_MINUTE: "0" }),
    ).toContain("SPORTOZEN_WRITE_LIMIT_PER_MINUTE");
    expect(
      failures({ ...good(), SPORTOZEN_WRITE_LIMIT_PER_MINUTE: "500" }),
    ).toEqual([]);
  });
  it("validates the account settings (two-step policy, session limits, sign-in limit)", () => {
    expect(failures({ ...good(), SPORTOZEN_MFA: "staff" })).toEqual([]);
    expect(failures({ ...good(), SPORTOZEN_MFA: "sometimes" })).toContain(
      "SPORTOZEN_MFA",
    );
    expect(
      failures({ ...good(), SPORTOZEN_SESSION_MAX_HOURS: "100" }),
    ).toContain("SPORTOZEN_SESSION_MAX_HOURS");
    expect(
      failures({ ...good(), SPORTOZEN_SESSION_IDLE_MINUTES: "2" }),
    ).toContain("SPORTOZEN_SESSION_IDLE_MINUTES");
    expect(
      failures({
        ...good(),
        SPORTOZEN_SESSION_MAX_HOURS: "1",
        SPORTOZEN_SESSION_IDLE_MINUTES: "90",
      }),
    ).toContain("SPORTOZEN_SESSION_IDLE_MINUTES");
    expect(
      failures({
        ...good(),
        SPORTOZEN_SESSION_MAX_HOURS: "8",
        SPORTOZEN_SESSION_IDLE_MINUTES: "30",
        SPORTOZEN_SIGNIN_FAILURE_LIMIT: "10",
      }),
    ).toEqual([]);
    expect(
      failures({ ...good(), SPORTOZEN_SIGNIN_FAILURE_LIMIT: "0" }),
    ).toContain("SPORTOZEN_SIGNIN_FAILURE_LIMIT");
  });
  it("validates the content security policy mode and warns when it is not enforced", () => {
    expect(failures({ ...good(), SPORTOZEN_CSP: "enforce" })).toEqual([]);
    expect(failures({ ...good(), SPORTOZEN_CSP: "sometimes" })).toContain(
      "SPORTOZEN_CSP",
    );
    expect(failures({ ...good(), SPORTOZEN_CSP: "report-only" })).toEqual([]);
  });
  it("warns about malformed alert settings but never blocks a start because of them", () => {
    const named = (env: Record<string, string>) =>
      check(env)
        .filter((r: Result) => r.level === "WARN")
        .map((r: Result) => r.name);
    expect(failures({ ...good() })).toEqual([]);
    for (const bad of [] as Record<string, string>[]) void bad;
    for (const bad of <Record<string, string>[]>[
      { SPORTOZEN_ALERT_COMMAND: "notify --now" },
      { SPORTOZEN_ALERT_COMMAND: "[/usr/local/bin/notify,{subject}]" },
      { SPORTOZEN_ALERT_WEBHOOK_URL: "http://hooks.example/x" },
      { SPORTOZEN_ALERT_WEBHOOK_URL: "not a url" },
      { SPORTOZEN_LOG_LEVEL: "chatty" },
    ])
      expect(failures({ ...good(), ...bad }), JSON.stringify(bad)).toEqual([]);
    expect(
      named({ ...good(), SPORTOZEN_ALERT_COMMAND: "notify --now" }),
    ).toContain("SPORTOZEN_ALERT_COMMAND");
    expect(
      named({
        ...good(),
        SPORTOZEN_ALERT_WEBHOOK_URL: "http://hooks.example/x",
      }),
    ).toContain("SPORTOZEN_ALERT_WEBHOOK_URL");
    expect(named({ ...good(), SPORTOZEN_LOG_LEVEL: "chatty" })).toContain(
      "SPORTOZEN_LOG_LEVEL",
    );
    const fine = {
      ...good(),
      SPORTOZEN_ALERT_COMMAND: '["/usr/local/bin/notify","{subject}"]',
      SPORTOZEN_ALERT_WEBHOOK_URL: "https://hooks.example/x",
    };
    expect(named(fine)).not.toContain("alerts");
  });
  it("refuses email verification or recovery with no email transport", () => {
    expect(
      failures({ ...good(), SPORTOZEN_EMAIL_VERIFICATION: "required" }),
    ).toContain("email");
    expect(
      failures({ ...good(), SPORTOZEN_PASSWORD_RECOVERY: "on" }),
    ).toContain("email");
    expect(
      failures({ ...good(), SPORTOZEN_EMAIL_TRANSPORT: "acme" }),
    ).toContain("SPORTOZEN_EMAIL_TRANSPORT");
    expect(
      check(good()).some((r) => r.level === "WARN" && r.name === "email"),
    ).toBe(true);
  });
  it("keeps backups outside the app and database directories", () => {
    const base = { ...good(), SPORTOZEN_BACKUP_DIR: join(root, "backups") };
    expect(failures(base)).toEqual([]);
    for (const directory of [
      "relative/backups",
      join(app, "backups"),
      join(data, "backups"),
    ])
      expect(failures({ ...base, SPORTOZEN_BACKUP_DIR: directory })).toContain(
        "SPORTOZEN_BACKUP_DIR",
      );
    const warnings = check(base)
      .map((r) => r.message)
      .join(" ");
    expect(warnings).toContain("off-server");
    expect(warnings).toContain("RPO/RTO");
  });
  it("build mode needs an HTTPS origin, no QA flags, and throw-away secret and database path", () => {
    const build = {
      BETTER_AUTH_URL: "https://academy.sportozen.app",
      BETTER_AUTH_SECRET: "throw-away",
      SPORTOZEN_DATABASE_PATH: join(root, "build.sqlite"),
    };
    expect(failures(build, "build")).toEqual([]);
    expect(failures({}, "build")).toContain("BETTER_AUTH_URL");
    expect(failures(without(build, "BETTER_AUTH_SECRET"), "build")).toEqual([
      "BETTER_AUTH_SECRET",
    ]);
    expect(
      failures(without(build, "SPORTOZEN_DATABASE_PATH"), "build"),
    ).toEqual(["SPORTOZEN_DATABASE_PATH"]);
    // A database inside the build directory would be left behind by the build.
    expect(
      failures(
        { ...build, SPORTOZEN_DATABASE_PATH: join(app, "x.sqlite") },
        "build",
      ),
    ).toEqual(["SPORTOZEN_DATABASE_PATH"]);
    expect(failures({ ...build, SPORTOZEN_QA_BUILD: "1" }, "build")).toEqual([
      "QA flags",
    ]);
  });
  it("artifact mode requires the headers baked into the build", () => {
    const release = join(root, "artifact");
    mkdirSync(join(release, ".next"), { recursive: true });
    const manifest = (keys: string[]) =>
      writeFileSync(
        join(release, ".next", "routes-manifest.json"),
        JSON.stringify({
          headers: [
            {
              source: "/:path*",
              headers: keys.map((key) => ({ key, value: "x" })),
            },
          ],
        }),
      );
    const others = BAKED_HEADERS.filter(
      (key) => key !== "Strict-Transport-Security",
    );
    expect(failures(good(), "artifact", join(root, "nothing"))).toContain(
      "build artifact",
    );
    manifest(others);
    writeFileSync(join(release, ".next", "BUILD_ID"), "id");
    expect(failures(good(), "artifact", release)).toEqual([
      "header Strict-Transport-Security",
    ]);
    manifest(["Strict-Transport-Security", ...others]);
    expect(failures(good(), "artifact", release)).toEqual([]);
  });
});

describe("what preflight expects in the build matches what next.config.ts really sets", () => {
  it("every required baked header is in the real header list, and the per-request policy is not required", async () => {
    process.env.BETTER_AUTH_URL = "https://academy.sportozen.app";
    const { securityHeaders } = await import("../../next.config");
    const real = new Set(securityHeaders.map((h) => h.key));
    for (const key of BAKED_HEADERS) expect(real.has(key), key).toBe(true);
    expect(BAKED_HEADERS).not.toContain("Content-Security-Policy");
  });
});

describe("preflight command line", () => {
  const cli = join(process.cwd(), "scripts/preflight.mjs");
  it("exits non-zero on failure and zero on success, without printing the secret", () => {
    const bad = spawnSync(process.execPath, [cli], {
      cwd: app,
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
        BETTER_AUTH_SECRET: SECRET,
      },
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL");
    expect(bad.stdout + bad.stderr).not.toContain(SECRET);
    const env = {
      NODE_ENV: "production" as const,
      PATH: process.env.PATH ?? "",
      ...good(),
    };
    const out = execFileSync(process.execPath, [cli], {
      cwd: app,
      env,
      encoding: "utf8",
    });
    expect(out).toContain("Preflight (start) passed");
    expect(out).not.toContain(SECRET);
  });
});
