import { z } from "zod";
import { enforceRateLimit, enforceWriteLimit } from "@/server/rate-limit";
import { authenticatedUser } from "@/server/auth";
import { acceptInvitation } from "@/server/workspace-service";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    // Authenticate before reading the body; acceptInvitation re-checks it.
    const user = await authenticatedUser(request.headers);
    enforceWriteLimit(request.headers, user.id);
    // Tokens are 256-bit, so guessing is infeasible; this stops a signed-in
    // account from probing the endpoint at machine speed.
    enforceRateLimit(user.id, {
      name: "invitation-accept",
      max: 10,
      windowSeconds: 60,
    });
    const { token, phone } = z
      .object({
        token: z.string().length(64),
        phone: z.string().max(40).optional(),
      })
      .parse(await readJson(request));
    return privateJson(await acceptInvitation(request.headers, token, phone));
  } catch (e) {
    return apiError(e, request);
  }
}
