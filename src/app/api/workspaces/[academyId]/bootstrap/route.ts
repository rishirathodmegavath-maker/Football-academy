import { context, workspaceBootstrap } from "@/server/workspace-service";
import { privateJson, apiError } from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return privateJson(
      workspaceBootstrap(
        await context(request.headers, academyId, "onboarding"),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
