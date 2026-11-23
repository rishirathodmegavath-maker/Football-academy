import { context } from "@/server/workspace-service";
import { homeSummary } from "@/server/home-summary-service";
import { compressibleJson, apiError } from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return compressibleJson(
      request,
      homeSummary(await context(request.headers, academyId)),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
