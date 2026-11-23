import { ResetPassword } from "@/features/workspaces/reset-password";

// The reset link carries a one-time token in the query string.
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <ResetPassword token={token ?? ""} linkFailed={!!error || !token} />;
}
