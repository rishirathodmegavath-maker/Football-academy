import { headers } from "next/headers";
import { context, workspaceBootstrap } from "@/server/workspace-service";
import { AcademyPortal } from "@/features/workspaces/academy-portal";
import { workspacePageDenial } from "@/features/workspaces/workspace-unavailable";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ academyId: string }>;
  searchParams: Promise<{
    player?: string | string[];
    session?: string | string[];
  }>;
}) {
  const { academyId } = await params;
  let bootstrap;
  try {
    bootstrap = workspaceBootstrap(
      await context(await headers(), academyId, "onboarding"),
    );
  } catch (error) {
    return workspacePageDenial(error);
  }
  await searchParams;
  return (
    <AcademyPortal
      key={academyId}
      academyId={academyId}
      initialBootstrap={bootstrap}
    />
  );
}
