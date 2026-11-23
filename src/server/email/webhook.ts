import "server-only";
import { NextResponse } from "next/server";
import { apiError, readBytes } from "../http";
import { securityEvent } from "../security-events";
import { recordDeliveryEvent } from "./events";
import { emailProvider } from "./transport";

// Delivery, bounce and complaint reports from the configured e-mail provider,
// for every provider. The route is /api/email/webhooks/<provider>. What is
// provider-specific (how a request is authenticated, what a payload means) is
// the provider's webhook adapter (types.ts); this handler is the same for all:
//   - 404 until the provider is registered, has a webhook adapter and its
//     variables are set, so an unconfigured deployment exposes nothing;
//   - 401 (and a security event) when the request is not authentic;
//   - the body is bounded, parsed as JSON, turned into delivery events and
//     recorded once per provider event id (a replay changes nothing);
//   - it changes only the delivery state of messages this application sent.
const MAX_BODY_BYTES = 100_000;

export async function handleEmailWebhook(
  request: Request,
  providerName: string,
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const adapter = emailProvider(providerName)?.webhook;
    if (
      !adapter ||
      adapter.requiredEnv.some((name) => !env[name]) ||
      (adapter.configured && !adapter.configured(env))
    )
      return new NextResponse(null, { status: 404 });
    if (!adapter.authenticate(request.headers, env)) {
      securityEvent("webhook.rejected", {
        route: `POST /api/email/webhooks/${providerName}`,
        status: 401,
      });
      return new NextResponse(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="webhook"' },
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readBytes(request, MAX_BODY_BYTES)),
      );
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    for (const event of adapter.parse(body, Date.now()))
      recordDeliveryEvent(event);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, request);
  }
}
