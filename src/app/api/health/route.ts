// Liveness: the process is up and serving requests. It touches nothing else,
// so a database problem never makes the supervisor restart a healthy process.
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
