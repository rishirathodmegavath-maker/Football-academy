import {
  access,
  sameOrigin,
  privateJson,
  apiError,
} from "@/server/workspace-access";
import {
  resendInvitation,
  revokeInvitation,
} from "@/server/membership-service";
export const runtime = "nodejs";
type RouteContext = {
  params: Promise<{ academyId: string; invitationId: string }>;
};
// POST renews the token and queues a new message; DELETE ends the invitation.
export async function POST(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId, invitationId } = await params;
    return privateJson(
      resendInvitation(await access(request.headers, academyId), invitationId),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId, invitationId } = await params;
    return privateJson(
      revokeInvitation(await access(request.headers, academyId), invitationId),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
