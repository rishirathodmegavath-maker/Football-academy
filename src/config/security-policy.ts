// The browser security policy in one place: next.config.ts applies the API
// policy, src/proxy.ts applies the page policy with a fresh nonce per request.
// Nothing here may import server-only code (the proxy and the config load it).

export type CspMode = "enforce" | "report-only" | "off";
/** SPORTOZEN_CSP: enforce (default), report-only (log violations, block nothing) or off. */
export function cspMode(
  env: Record<string, string | undefined> = process.env,
): CspMode {
  const value = (env.SPORTOZEN_CSP ?? "enforce").trim().toLowerCase();
  if (value !== "enforce" && value !== "report-only" && value !== "off")
    throw new Error("SPORTOZEN_CSP must be enforce, report-only or off.");
  return value;
}
export const CSP_REPORT_PATH = "/api/csp-report";
/** JSON, PDF and other API responses are never rendered as pages. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/** The header that carries the policy for a mode. */
export const cspHeaderName = (mode: Exclude<CspMode, "off">) =>
  mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

/** A fresh, unguessable value for one response. */
export function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
/**
 * Policy for HTML pages.
 *
 * script-src: only scripts that carry this response's nonce, and the scripts
 * those load ('strict-dynamic'). Next.js adds the nonce to its own inline and
 * bundle scripts when the request carries this policy (dynamic rendering).
 * Injected markup without the nonce cannot run, which is what turns a future
 * XSS bug into a non-event. 'self' is only a fallback for very old browsers.
 *
 * style-src keeps 'unsafe-inline': React renders style="" attributes
 * throughout the application and a nonce cannot cover attributes. Script is
 * the dangerous part; style injection is limited to look and feel.
 *
 * Nothing external is allowed: the browser code talks only to this origin
 * (Google Places and WhatsApp are called by the server).
 */
export function pageContentSecurityPolicy(
  nonce: string,
  options: { https: boolean; development?: boolean },
) {
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the browser COMPILE WebAssembly (the PDF layout
    // engine used for client-side PDF downloads); it does not allow string-to-code evaluation or
    // dynamic code construction. Found by the full browser suite, not by reading the code.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${options.development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // data: lets code read an inline data URL (embedded fonts and images for
    // client-side PDFs); it cannot reach any network address.
    "connect-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");
}
