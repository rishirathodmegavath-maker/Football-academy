// WP5: the browser-facing security headers set for every response.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
const load = async () => {
  vi.resetModules();
  const loaded = await import("../../next.config");
  const rules = await loaded.default.headers!();
  return { config: loaded.default, rules };
};
const headersOf = async () =>
  Object.fromEntries(
    (await load()).rules[0].headers.map((h) => [h.key, h.value]),
  );

describe("security headers", () => {
  it("apply to every path", async () => {
    const { rules } = await load();
    expect(rules[0].source).toBe("/:path*");
  });
  it("let browsers keep the versioned web fonts for a year, and nothing else", async () => {
    const { rules } = await load();
    expect(rules).toHaveLength(2);
    expect(rules[1].source).toBe("/fonts/:file(.*-v[0-9]+[.]woff2)");
    expect(rules[1].headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
    // The rule matches the versioned font files only, never the TTFs that the
    // PDF renderer reads or any page or API path.
    const matcher = new RegExp("^/fonts/(.*-v[0-9]+[.]woff2)$");
    expect(matcher.test("/fonts/NotoSans-Regular-latin-v1.woff2")).toBe(true);
    for (const path of [
      "/fonts/NotoSans-Regular.ttf",
      "/fonts/NotoSans-Regular.woff2",
      "/sign-in",
      "/api/workspaces",
    ])
      expect(matcher.test(path), path).toBe(false);
  });
  it("leave the content policy to the proxy (decided per request), so there is exactly one policy per response", async () => {
    const headers = await headersOf();
    expect(headers).not.toHaveProperty("Content-Security-Policy");
    expect(headers).not.toHaveProperty("Content-Security-Policy-Report-Only");
  });
  it("stop framing, content sniffing and cross-origin embedding", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "");
    const headers = await headersOf();
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });
  it("turn off camera, microphone, location, payment and USB access", async () => {
    const policy = (await headersOf())["Permissions-Policy"];
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "payment",
      "usb",
    ])
      expect(policy).toContain(`${feature}=()`);
  });
  it("send HSTS only for a configured HTTPS deployment", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3000");
    expect(await headersOf()).not.toHaveProperty("Strict-Transport-Security");
    vi.stubEnv("BETTER_AUTH_URL", "https://academy.example.test");
    expect((await headersOf())["Strict-Transport-Security"]).toMatch(
      /^max-age=\d{7,}$/,
    );
  });
  it("hide the framework version header", async () => {
    expect((await load()).config.poweredByHeader).toBe(false);
  });
});
