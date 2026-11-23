// Child process for notice-concurrency.test.ts. Waits for a shared start time,
// then runs ONE training command as the given member against the shared
// database file and prints the outcome as a JSON line. Run with
// `node --conditions=react-server --import tsx` so server-only code loads.
import { randomUUID } from "node:crypto";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { trainingAction } from "@/server/training-service";

const [academyId, userId, action, id, expectedVersion, data, startAt] =
  process.argv.slice(2);
const membership = repo.membership(academyId, userId)!;
const ctx = {
  academy: repo.academy(academyId)!,
  membership,
  user: { id: userId, name: userId, email: `${userId}@example.test` },
  lifecycleState: "ACTIVE" as const,
};
// Busy-wait so every process fires inside the same few milliseconds.
while (Date.now() < Number(startAt)) {
  /* wait */
}
try {
  trainingAction(ctx as never, {
    requestId: randomUUID(),
    action,
    id,
    expectedVersion: Number(expectedVersion),
    data: JSON.parse(data),
  });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  const e = error as { status?: number; message?: string };
  console.log(
    JSON.stringify({ ok: false, status: e.status, message: e.message }),
  );
}
