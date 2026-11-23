import { access, privateJson, apiError } from "@/server/workspace-access";
import { communicationJobs } from "@/server/communication-service";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
// One bounded page of the delivery list (newest first by default), filtered by
// state, type, player or a search text. Query: limit (1-100, default 25), cursor
// (from the previous page), state, type, playerId, q, order=newest|oldest.
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    return privateJson(
      communicationJobs(
        await access(request.headers, academyId),
        new URL(request.url).searchParams,
      ),
    );
  } catch (error) {
    return apiError(error, request);
  }
}
