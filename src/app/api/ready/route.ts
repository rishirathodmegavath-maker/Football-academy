import { readiness } from "@/server/readiness";

// Readiness: the database opens, the schema is present and the service is not
// shutting down. The proxy and the release script use this, not /api/health.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  const result = readiness();
  return Response.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
