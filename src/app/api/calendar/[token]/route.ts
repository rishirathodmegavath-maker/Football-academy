import { calendarFeed } from "@/server/calendar-feed-service";
import { apiError } from "@/server/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A person's private calendar subscription: /api/calendar/<secret>.ics. The secret is the whole credential, so a wrong
 * one answers 404 with nothing else, and the response is never cached by a shared cache.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const text = calendarFeed(token.replace(/\.ics$/i, ""));
    if (!text) return new Response("Not found", { status: 404 });
    return new Response(text, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="sportozen-training.ics"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    return apiError(e, request);
  }
}
