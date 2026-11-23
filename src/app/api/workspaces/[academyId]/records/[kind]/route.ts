import type { WorkspaceKind } from "@/domain/workspace";
import { context, kinds, saveRecord } from "@/server/workspace-service";
import {
  sameOrigin,
  privateJson,
  compressibleJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
import { queryRecords } from "@/server/records-query";
import { WorkspaceError } from "@/server/auth";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ academyId: string; kind: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId, kind } = await params;
    if (!kinds.includes(kind as WorkspaceKind))
      throw new WorkspaceError(404, "Unknown resource.");
    return compressibleJson(
      request,
      queryRecords(
        await context(request.headers, academyId),
        kind as WorkspaceKind,
        new URL(request.url).searchParams,
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
export async function POST(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId, kind } = await params;
    if (!kinds.includes(kind as WorkspaceKind))
      throw new WorkspaceError(404, "Unknown resource.");
    return privateJson(
      saveRecord(
        await context(request.headers, academyId),
        kind as WorkspaceKind,
        await readJson(request),
      ),
      201,
    );
  } catch (e) {
    return apiError(e, request);
  }
}
