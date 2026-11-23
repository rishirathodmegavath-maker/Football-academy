import { authentication } from "@/server/auth";
import { apiError, readBytes } from "@/server/http";
export const runtime = "nodejs";
/** Every authentication request is a few hundred bytes (an address, a password,
 * a code, a token). Anything larger is refused before it is read in full. */
const MAX_AUTH_BODY_BYTES = 16 * 1024;
export async function GET(request: Request) {
  return (await authentication()).handler(request);
}
export async function POST(request: Request) {
  let guarded = request;
  try {
    const body = await readBytes(request, MAX_AUTH_BODY_BYTES);
    // The body was consumed by the size check: hand Better Auth the same bytes.
    guarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body.length ? new Uint8Array(body) : undefined,
    });
  } catch (error) {
    return apiError(error, request);
  }
  return (await authentication()).handler(guarded);
}
