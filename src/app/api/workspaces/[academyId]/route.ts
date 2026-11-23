import {
  context,
  parseKinds,
  workspace,
  updateAcademy,
} from "@/server/workspace-service";
import {
  sameOrigin,
  privateJson,
  compressibleJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return compressibleJson(
      request,
      workspace(
        await context(request.headers, academyId),
        parseKinds(new URL(request.url).searchParams.get("kinds")),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId } = await params;
    return privateJson(
      updateAcademy(
        await context(request.headers, academyId, "onboarding"),
        await readJson(request),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
