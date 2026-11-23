// WP7: the browser security policy. The page policy (script nonce) is built in
// src/config/security-policy.ts and applied by src/proxy.ts; the API policy and
// the other headers come from next.config.ts. A real-browser check of every
// route class is tests/e2e/csp.spec.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  API_CONTENT_SECURITY_POLICY,
  CSP_REPORT_PATH,
  cspMode,
  newNonce,
  pageContentSecurityPolicy,
} from "@/config/security-policy";
import { proxy, config } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values];
    }),
  );
const request = (path: string) =>
  new NextRequest(`http://127.0.0.1:3000${path}`);

describe("page policy", () => {
  const nonce = newNonce();
  const policy = directives(pageContentSecurityPolicy(nonce, { https: true }));
  it("allows only nonce-carrying scripts (plus what they load) and never inline or eval", () => {
    expect(policy["script-src"]).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
    ]);
    expect(policy["script-src"]).not.toContain("'unsafe-inline'");
    expect(policy["script-src"]).not.toContain("'unsafe-eval'");
  });
  it("allows nothing from other sites", () => {
    for (const name of [
      "default-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "manifest-src",
      "worker-src",
    ])
      for (const value of policy[name])
        expect(value, name).toMatch(/^'(self|unsafe-inline)'$|^(data|blob):$/);
  });
  it("keeps the framing, base, form and plugin protections and names the report endpoint", () => {
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["form-action"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["report-uri"]).toEqual([CSP_REPORT_PATH]);
  });
  it("upgrades insecure requests only for an HTTPS deployment, and allows eval only in development", () => {
    expect(policy["upgrade-insecure-requests"]).toBeDefined();
    const local = directives(
      pageContentSecurityPolicy(nonce, { https: false, development: true }),
    );
    expect(local["upgrade-insecure-requests"]).toBeUndefined();
    expect(local["script-src"]).toContain("'unsafe-eval'");
  });
  it("uses a different unguessable nonce every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const value of seen) expect(atob(value)).toHaveLength(16);
  });
  it("gives API responses a policy that renders nothing", () => {
    expect(API_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});

describe("the proxy", () => {
  it("gives every page its own policy, nonce and all, in the response and the forwarded request", () => {
    const a = proxy(request("/sign-in")),
      b = proxy(request("/sign-in"));
    const first = a.headers.get("content-security-policy")!,
      second = b.headers.get("content-security-policy")!;
    expect(first).toMatch(
      /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
    );
    expect(first).not.toBe(second);
    // Next.js reads the nonce from the request header the proxy forwards.
    expect(a.headers.get("x-middleware-override-headers")).toContain(
      "content-security-policy",
    );
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(
      first,
    );
  });
  it("sends an invitation page no Referer and no cache entry, and no other page the same", () => {
    const token = "a1".repeat(32);
    const join = proxy(request(`/join/${token}`));
    expect(join.headers.get("referrer-policy")).toBe("no-referrer");
    expect(join.headers.get("cache-control")).toBe("no-store");
    expect(proxy(request("/join")).headers.get("referrer-policy")).toBe("no-referrer");
    for (const path of ["/sign-in", "/joined", "/joint/x", "/api/health"])
      expect(proxy(request(path)).headers.get("referrer-policy"), path).toBeNull();
  });
  it("still rejects unsupported demo routes with 404, and the 404 carries the policy", () => {
    const res = proxy(request("/owner/not-a-screen"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "/unsupported-route",
    );
    expect(res.headers.get("content-security-policy")).toContain("script-src");
    expect(proxy(request("/owner/dashboard")).status).toBe(200);
    // A path that merely starts with the same letters is not a demo route.
    expect(
      proxy(request("/ownership")).headers.get("x-middleware-rewrite"),
    ).toBeNull();
  });
  it("report-only mode logs violations without blocking, under the report-only header", () => {
    vi.stubEnv("SPORTOZEN_CSP", "report-only");
    const res = proxy(request("/sign-in"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toContain(
      "script-src",
    );
  });
  it("off mode sends no policy", () => {
    vi.stubEnv("SPORTOZEN_CSP", "off");
    const res = proxy(request("/sign-in"));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });
  it("gives API responses the policy that renders nothing, and every response a request id", () => {
    const api = proxy(request("/api/workspaces"));
    expect(api.headers.get("content-security-policy")).toBe(
      API_CONTENT_SECURITY_POLICY,
    );
    // No nonce is needed (or forwarded) for a response that is never rendered.
    expect(
      api.headers.get("x-middleware-request-content-security-policy"),
    ).toBeNull();
    const id = api.headers.get("x-request-id")!;
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(api.headers.get("x-middleware-request-x-request-id")).toBe(id);
    // A sane id from the proxy in front is kept; a hostile one is replaced.
    const kept = proxy(
      new NextRequest("http://127.0.0.1:3000/api/health", {
        headers: { "x-request-id": "0123456789abcdef0123456789abcdef" },
      }),
    );
    expect(kept.headers.get("x-request-id")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    const hostile = proxy(
      new NextRequest("http://127.0.0.1:3000/api/health", {
        headers: { "x-request-id": "bad id; <script>" },
      }),
    );
    expect(hostile.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    // /apiary is a page, not the API.
    expect(
      proxy(request("/apiary")).headers.get("content-security-policy"),
    ).toContain("script-src");
  });
  it("applies the report-only and off modes to the API too, at request time", () => {
    vi.stubEnv("SPORTOZEN_CSP", "report-only");
    const api = proxy(request("/api/health"));
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("content-security-policy-report-only")).toContain(
      "default-src 'none'",
    );
    vi.stubEnv("SPORTOZEN_CSP", "off");
    expect(
      proxy(request("/api/health")).headers.get("content-security-policy"),
    ).toBeNull();
  });
  it("runs on pages and the API, but not build assets, images or router prefetches", () => {
    const rule = config.matcher[0] as {
      source: string;
      missing: { key: string }[];
    };
    const pattern = new RegExp(`^${rule.source}$`);
    for (const page of [
      "/",
      "/sign-in",
      "/workspace/abc",
      "/account/security",
      "/owner/dashboard",
      "/api/health",
      "/apiary",
      "/_next/staticky",
    ])
      expect(pattern.test(page), page).toBe(true);
    for (const other of ["/_next/static/a.js", "/_next/image", "/favicon.ico"])
      expect(pattern.test(other), other).toBe(false);
    expect(rule.missing.map((m) => m.key)).toContain("next-router-prefetch");
  });
});

describe("policy mode", () => {
  it("defaults to enforce and accepts only enforce, report-only or off", () => {
    expect(cspMode({})).toBe("enforce");
    expect(cspMode({ SPORTOZEN_CSP: " Report-Only " })).toBe("report-only");
    expect(() => cspMode({ SPORTOZEN_CSP: "maybe" })).toThrow();
  });
});
