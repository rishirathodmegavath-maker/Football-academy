// WP7: the repository secret scan finds planted credentials, never prints them,
// and passes on this repository.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scan } from "../../scripts/secret-scan.mjs";

let root: string;
const put = (file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sportozen-secretscan-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("secret scan", () => {
  it("finds private keys, provider tokens, quoted secret assignments and forbidden files", () => {
    // Built from parts so this file itself carries no real-looking secret.
    put("a.ts", ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ") + "\n");
    put("b.ts", `const k = "${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}";\n`);
    put("c.ts", `const t = "${["ghp_", "a".repeat(36)].join("")}";\n`);
    put("d.ts", `export const apiKey = "${"Zz9".repeat(10)}";\n`);
    put(
      "e.ts",
      `fetch(u, { headers: { Authorization: "Bearer ${"x1".repeat(20)}" } });\n`,
    );
    put(".env.production", "X=1\n");
    put("data/workspaces.sqlite", "x");
    const found = scan(root) as { file: string; line: number; rule: string }[];
    const rules = new Map(found.map((f) => [f.file, f.rule]));
    expect(rules.get("a.ts")).toBe("private key block");
    expect(rules.get("b.ts")).toBe("AWS access key id");
    expect(rules.get("c.ts")).toBe("GitHub token");
    expect(rules.get("d.ts")).toBe("secret-looking assignment");
    expect(rules.get("e.ts")).toBe("bearer token literal");
    expect(rules.get(".env.production")).toBe(".env file");
    expect(rules.get("data/workspaces.sqlite")).toBe("database file");
  });
  it("also finds the shapes a first version missed: base64 keys, passwords with symbols, URL passwords, JWTs, unquoted config values, env files in any folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-secretscan-more-"));
    const write = (file: string, text: string) => {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    try {
      const b64 = "Qm9v" + "dGVzdA".repeat(8) + "+/==";
      write("a.ts", `const encryptionKey = "${b64}";\n`);
      write(
        "b.ts",
        `const password = "${["P@ss", "w0rd!$#", "longenough1"].join("")}";\n`,
      );
      write(
        "c.ts",
        `const url = "${["postgres://app", "S3cretPw@db.internal/x"].join(":")}";\n`,
      );
      write(
        "d.ts",
        `const t = "${["eyJhbGciOiJIUzI1", "eyJzdWIiOiIxMjM0NTY3", "abcdefghijkl"].join(".")}";\n`,
      );
      write(
        "e.ts",
        `const k = "${["sk-ant-", "a1B2".repeat(10)].join("")}";\n`,
      );
      write(
        "f.ts",
        `const k = "${["github_pat_", "A1b2C3".repeat(8)].join("")}";\n`,
      );
      write("g.sh", `export SPORTOZEN_BACKUP_ENCRYPTION_KEY=${b64}\n`);
      write("h.yaml", `secret: ${"Zx9".repeat(11)}\n`);
      write("deploy/sportozen.env", "X=1\n");
      // A private key is never excused by the allow marker.
      write(
        "i.ts",
        ["-----BEGIN PRIVATE", "KEY-----"].join(" ") +
          " // secret-scan:allow\n",
      );
      const rules = new Map(
        (scan(dir) as { file: string; rule: string }[]).map((f) => [
          f.file,
          f.rule,
        ]),
      );
      for (const file of ["a.ts", "b.ts", "g.sh", "h.yaml"])
        expect(rules.get(file), file).toBe("secret-looking assignment");
      expect(rules.get("c.ts")).toBe("password in a URL");
      expect(rules.get("d.ts")).toBe("JSON web token");
      expect(rules.get("e.ts")).toBe("Anthropic or OpenAI key");
      expect(rules.get("f.ts")).toBe("GitHub token");
      expect(rules.get("deploy/sportozen.env")).toBe("environment file");
      expect(rules.get("i.ts")).toBe("private key block");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reports a file it cannot scan because it is too large, and skips references and placeholders", () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-secretscan-big-"));
    try {
      writeFileSync(join(dir, "big.txt"), "x".repeat(2_100_000));
      writeFileSync(
        join(dir, "ok.ts"),
        [
          "const key = process.env.SPORTOZEN_BACKUP_ENCRYPTION_KEY_FILE_PATH_X;",
          'const password = "change-me-before-deployment";',
          'const token = tokenFromHeader("Authorization-Header-Value");',
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "ok.sh"),
        "SECRET=$(cat /run/secrets/auth_secret_value)\n",
      );
      const found = scan(dir) as { file: string; rule: string }[];
      expect(found).toEqual([
        { file: "big.txt", line: 0, rule: "file too large to scan" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allows a marked fake, a template and a short placeholder", () => {
    const clean = mkdtempSync(join(tmpdir(), "sportozen-secretscan-ok-"));
    try {
      writeFileSync(
        join(clean, "ok.ts"),
        [
          `const fake = "${"Aa1".repeat(10)}"; // secret-scan:allow synthetic test value`,
          `const placeholder = "change-me";`,
          `const secret = process.env.BETTER_AUTH_SECRET;`,
        ].join("\n"),
      );
      writeFileSync(
        join(clean, "sportozen.env.example"),
        "BETTER_AUTH_SECRET=\n",
      );
      expect(scan(clean)).toEqual([]);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
  it("prints where and which rule, never the value, and exits 1", () => {
    put("leak.ts", `export const password = "${"Qq7".repeat(10)}";\n`);
    const run = spawnSync(process.execPath, ["scripts/secret-scan.mjs", root], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("leak.ts:1  secret-looking assignment");
    expect(run.stdout).not.toContain("Qq7");
  });
  it("passes on this repository", () => {
    const run = spawnSync(process.execPath, ["scripts/secret-scan.mjs"], {
      encoding: "utf8",
    });
    expect(run.stdout).toContain("No secrets found.");
    expect(run.status).toBe(0);
  });
});
