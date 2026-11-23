import { access, privateJson, apiError } from "@/server/workspace-access";
import { guardianAnnouncements } from "@/server/batch-announcement-service";
import { guardianMessages } from "@/server/messaging-service";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// What a guardian reads in the app. Staff manage announcements through
// /communication/announcements; this read is limited to guardians and returns
// only approved, unexpired, generic announcements for their own children's batches.
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    const ctx = await access(request.headers, academyId);
    return privateJson({
      announcements: guardianAnnouncements(ctx),
      // Portal messages sent from the Communications screen (processed, for this parent's own children).
      messages: guardianMessages(ctx),
    });
  } catch (error) {
    return apiError(error, request);
  }
}
