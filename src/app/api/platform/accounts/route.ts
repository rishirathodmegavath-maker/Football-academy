import { enforceWriteLimit } from "@/server/rate-limit";
import {
  platformAccess,
  platformAccounts,
  configureAccount,
} from "@/server/platform-service";
import {
  sameOrigin,
  privateJson,
  apiError,
  readJson,
} from "@/server/workspace-access";
export async function GET(request: Request) {
  try {
    return privateJson(await platformAccounts(request.headers));
  } catch (e) {
    return apiError(e, request);
  }
}
export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    // Authenticate before reading the body; configureAccount re-checks it.
    const admin = await platformAccess(request.headers);
    enforceWriteLimit(request.headers, admin.id);
    return privateJson(
      await configureAccount(request.headers, await readJson(request)),
    );
  } catch (e) {
    return apiError(e, request);
  }
}
