// Run as its own operating-system process by tests/unit/player-link-race.test.ts (never by vitest directly).
// Each process opens its own connection to the same SQLite file, waits for a "go" file so that all of them start the claim
// together, then calls the real acceptInvitationAs. It prints one JSON line per round: ready, then the outcome.
//
// argv: userPrefix  tokensFile  goDir
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { database } from "@/server/database";
import { acceptInvitationAs } from "@/server/membership-service";

const [, , who, tokensFile, goDir] = process.argv;
const tokens = JSON.parse(readFileSync(tokensFile, "utf8")) as string[];
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const say = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

// Open the database (and run the idempotent migrations) before the race, so the race itself is only the claim.
database().prepare("SELECT 1").get();
say({ ready: who });
tokens.forEach((token, round) => {
  while (!existsSync(join(goDir, `go-${round}`))) sleep(1);
  const userId = `${who}-r${round}`;
  const user = {
    id: userId,
    name: userId,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    image: null,
  };
  try {
    acceptInvitationAs(user as never, token);
    say({ round, userId, ok: true });
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string; name?: string };
    say({ round, userId, ok: false, status: e.status, code: e.code, name: e.name, message: e.message });
  }
});
