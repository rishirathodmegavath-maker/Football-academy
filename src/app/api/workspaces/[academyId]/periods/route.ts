import { access, sameOrigin, privateJson, apiError, readJson } from "@/server/workspace-access";
import { periodAction } from "@/server/period-service";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{academyId:string}>}) {
  try {sameOrigin(request);const {academyId}=await params;return privateJson(periodAction(await access(request.headers,academyId),await readJson(request)));}catch(e){return apiError(e, request);}
}
