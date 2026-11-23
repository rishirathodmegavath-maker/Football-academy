import { access, privateJson, apiError } from "@/server/workspace-access";
import { listInvitations } from "@/server/membership-service";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// Owner/Admin: invitations with their delivery state. Tokens are never returned.
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return privateJson(
      listInvitations(await access(request.headers, academyId)),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
