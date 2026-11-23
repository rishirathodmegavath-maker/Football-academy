import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession } from "@/server/auth";
import type { ReactNode } from "react";
export default async function Layout({ children }: { children: ReactNode }) {
  const session = await currentSession(await headers());
  if (!session) redirect("/sign-in");
  return children;
}
