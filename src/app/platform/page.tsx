import { headers } from "next/headers";
import { platformApplications } from "@/server/platform-service";
import { PlatformAccounts } from "@/features/workspaces/platform-accounts";
import { workspacePageDenial } from "@/features/workspaces/workspace-unavailable";
export default async function Page() {
  let initial: Awaited<ReturnType<typeof platformApplications>>;
  try {
    initial = await platformApplications(await headers(), new URLSearchParams());
  } catch (error) {
    return workspacePageDenial(error);
  }
  return <PlatformAccounts initial={initial} />;
}
