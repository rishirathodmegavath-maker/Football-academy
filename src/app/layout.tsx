import type { Metadata } from "next";
import "@/styles/globals.css";
export const metadata: Metadata = {
  title: "Sportozen Academy",
  description: "One team. A different development path for every player.",
};
// Every page is rendered per request: src/proxy.ts creates a Content-Security-
// Policy nonce for each response, and Next.js can only stamp it on its scripts
// while rendering (docs/SECURITY_HARDENING.md, section 2).
export const dynamic = "force-dynamic";
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
