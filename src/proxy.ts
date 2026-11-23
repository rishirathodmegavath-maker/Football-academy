import { NextResponse, type NextRequest } from "next/server";
import { isSupportedRoute } from "@/config/navigation/routes";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/config/request-id";
import {
  API_CONTENT_SECURITY_POLICY,
  cspHeaderName,
  cspMode,
  newNonce,
  pageContentSecurityPolicy,
} from "@/config/security-policy";

// Runs before App Router starts streaming any response, and does three jobs:
// 1. Request correlation: every request gets an id (nginx's $request_id when it
//    sent a valid one), forwarded to the handlers and returned in X-Request-Id.
// 2. Content-Security-Policy, decided at REQUEST time from SPORTOZEN_CSP so a
//    change in the environment file takes effect on restart without a rebuild:
//    pages get a fresh script nonce (Next.js stamps it on its own scripts, which
//    is why the root layout renders dynamically); API responses get a policy
//    that renders nothing.
// 3. Validation of the legacy demo routes' shape (navigation validation, not
//    authentication or authorisation).
const DEMO_PREFIXES = ["/owner", "/coach", "/parent"];
const underPath = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = requestIdFrom(request.headers.get(REQUEST_ID_HEADER));
  const api = underPath(pathname, "/api");
  const demo = DEMO_PREFIXES.some((prefix) => underPath(pathname, prefix));
  const mode = cspMode();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  let policy: string | undefined;
  if (mode !== "off") {
    policy = api
      ? API_CONTENT_SECURITY_POLICY
      : pageContentSecurityPolicy(newNonce(), {
          https: (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
          development: process.env.NODE_ENV === "development",
        });
    // For pages, the request header is where Next.js reads the nonce from.
    if (!api) requestHeaders.set(cspHeaderName(mode), policy);
  }
  const response =
    demo && !isSupportedRoute(pathname)
      ? NextResponse.rewrite(new URL("/unsupported-route", request.url), {
          status: 404,
          request: { headers: requestHeaders },
        })
      : NextResponse.next({ request: { headers: requestHeaders } });
  if (policy && mode !== "off")
    response.headers.set(cspHeaderName(mode), policy);
  response.headers.set("X-Request-Id", requestId);
  // An invitation address holds a single-use secret in its path. As real response headers (the page also says it in its
  // metadata) a browser never sends that address on as a Referer to any other site, and no cache keeps the page.
  if (underPath(pathname, "/join")) {
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}
export const config = {
  // Everything except build assets, optimised images and the favicon (they
  // carry no document). Only Next.js's own router prefetches are skipped: they
  // return data for a client navigation, not a document.
  matcher: [
    {
      source: "/((?!_next/static/|_next/image|favicon\\.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
