import { apiError } from "@/server/workspace-access";
import { readBytes } from "@/server/http";
import { receiveWebhook, webhookChallenge } from "@/server/whatsapp-webhooks";
export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{academyId:string}>}) {
  try {const {academyId}=await params;return new Response(webhookChallenge(academyId,new URL(request.url)),{headers:{"Cache-Control":"no-store"}});}catch(e){return apiError(e,request);}
}
export async function POST(request:Request,{params}:{params:Promise<{academyId:string}>}) {
  try {const {academyId}=await params;
    // Read with a hard limit as the bytes arrive (a chunked body has no declared length).
    const raw=new TextDecoder().decode(await readBytes(request,1024*1024));
    return Response.json(receiveWebhook(academyId,raw,request.headers.get("x-hub-signature-256")),{headers:{"Cache-Control":"no-store"}});
  }catch(e){return apiError(e,request);}
}
