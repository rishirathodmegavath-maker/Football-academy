import { receiveCspReport } from "@/server/csp-report";
export const runtime = "nodejs";
// Posted by browsers, with no cookies and no way to sign in: see csp-report.ts.
export async function POST(request: Request) {
  return receiveCspReport(request);
}
