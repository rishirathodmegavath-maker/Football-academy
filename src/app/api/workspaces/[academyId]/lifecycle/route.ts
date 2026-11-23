import { context } from "@/server/workspace-service";
import { lifecycleView, submitForApproval } from "@/server/academy-lifecycle";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// The approval status of one academy: readable by its members (managers see the
// checklist and the reviewer's feedback), and the owner's submit/resubmit. Both
// use the "onboarding" scope: they work before the academy is approved.
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return privateJson(
      lifecycleView(await context(request.headers, academyId, "onboarding")),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
export async function POST(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId } = await params;
    return privateJson(
      submitForApproval(
        await context(request.headers, academyId, "onboarding"),
        await readJson(request),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
