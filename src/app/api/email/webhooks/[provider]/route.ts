import { handleEmailWebhook } from "@/server/email/webhook";

// One route for every e-mail provider's delivery reports; see
// src/server/email/webhook.ts. The provider is named by the URL.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  return handleEmailWebhook(request, (await params).provider);
}
