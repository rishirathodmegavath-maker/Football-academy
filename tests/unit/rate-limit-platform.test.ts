// WP5: the platform-account route calls the write limiter explicitly (it does
// not go through access()), so it gets its own check at a low limit.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "3";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { registerTestUser } from "./helpers/mock-auth";
import * as accountsRoute from "@/app/api/platform/accounts/route";
import { callRoute, seedApiFixture } from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-limit-platform-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
  registerTestUser("platform-limit-admin", "Synthetic Platform Admin");
  database()
    .prepare("INSERT INTO platform_administrators(userId) VALUES(?)")
    .run("platform-limit-admin");
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});
const patch = (user: string) =>
  callRoute(accountsRoute.PATCH, {
    path: "/api/platform/accounts",
    method: "PATCH",
    json: { academyId: "nope", status: "ACTIVE", tier: "PILOT", modules: [] },
    headers: { "x-test-user": user },
  });

describe("platform account changes", () => {
  it("are limited per administrator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2033-01-01T00:00:10Z"));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push((await patch("platform-limit-admin")).status);
      expect(statuses).toEqual([404, 404, 404, 429, 429]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuse a non-administrator before counting anything", async () => {
    const before = Number(
      database()
        .prepare(
          "SELECT COUNT(*) n FROM request_rate_limits WHERE scope LIKE ?",
        )
        .get("write:user:owner-a")?.n,
    );
    expect((await patch("owner-a")).status).toBe(403);
    expect(
      Number(
        database()
          .prepare(
            "SELECT COUNT(*) n FROM request_rate_limits WHERE scope LIKE ?",
          )
          .get("write:user:owner-a")?.n,
      ),
    ).toBe(before);
  });
});
