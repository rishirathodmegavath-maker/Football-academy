import {
  access,
  sameOrigin,
  privateJson,
  compressibleJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
import { trainingAction, trainingHistory } from "@/server/training-service";
import { z } from "zod";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ academyId: string }> },
) {
  try {
    const { academyId } = await params,
      // Who is asking is settled before the query is even read, so a caller
      // without access learns nothing about what the route expects.
      ctx = await access(request.headers, academyId),
      url = new URL(request.url),
      kind = z
        .enum([
          "squad",
          "venue",
          "session",
          "attendance",
          "evidence",
          "series",
          "wrapup",
        ])
        .parse(url.searchParams.get("kind")),
      id = z.string().min(1).parse(url.searchParams.get("id"));
    return compressibleJson(request, trainingHistory(ctx, kind, id));
  } catch (e) {
    return apiError(e, request);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ academyId: string }> },
) {
  try {
    sameOrigin(request);
    const { academyId } = await params;
    return privateJson(
      trainingAction(
        await access(request.headers, academyId),
        await readJson(request),
      ),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
