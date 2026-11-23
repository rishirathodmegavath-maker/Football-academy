// A STAND-IN for Google's token endpoint, loaded with `node --require` into the
// browser-test server only (playwright.google-oauth.config.ts). It answers the
// one server-to-server call Better Auth makes to Google, so the real
// authorization-code flow runs end to end without a Google account. The browser
// half (Google's consent page) is played by the test, which returns to the
// callback with a code. Production code contains no switch for any of this.
//
// The "code" the test sends is the person's claims, base64url-encoded. The
// answer is an ID token with those claims. A code of "rejected" is what Google
// says for a bad or reused code.
const realFetch = globalThis.fetch;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

globalThis.fetch = async function standIn(input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === "https://oauth2.googleapis.com/token") {
    const body = new URLSearchParams(
      String(init && init.body ? init.body : ""),
    );
    const code = body.get("code") || "";
    if (!code || code === "rejected")
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const claims = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return new Response(
      JSON.stringify({
        access_token: "stand-in-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
          iss: "https://accounts.google.com",
          aud: body.get("client_id"),
          iat: now,
          exp: now + 3600,
          ...claims,
        })}.stand-in`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // Nothing else may reach Google from this server.
  if (/^https?:\/\/([^/]*\.)?(google|googleapis|gstatic)\.com(\/|$)/.test(url))
    throw new Error(`Blocked network call to ${url}`);
  return realFetch.apply(this, arguments);
};
