import type { NextConfig } from "next";
// Browser-enforced protections that do not depend on the request. The
// Content-Security-Policy (pages with a per-request script nonce, API responses
// with a policy that renders nothing) and X-Request-Id are set per request by
// src/proxy.ts, so SPORTOZEN_CSP applies at run time, not only at build time.
// HSTS is only meaningful (and only sent) for a real HTTPS deployment; a
// developer machine on http://127.0.0.1 must not be told to insist on HTTPS.
const httpsDeployment = (process.env.BETTER_AUTH_URL ?? "").startsWith(
  "https://",
);
export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Other sites cannot embed this application's responses (PDFs, JSON, pages).
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ...(httpsDeployment
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000",
        },
      ]
    : []),
];
const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // An invitation emailed in the older form, /workspace?invitation=<code>, opens
  // the invitation page. This runs before the sign-in check, so a person who is
  // not signed in yet keeps their invitation instead of landing on a bare
  // sign-in page.
  redirects: async () => [
    {
      source: "/workspace",
      has: [
        {
          type: "query",
          key: "invitation",
          value: "(?<token>[0-9a-f]{64})",
        },
      ],
      destination: "/join/:token",
      permanent: false,
    },
  ],
  headers: async () => [
    { source: "/:path*", headers: securityHeaders },
    // The versioned web fonts (public/fonts/*-vN.woff2) never change in place,
    // so a browser may keep them for a year instead of asking on every visit.
    {
      source: "/fonts/:file(.*-v[0-9]+[.]woff2)",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
    },
  ],
  // QA builds must not replace the assets served by an existing local app.
  distDir:
    process.env.SPORTOZEN_QA_BUILD === "1"
      ? process.env.SPORTOZEN_PLAYER_FORM_QA === "1"
        ? ".next-player-form-qa"
        : process.env.SPORTOZEN_REPORTS_QA === "1"
          ? ".next-professional-reports-qa"
          : process.env.SPORTOZEN_FINAL_QA === "1"
            ? ".next-final-qa"
            : process.env.SPORTOZEN_GALLERY_QA === "1"
              ? ".next-gallery-qa"
              : ".next-football-qa"
      : ".next",
  // Keep isolated QA generation within local memory and SQLite worker limits.
  experimental:
    process.env.SPORTOZEN_QA_BUILD === "1" ? { cpus: 1 } : undefined,
};
export default config;
