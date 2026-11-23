import { enforceWriteLimit } from "@/server/rate-limit";
import { platformAccess, platformDecision } from "@/server/platform-service";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// start review / approve / reject / suspend / reactivate. Authenticated as a
// platform administrator before the body is read; an academy owner is refused.
export async function POST(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const admin = await platformAccess(request.headers);
    enforceWriteLimit(request.headers, admin.id);
    const { academyId } = await params;
    return privateJson(
      await platformDecision(
        request.headers,
        academyId,
        await readJson(request),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
