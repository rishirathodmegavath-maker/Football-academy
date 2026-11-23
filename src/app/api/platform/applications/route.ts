import { platformApplications } from "@/server/platform-service";
import { privateJson, apiError } from "@/server/workspace-access";
export const runtime = "nodejs";
// The review queue for platform administrators (?state=, ?q=, ?limit=, ?offset=).
export async function GET(request: Request) {
  try {
    return privateJson(
      await platformApplications(
        request.headers,
        new URL(request.url).searchParams,
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
