#!/usr/bin/env node
/**
 * Checks API JSON compression end to end through whatever sits in front of the
 * application (a reverse proxy, CDN or the app itself). Run it against the real
 * deployment with a signed-in session cookie; nothing is printed that could
 * reveal the cookie or any record content.
 *
 *   SPORTOZEN_COOKIE='better-auth.session_token=…' \
 *     node scripts/verify-api-compression.mjs https://host/api/workspaces/<academyId>
 *
 * Pass a URL whose JSON body is at least 1 KB (the academy payload is). Checks:
 *  1. with Accept-Encoding: gzip the response is gzip-encoded exactly once;
 *  2. one gunzip yields JSON (a second layer would leave gzip bytes);
 *  3. the decoded body equals the response sent without Accept-Encoding;
 *  4. the response without Accept-Encoding is not encoded;
 *  5. Vary names Accept-Encoding;
 *  6. Cache-Control stays private and no-store.
 * Exit code 0 only if every check passes.
 */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

const target = process.argv[2];
const cookie = process.env.SPORTOZEN_COOKIE;
if (!target || !cookie) {
  console.error(
    "Usage: SPORTOZEN_COOKIE='<name>=<value>' node scripts/verify-api-compression.mjs <url>",
  );
  process.exit(2);
}
const url = new URL(target);
function get(acceptEncoding) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const headers = { cookie };
    if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
    client
      .get(url, { headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}
const isGzip = (buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
};

const plain = await get(undefined);
const packed = await get("gzip");
check("both requests answered 200", plain.status === 200 && packed.status === 200, `${plain.status}/${packed.status}`);
const encoding = String(packed.headers["content-encoding"] ?? "");
check("gzip-encoded exactly once", encoding.toLowerCase() === "gzip", encoding || "none");
let decoded;
try {
  decoded = zlib.gunzipSync(packed.body);
} catch {
  decoded = undefined;
}
check("one gunzip succeeds", decoded !== undefined);
check("no second compression layer", decoded !== undefined && !isGzip(decoded));
let json = false;
try {
  JSON.parse(decoded?.toString("utf8") ?? "");
  json = true;
} catch {
  json = false;
}
check("decoded body is JSON", json);
check(
  "decoded body equals the unencoded response",
  decoded !== undefined && Buffer.compare(decoded, plain.body) === 0,
);
check("unencoded request is not encoded", !plain.headers["content-encoding"], String(plain.headers["content-encoding"] ?? "none"));
check("Vary names Accept-Encoding", /accept-encoding/i.test(String(packed.headers.vary ?? "")), String(packed.headers.vary ?? "none"));
check(
  "Cache-Control is private and no-store",
  /no-store/i.test(String(packed.headers["cache-control"] ?? "")) && /private/i.test(String(packed.headers["cache-control"] ?? "")),
  String(packed.headers["cache-control"] ?? "none"),
);
console.log(
  `sizes: decoded ${plain.body.length} bytes, on the wire with gzip ${packed.body.length} bytes` +
    (packed.body.length ? ` (${(plain.body.length / packed.body.length).toFixed(1)}x)` : ""),
);
process.exit(results.every(Boolean) ? 0 : 1);
