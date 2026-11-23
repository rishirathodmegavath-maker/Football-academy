import { z } from "zod";
import { confirmInvitationEmail } from "@/server/membership-service";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export const runtime = "nodejs";
// Opened from the invitation page before sign-in: the person has no session
// yet. The 256-bit single-use token is the proof; nothing is returned except
// whether an address was confirmed.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { token } = z
      .object({ token: z.string().length(64) })
      .parse(await readJson(request));
    return privateJson(confirmInvitationEmail(token));
  } catch (e) {
    return apiError(e, request);
  }
}
