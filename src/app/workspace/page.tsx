import { redirect } from "next/navigation";
import { WorkspaceChooser } from "@/features/workspaces/chooser";
import { academyApprovalMode } from "@/server/academy-lifecycle";

// An emailed invitation link is /workspace?invitation=<token>.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ invitation?: string }>;
}) {
  const { invitation } = await searchParams;
  // The emailed link now opens the invitation page, where the person joins in one step.
  if (invitation && /^[0-9a-f]{64}$/.test(invitation))
    redirect(`/join/${invitation}`);
  return (
    <WorkspaceChooser
      initialToken={invitation ?? ""}
      reviewRequired={academyApprovalMode() === "required"}
    />
  );
}
