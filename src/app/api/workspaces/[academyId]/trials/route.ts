import { context } from "@/server/workspace-service";
import { trialAction, trialView } from "@/server/trial-service";
import {
  apiError,
  privateJson,
  compressibleJson,
  readJson,
  sameOrigin,
} from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return compressibleJson(
      request,
      trialView(
        await context(request.headers, academyId),
        new URL(request.url).searchParams.get("player") ?? undefined,
      ),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
export async function POST(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId } = await params;
    return privateJson(
      trialAction(
        await context(request.headers, academyId),
        await readJson(request),
      ),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
