// Which origins the application trusts: one exact list, shared by sign-in
// (Better Auth), the same-origin check of every write route and the links in
// e-mail. No wildcards; loopback aliases only in development.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  configuredBaseUrl,
  isTrustedOrigin,
  publicOrigin,
  trustedOrigins,
} from "@/server/app-origin";

describe("the public address", () => {
  it("uses BETTER_AUTH_URL when it is set", () => {
    expect(
      publicOrigin({ BETTER_AUTH_URL: "https://academy.example.org/", PORT: "3005" }),
    ).toBe("https://academy.example.org");
  });
  it("follows the port the local server really listens on instead of assuming 3000", () => {
    expect(configuredBaseUrl({ PORT: "3005" })).toBe("http://127.0.0.1:3005");
    expect(configuredBaseUrl({})).toBe("http://127.0.0.1:3000");
    expect(configuredBaseUrl({ PORT: "not-a-port" })).toBe("http://127.0.0.1:3000");
  });
});

describe("trusted origins", () => {
  const dev = { NODE_ENV: "development", PORT: "3005" };
  it("in development trusts the three loopback names of the one server, exactly", () => {
    expect(trustedOrigins(dev).sort()).toEqual(
      [
        "http://127.0.0.1:3005",
        "http://[::1]:3005",
        "http://localhost:3005",
      ].sort(),
    );
  });
  it("rejects other ports, other hosts, other schemes and an absent origin", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3006",
      "https://localhost:3005",
      "http://evil.example",
      "http://localhost:3005.evil.example",
      "http://localhost.evil.example:3005",
      "null",
      "",
      null,
      undefined,
    ])
      expect(isTrustedOrigin(origin, dev), String(origin)).toBe(false);
    expect(isTrustedOrigin("http://localhost:3005", dev)).toBe(true);
    expect(isTrustedOrigin("http://[::1]:3005", dev)).toBe(true);
  });
  it("never adds the loopback aliases in production", () => {
    const production = {
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://127.0.0.1:3001",
    };
    expect(trustedOrigins(production)).toEqual(["http://127.0.0.1:3001"]);
  });
  it("trusts only the public origin for a real https deployment, even in development mode", () => {
    const env = {
      NODE_ENV: "development",
      BETTER_AUTH_URL: "https://academy.example.org",
    };
    expect(trustedOrigins(env)).toEqual(["https://academy.example.org"]);
    expect(isTrustedOrigin("http://localhost:3000", env)).toBe(false);
  });
  it("accepts extra origins only as exact origins", () => {
    const env = {
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://academy.example.org",
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://www.example.org, https://staging.example.org/",
    };
    expect(trustedOrigins(env)).toEqual([
      "https://academy.example.org",
      "https://www.example.org",
      "https://staging.example.org",
    ]);
  });
  it.each([
    ["a wildcard host", "https://*.example.org"],
    ["a wildcard port", "http://localhost:*"],
    ["a bare wildcard", "*"],
    ["a path", "https://example.org/app"],
    ["plain http for a public host", "http://example.org"],
    ["another scheme", "ftp://example.org"],
    ["something that is not a URL", "example.org"],
  ])("refuses to start with %s in BETTER_AUTH_TRUSTED_ORIGINS", (_name, value) => {
    expect(() =>
      trustedOrigins({
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://academy.example.org",
        BETTER_AUTH_TRUSTED_ORIGINS: value,
      }),
    ).toThrow(/BETTER_AUTH_TRUSTED_ORIGINS/);
  });
});
