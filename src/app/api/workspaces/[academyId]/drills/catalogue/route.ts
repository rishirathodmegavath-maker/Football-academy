import { context } from "@/server/workspace-service";
import { apiError, compressibleJson } from "@/server/workspace-access";
import { drillCatalogue } from "@/server/drill-library-service";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };

/**
 * The universal drill catalogue. Authenticated, and limited to staff of an
 * academy whose plan includes the development module; a parent, Support or a
 * visitor gets nothing. Read-only: there is no write method.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return compressibleJson(
      request,
      drillCatalogue(await context(request.headers, academyId)),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
