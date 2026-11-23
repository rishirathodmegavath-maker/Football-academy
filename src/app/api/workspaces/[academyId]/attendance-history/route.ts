import { context } from "@/server/workspace-service";
import {
  attendanceFollowUps,
  playerAttendanceHistory,
} from "@/server/attendance-history-service";
import { privateJson, apiError } from "@/server/workspace-access";
import { WorkspaceError } from "@/server/auth";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string }> };
/** One player's attendance history (`?player=`), or the players who need a
 * follow-up (`?followUp=1`, staff only). Read-only. */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId } = await params;
    const query = new URL(request.url).searchParams;
    const player = query.get("player"),
      followUp = query.get("followUp"),
      extra = [...query.keys()].some((k) => k !== "player" && k !== "followUp");
    if (extra || (player === null) === (followUp === null) || followUp === "")
      throw new WorkspaceError(
        400,
        "Pass either player=<id> or followUp=1, and nothing else.",
      );
    const ctx = await context(request.headers, academyId);
    return privateJson(
      player !== null
        ? playerAttendanceHistory(ctx, player)
        : attendanceFollowUps(ctx),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
