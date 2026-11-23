import type { WorkspaceKind, WorkspaceReport } from "@/domain/workspace";
import {
  context,
  kinds,
  monthlyReportReviewFor,
  saveRecord,
} from "@/server/workspace-service";
import { monthlyReportSources } from "@/server/records-query";
import {
  sameOrigin,
  privateJson,
  compressibleJson,
  apiError,
  readJson,
  visibleRecord,
} from "@/server/workspace-access";
import { WorkspaceError } from "@/server/auth";
export const runtime = "nodejs";
type RouteContext = {
  params: Promise<{ academyId: string; kind: string; recordId: string }>;
};
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { academyId, kind, recordId } = await params;
    if (!kinds.includes(kind as WorkspaceKind))
      throw new WorkspaceError(404, "Unknown resource.");
    const ctx = await context(request.headers, academyId),
      record = visibleRecord(ctx, kind as WorkspaceKind, recordId),
      query = new URL(request.url).searchParams,
      review = query.get("review"),
      sources = query.get("sources");
    if (review === null && sources === null)
      return compressibleJson(request, record);
    // Opening a monthly report re-checks its saved sources against current
    // training records (the list shows only the lightweight indicator), and
    // the review workspace also reads the training records behind them.
    if (
      kind !== "report" ||
      (review !== null && review !== "1") ||
      (sources !== null && sources !== "1")
    )
      throw new WorkspaceError(
        400,
        "That view is not available for this record.",
      );
    const report = record as WorkspaceReport;
    return compressibleJson(request, {
      report,
      ...(review !== null
        ? { review: monthlyReportReviewFor(ctx, [report])[report.id] }
        : {}),
      ...(sources !== null
        ? { sources: monthlyReportSources(ctx, report) }
        : {}),
    });
  } catch (e) {
    return apiError(e, request);
  }
}
export async function PUT(request: Request, { params }: RouteContext) {
  try {
    sameOrigin(request);
    const { academyId, kind, recordId } = await params;
    if (!kinds.includes(kind as WorkspaceKind))
      throw new WorkspaceError(404, "Unknown resource.");
    if (kind === "conversation")
      throw new WorkspaceError(
        405,
        "Use conversation actions to preserve private notes and thread history.",
      );
    const ctx = await context(request.headers, academyId);
    visibleRecord(ctx, kind as WorkspaceKind, recordId);
    return privateJson(
      saveRecord(ctx, kind as WorkspaceKind, await readJson(request), recordId),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
