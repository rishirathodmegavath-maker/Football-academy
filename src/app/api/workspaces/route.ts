import { authenticatedUser } from "@/server/auth";
import { enforceRateLimit, enforceWriteLimit } from "@/server/rate-limit";
import { createAcademy, workspaces } from "@/server/workspace-service";
import { requireVerifiedEmail } from "@/server/verified-email";
import { mfaStatus, requireMfa } from "@/server/mfa-policy";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await authenticatedUser(request.headers);
    const account = mfaStatus(user);
    return privateJson({
      user: { id: user.id, name: user.name },
      account,
      // Until a required second step is set up, no academy details are listed.
      workspaces:
        account.required && !account.enabled ? [] : workspaces(user.id),
    });
  } catch (e) {
    return apiError(e, request);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    // Authenticate before reading the body; createAcademy re-checks it.
    const user = await authenticatedUser(request.headers);
    enforceWriteLimit(request.headers, user.id);
    // With e-mail verification on, only a verified address can create tenants.
    requireVerifiedEmail(user);
    // Creating an academy makes the person its OWNER: same two-step rule.
    requireMfa(user, "CREATE_ACADEMY");
    // Anyone with an account may start an academy; cap how fast one person
    // can create them so storage cannot be filled with empty workspaces.
    enforceRateLimit(user.id, {
      name: "academy-create",
      max: 10,
      windowSeconds: 3600,
    });
    return privateJson(
      await createAcademy(request.headers, await readJson(request)),
      201,
    );
  } catch (e) {
    return apiError(e, request);
  }
}
