import { context } from "@/server/workspace-service";
import { apiError, privateJson } from "@/server/workspace-access";
import { drillHistory } from "@/server/drill-library-service";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string; drillId: string }> };

/**
 * The append-only revision history of one academy drill. Owner and admin, or
 * the coach who created the drill. Read-only: there is no write method.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId, drillId } = await params;
    return privateJson(
      drillHistory(await context(request.headers, academyId), drillId),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
