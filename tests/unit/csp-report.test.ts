// WP7: the unauthenticated CSP violation-report endpoint treats every report as
// hostile input and logs only a few short, query-free fields.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  MAX_REPORTS_PER_MINUTE,
  MAX_REPORTS_PER_SOURCE_PER_MINUTE,
  MAX_REPORT_BYTES,
  receiveCspReport,
  summariseCspReport,
} from "@/server/csp-report";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3000/api/csp-report", {
    method: "POST",
    body,
    headers,
  });
const logged = () =>
  warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
let minute = 1_000_000_000;
const freshMinute = () => (minute += 120_000);

describe("summarising a report", () => {
  it("reads the legacy report-uri format and drops query strings and fragments", () => {
    const summary = summariseCspReport({
      "csp-report": {
        "document-uri":
          "https://academy.example/workspace/a1?invitation=SECRET#frag",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://cdn.evil.example/x.js?k=SECRET",
        "script-sample": "alert('SECRET')",
        disposition: "enforce",
      },
    });
    expect(summary).toEqual({
      directive: "script-src-elem",
      blockedHost: "https://cdn.evil.example",
      path: "/workspace/a1",
      disposition: "enforce",
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
  it("never keeps an invitation token from the page path", () => {
    const token = "0123456789abcdef".repeat(4);
    const summary = summariseCspReport({
      "csp-report": {
        "document-uri": `https://academy.example/join/${token}`,
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
      },
    });
    expect(summary?.path).toBe("/join/:token");
    expect(JSON.stringify(summary)).not.toContain(token);
  });
  it("reads the Reporting API format and keeps keywords such as inline and eval", () => {
    expect(
      summariseCspReport([
        {
          type: "csp-violation",
          body: {
            effectiveDirective: "script-src",
            blockedURL: "eval",
            documentURL: "https://academy.example/sign-in",
          },
        },
      ]),
    ).toMatchObject({
      directive: "script-src",
      blockedHost: "eval",
      path: "/sign-in",
    });
  });
  it("ignores anything that is not a report and neutralises odd characters and long values", () => {
    for (const junk of [
      null,
      5,
      "x",
      [],
      {},
      { "csp-report": 7 },
      { "csp-report": {} },
    ])
      expect(summariseCspReport(junk)).toBeUndefined();
    const odd = summariseCspReport({
      "csp-report": {
        "effective-directive":
          'script-src\nFORGED {"level":"error"}' + "x".repeat(500),
        "blocked-uri": "data:text/html,<script>",
      },
    })!;
    expect(odd.directive).not.toMatch(/[\n{}"]/);
    expect(odd.directive.length).toBeLessThanOrEqual(40);
    expect(odd.blockedHost).toBe("data:");
  });
});

describe("receiving reports", () => {
  it("always answers 204 and logs one security event with allow-listed fields", async () => {
    const res = await receiveCspReport(
      post(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://a.example/sign-in?token=SECRET",
            "effective-directive": "img-src",
            "blocked-uri": "https://x.example/p.png?id=SECRET",
          },
        }),
      ),
      freshMinute(),
    );
    expect(res.status).toBe(204);
    expect(logged()).toContain('"type":"csp.violation"');
    expect(logged()).not.toContain("SECRET");
  });
  it("ignores bodies that are too large, not JSON, or empty, without logging", async () => {
    const t = freshMinute();
    expect(
      (await receiveCspReport(post("x".repeat(MAX_REPORT_BYTES + 1)), t))
        .status,
    ).toBe(204);
    // A perfectly valid report that is merely too large is dropped, not parsed.
    const padded = `{"csp-report":{"effective-directive":"script-src"}}${" ".repeat(MAX_REPORT_BYTES)}`;
    expect((await receiveCspReport(post(padded), t)).status).toBe(204);
    expect((await receiveCspReport(post("not json"), t)).status).toBe(204);
    expect((await receiveCspReport(post(null), t)).status).toBe(204);
    // A declared length over the limit is refused before any read.
    expect(
      (
        await receiveCspReport(
          post("{}", { "content-length": String(MAX_REPORT_BYTES + 1) }),
          t,
        )
      ).status,
    ).toBe(204);
    expect(logged()).toBe("");
  });
  it("stops logging after its share in a minute, per source and overall, and resumes in the next", async () => {
    const t = freshMinute();
    const report = JSON.stringify({
      "csp-report": { "effective-directive": "script-src" },
    });
    const from = (address: string) =>
      post(report, { "x-forwarded-for": address });
    // One noisy source is capped, and does not starve another.
    for (let i = 0; i < MAX_REPORTS_PER_SOURCE_PER_MINUTE + 50; i++)
      await receiveCspReport(from("198.51.100.1"), t);
    await receiveCspReport(from("198.51.100.2"), t);
    expect(logged().split("\n").filter(Boolean)).toHaveLength(
      MAX_REPORTS_PER_SOURCE_PER_MINUTE + 1,
    );
    // Junk spends nothing: after a flood of it, a real report still gets through.
    warn.mockClear();
    const t2 = freshMinute();
    for (let i = 0; i < 500; i++) await receiveCspReport(post("junk"), t2);
    await receiveCspReport(from("198.51.100.3"), t2);
    expect(logged().split("\n").filter(Boolean)).toHaveLength(1);
    // The whole process has a ceiling too.
    warn.mockClear();
    const t3 = freshMinute();
    for (let i = 0; i < MAX_REPORTS_PER_MINUTE + 100; i++)
      await receiveCspReport(
        from(`203.0.113.${i % 250}.${Math.floor(i / 250)}`),
        t3,
      );
    expect(logged().split("\n").filter(Boolean)).toHaveLength(
      MAX_REPORTS_PER_MINUTE,
    );
    warn.mockClear();
    await receiveCspReport(from("198.51.100.1"), t3 + 61_000);
    expect(logged().split("\n").filter(Boolean)).toHaveLength(1);
  });
});
