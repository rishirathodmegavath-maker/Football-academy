import { context } from "@/server/workspace-service";
import { playerMessages } from "@/server/records-query";
import { compressibleJson, apiError } from "@/server/workspace-access";
import { WorkspaceError } from "@/server/auth";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
/** What the Messages screen shows for one player, in a single read. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    const query = new URL(request.url).searchParams;
    const player = query.get("player");
    if (!player || [...query.keys()].some((key) => key !== "player"))
      throw new WorkspaceError(
        400,
        "Messages are read for one player: pass player and nothing else.",
      );
    return compressibleJson(
      request,
      playerMessages(await context(request.headers, academyId), player),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
