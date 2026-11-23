import { platformApplication } from "@/server/platform-service";
import { privateJson, apiError } from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// One application: the submitted profile, the owner, the history of decisions.
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return privateJson(await platformApplication(request.headers, academyId));
  } catch (e) {
    return apiError(e, request);
  }
}
