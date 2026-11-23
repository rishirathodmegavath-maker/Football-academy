// Phase 7: the Communication delivery list is read one bounded page at a time
// (GET /communication/jobs) instead of loading every job of the academy. These
// tests walk a large history page by page and prove: every job appears exactly
// once, in order; the response is bounded; filters and search narrow it
// without loading everything; new jobs arriving between pages neither repeat
// nor skip a row; each role sees only what it may; another academy's data can
// not be reached with any parameter or cursor; and the queries use the indexes
// of migration 012.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import * as jobsRoute from "@/app/api/workspaces/[academyId]/communication/jobs/route";
import * as viewRoute from "@/app/api/workspaces/[academyId]/communication/route";
import { migrateDeliveryJobPaging } from "@/server/migrations/012-delivery-job-paging";
import type { DeliveryJobPage } from "@/domain/communication";
import {
  A,
  B,
  ids,
  callRoute,
  seedApiFixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-jobs-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;

const N_A = 900; // person-addressed jobs in academy A
const N_B = 400; // and in academy B
const STATES = ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "CANCELLED"];
const players = [ids.p1, ids.p2, ids.p3];
const stamp = (n: number) =>
  new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
let counter = 0;
let insert: ReturnType<ReturnType<typeof database>["prepare"]>;
const addJob = (
  id: string,
  academyId: string,
  playerId: string,
  guardianId: string,
  at: string,
  extra: {
    type?: string;
    state?: string;
    period?: string;
    reason?: string;
  } = {},
) =>
  insert.run(
    id,
    academyId,
    playerId,
    guardianId,
    extra.type ?? "WEEKLY",
    `src-${id}`,
    1,
    extra.period ?? `P${String(counter++).padStart(4, "0")}`,
    "",
    at,
    stamp(100_000),
    extra.state ?? "QUEUED",
    extra.reason ?? null,
  );
beforeAll(() => {
  seedApiFixture();
  const db = database();
  insert = db.prepare(
    "INSERT INTO delivery_jobs(id,academyId,playerId,guardianId,type,sourceId,sourceVersion,period,correction,dueAt,expiresAt,state,attempts,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < N_A; i++) {
    // Many jobs share a due time: the page boundary must still be exact.
    const at = stamp(Math.floor(i / 3));
    addJob(
      `a-${String(i).padStart(4, "0")}`,
      A,
      players[i % 3],
      i % 3 === 0 ? ids.parent1 : i % 3 === 1 ? ids.parent2 : "parent-3",
      at,
      {
        state: STATES[i % STATES.length],
        type: i % 11 === 0 ? "MONTHLY" : "WEEKLY",
        reason: i % 50 === 0 ? "Parent replied 100% sure_thing" : undefined,
      },
    );
  }
  for (let i = 0; i < N_B; i++)
    addJob(
      `b-${String(i).padStart(4, "0")}`,
      B,
      ids.bPlayer,
      "b-guardian",
      stamp(Math.floor(i / 2)),
    );
  // Announcement jobs belong to the announcement dialog, not to this list.
  for (let i = 0; i < 40; i++)
    addJob(`n-${String(i).padStart(4, "0")}`, A, "", ids.parent1, stamp(i), {
      type: "ANNOUNCEMENT",
    });
  db.exec("COMMIT");
  migrateDeliveryJobPaging(db); // idempotent: a second run changes nothing
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const get = (persona: Persona | undefined, query = "", academyId = A) =>
  callRoute(jobsRoute.GET, {
    path: `/api/workspaces/${academyId}/communication/jobs${query ? "?" + query : ""}`,
    as: persona,
    params: { academyId },
  });
const page = async (persona: Persona, query = "", academyId = A) => {
  const res = await get(persona, query, academyId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as DeliveryJobPage;
};
async function walk(persona: Persona, query: string, academyId = A) {
  const all: DeliveryJobPage["jobs"] = [];
  let cursor: string | null = null,
    pages = 0;
  do {
    const p: DeliveryJobPage = await page(
      persona,
      cursor ? `${query}&cursor=${cursor}` : query,
      academyId,
    );
    all.push(...p.jobs);
    cursor = p.nextCursor;
    pages++;
    expect(pages).toBeLessThan(200);
  } while (cursor);
  return { all, pages };
}

describe("a bounded, ordered, complete walk", () => {
  it("returns the default page size, never more than the limit", async () => {
    const first = await page("ownerA");
    expect(first.jobs).toHaveLength(25);
    expect(first.limit).toBe(25);
    expect(first.nextCursor).toBeTruthy();
    for (const limit of [1, 7, 100])
      expect((await page("ownerA", `limit=${limit}`)).jobs).toHaveLength(limit);
  });
  it("refuses a limit above the maximum or below one", async () => {
    for (const limit of ["101", "100000", "0", "-5", "x"])
      expect((await get("ownerA", `limit=${limit}`)).status, limit).toBe(400);
  });
  it("shows every job exactly once, newest first, with no announcement jobs", async () => {
    const { all, pages } = await walk("ownerA", "limit=50");
    expect(all).toHaveLength(N_A);
    expect(pages).toBe(Math.ceil(N_A / 50));
    expect(new Set(all.map((j) => j.id)).size).toBe(N_A);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1],
        b = all[i];
      expect(
        a.dueAt > b.dueAt || (a.dueAt === b.dueAt && a.id > b.id),
        `${a.id} before ${b.id}`,
      ).toBe(true);
    }
    expect(all.some((j) => j.type === "ANNOUNCEMENT")).toBe(false);
  });
  it("walks oldest first the other way round", async () => {
    const { all } = await walk("ownerA", "limit=100&order=oldest");
    expect(all).toHaveLength(N_A);
    expect(all[0].dueAt <= all[all.length - 1].dueAt).toBe(true);
    const newest = await walk("ownerA", "limit=100");
    expect(all.map((j) => j.id)).toEqual(newest.all.map((j) => j.id).reverse());
  });
  it("shows no claim, lease, provider receipt or academy id", async () => {
    const text = JSON.stringify((await page("ownerA", "limit=100")).jobs);
    for (const hidden of ["claim", "providerId", "academyId", "expiresAt"])
      expect(text).not.toContain(hidden);
  });
  it("the plain Communication view carries only the newest page and says there is more", async () => {
    const res = await callRoute(viewRoute.GET, {
      path: `/api/workspaces/${A}/communication`,
      as: "ownerA",
      params: { academyId: A },
    });
    const body = res.body as { jobs: unknown[]; jobsMore: boolean };
    expect(res.status).toBe(200);
    expect(body.jobs).toHaveLength(25);
    expect(body.jobsMore).toBe(true);
  });
});

describe("filters, order and search", () => {
  it("filters by state, type and player, alone and together", async () => {
    const queued = await walk("ownerA", "state=QUEUED&limit=100");
    expect(queued.all).toHaveLength(N_A / STATES.length);
    expect(queued.all.every((j) => j.state === "QUEUED")).toBe(true);
    const monthly = await walk("ownerA", "type=MONTHLY&limit=100");
    expect(monthly.all.length).toBe(Math.ceil(N_A / 11));
    expect(monthly.all.every((j) => j.type === "MONTHLY")).toBe(true);
    const one = await walk("ownerA", `playerId=${ids.p2}&state=SENT&limit=20`);
    expect(
      one.all.every((j) => j.playerId === ids.p2 && j.state === "SENT"),
    ).toBe(true);
    expect(one.all.length).toBeGreaterThan(0);
  });
  it("refuses an unknown state, type or order", async () => {
    for (const q of ["state=BOGUS", "type=ANNOUNCEMENT", "order=sideways"])
      expect((await get("ownerA", q)).status, q).toBe(400);
  });
  it("searches player names, guardian names, periods and reasons", async () => {
    const byPlayer = await walk("ownerA", "q=Kabir&limit=100");
    expect(byPlayer.all.length).toBe(N_A / 3);
    expect(byPlayer.all.every((j) => j.playerId === ids.p2)).toBe(true);
    const byGuardian = await walk("ownerA", "q=Parent%20One&limit=100");
    expect(byGuardian.all.every((j) => j.guardianId === ids.parent1)).toBe(
      true,
    );
    expect(byGuardian.all.length).toBeGreaterThan(0);
    const byPeriod = await walk("ownerA", "q=P0007&limit=100");
    expect(byPeriod.all.map((j) => j.period)).toEqual(["P0007"]);
    const byReason = await walk("ownerA", "q=replied&limit=100");
    expect(byReason.all).toHaveLength(N_A / 50);
  });
  it("treats % and _ in the search box as plain text", async () => {
    expect((await walk("ownerA", "q=100%25%20sure_thing")).all).toHaveLength(
      N_A / 50,
    );
    expect((await page("ownerA", "q=%25")).jobs.length).toBe(N_A / 50);
    expect((await page("ownerA", "q=_")).jobs.length).toBe(N_A / 50);
    expect((await page("ownerA", "q=zzz-nothing")).jobs).toEqual([]);
  });
  it("answers an empty result with an empty page, not an error", async () => {
    const p = await page("ownerA", "state=UNKNOWN");
    expect(p).toEqual({ jobs: [], nextCursor: null, limit: 25 });
  });
});

describe("jobs arriving while a person pages through", () => {
  it("neither repeats nor skips a row, and the first page shows the new ones", async () => {
    const first = await page("ownerA", "limit=40");
    const seen = new Set(first.jobs.map((j) => j.id));
    // A newer job and an older one arrive after page one was served.
    addJob("a-new-1", A, ids.p1, ids.parent1, stamp(999_999));
    addJob("a-new-2", A, ids.p2, ids.parent2, stamp(0), { state: "QUEUED" });
    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const p: DeliveryJobPage = await page(
        "ownerA",
        `limit=40&cursor=${cursor}`,
      );
      for (const j of p.jobs) {
        expect(seen.has(j.id), `repeated ${j.id}`).toBe(false);
        rest.push(j.id);
      }
      cursor = p.nextCursor;
    }
    expect(rest).not.toContain("a-new-1"); // newer than the position: seen on refresh
    expect(rest).toContain("a-new-2"); // older than the position: still ahead
    expect(seen.size + rest.length).toBe(N_A + 1);
    expect((await page("ownerA", "limit=1")).jobs[0].id).toBe("a-new-1");
    database()
      .prepare("DELETE FROM delivery_jobs WHERE id LIKE 'a-new-%'")
      .run();
  });
  it("a job removed between pages does not disturb the position", async () => {
    const first = await page("ownerA", "limit=30");
    database()
      .prepare("DELETE FROM delivery_jobs WHERE id=?")
      .run(first.jobs[29].id);
    const next = await page("ownerA", `limit=30&cursor=${first.nextCursor}`);
    expect(next.jobs).toHaveLength(30);
    expect(first.jobs.map((j) => j.id)).not.toContain(next.jobs[0].id);
    addJob(first.jobs[29].id, A, ids.p1, ids.parent1, first.jobs[29].dueAt);
  });
  it("refuses a damaged cursor, and a cursor made for the other order", async () => {
    for (const cursor of [
      "x",
      "e30",
      "W10",
      Buffer.from("[1,2,3]").toString("base64url"),
    ])
      expect((await get("ownerA", `cursor=${cursor}`)).status, cursor).toBe(
        400,
      );
    const p = await page("ownerA", "limit=5");
    expect(
      (await get("ownerA", `limit=5&order=oldest&cursor=${p.nextCursor}`))
        .status,
    ).toBe(400);
  });
});

describe("who sees what", () => {
  it("a parent sees only their own messages about their own child", async () => {
    const { all } = await walk("parent1", "limit=100");
    expect(all.length).toBe(N_A / 3);
    expect(
      all.every((j) => j.guardianId === ids.parent1 && j.playerId === ids.p1),
    ).toBe(true);
    const other = await walk("parent2", "limit=100");
    expect(other.all.every((j) => j.guardianId === ids.parent2)).toBe(true);
    expect(new Set([...all, ...other.all].map((j) => j.id)).size).toBe(
      all.length + other.all.length,
    );
  });
  it("a parent does not see a message addressed to another guardian of the same child", async () => {
    // A child can have two guardians; each is only shown their own messages.
    for (let i = 0; i < 3; i++)
      addJob(`x-${i}`, A, ids.p1, "other-guardian", stamp(5_000_000 + i));
    try {
      const mine = await walk("parent1", "limit=100");
      expect(mine.all.some((j) => j.id.startsWith("x-"))).toBe(false);
      expect(mine.all).toHaveLength(N_A / 3);
      // staff see all of them
      const staff = await walk("ownerA", `playerId=${ids.p1}&limit=100`);
      expect(staff.all.filter((j) => j.id.startsWith("x-"))).toHaveLength(3);
    } finally {
      database().prepare("DELETE FROM delivery_jobs WHERE id LIKE 'x-%'").run();
    }
  });
  it("a parent cannot name another family's child, nor search for another family", async () => {
    expect(
      (await get("parent1", `playerId=${ids.p2}`)).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (await get("parent1", `playerId=${ids.bPlayer}`)).status,
    ).toBeGreaterThanOrEqual(403);
    const search = await walk("parent1", "q=Kabir&limit=100");
    expect(search.all).toEqual([]);
    const byGuardian = await walk("parent1", "q=Parent%20Two&limit=100");
    expect(byGuardian.all).toEqual([]);
  });
  it("a coach sees only the players they coach", async () => {
    const a = await walk("coachA", "limit=100");
    expect(
      a.all.every((j) => [ids.p1, ids.p2].includes(j.playerId as never)),
    ).toBe(true);
    expect(a.all.length).toBe((N_A / 3) * 2);
    const b = await walk("coachB", "limit=100");
    expect(b.all.every((j) => j.playerId === ids.p3)).toBe(true);
    expect(
      (await get("coachA", `playerId=${ids.p3}`)).status,
    ).toBeGreaterThanOrEqual(403);
  });
  it("another academy's owner reads only their own academy, whatever they pass", async () => {
    const own = await walk("ownerB", "limit=100", B);
    expect(own.all).toHaveLength(N_B);
    expect(own.all.every((j) => j.id.startsWith("b-"))).toBe(true);
    // Academy A's position, id and player names mean nothing inside academy B.
    const cursorA = (await page("ownerA", "limit=5")).nextCursor;
    const stolen = await page("ownerB", `limit=100&cursor=${cursorA}`, B);
    expect(stolen.jobs.every((j) => j.id.startsWith("b-"))).toBe(true);
    expect(
      (await get("ownerB", `playerId=${ids.p1}`, B)).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await page("ownerB", "q=Asha", B)).jobs).toEqual([]);
    // and the other way round
    expect((await get("ownerB", "", A)).status).toBe(403);
    expect((await get("outsider")).status).toBe(403);
    expect((await get(undefined)).status).toBe(401);
  });
  it("says nothing about SQL, paths or stacks when it refuses", async () => {
    for (const q of ["limit=x", "cursor=zz", "state=%27%3B--"]) {
      const text = JSON.stringify((await get("ownerA", q)).body);
      expect(text).not.toMatch(/SELECT|sqlite|stack|node_modules|json_each/i);
    }
  });
});

describe("the queries use the indexes of migration 012", () => {
  const plan = (sql: string, ...args: (string | number)[]) =>
    database()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((r) => String(r.detail))
      .join(" | ");
  const base =
    "SELECT id FROM delivery_jobs WHERE academyId=? AND playerId<>''";
  it("the academy-wide page reads the index in order, with no sort", () => {
    const p = plan(`${base} ORDER BY dueAt DESC, id DESC LIMIT 26`, A);
    expect(p).toContain("delivery_jobs_page");
    expect(p).not.toContain("TEMP B-TREE");
  });
  it("a player, a guardian and a state each have their own index", () => {
    const player = plan(
      `${base} AND playerId=? ORDER BY dueAt DESC, id DESC LIMIT 26`,
      A,
      ids.p1,
    );
    expect(player).toContain("delivery_jobs_page_player");
    expect(player).not.toContain("TEMP B-TREE");
    const guardian = plan(
      `${base} AND guardianId=? ORDER BY dueAt DESC, id DESC LIMIT 26`,
      A,
      ids.parent1,
    );
    expect(guardian).toContain("delivery_jobs_page_guardian");
    expect(guardian).not.toContain("TEMP B-TREE");
    const state = plan(
      `${base} AND state=? ORDER BY dueAt DESC, id DESC LIMIT 26`,
      A,
      "QUEUED",
    );
    expect(state).toContain("delivery_jobs_page_state");
    expect(state).not.toContain("TEMP B-TREE");
  });
  it("the next page starts from the cursor instead of skipping rows", () => {
    const p = plan(
      `${base} AND (dueAt,id) < (?,?) ORDER BY dueAt DESC, id DESC LIMIT 26`,
      A,
      stamp(10),
      "a-0001",
    );
    expect(p).toMatch(/delivery_jobs_page.*\(academyId=\? AND/);
    expect(p).not.toContain("TEMP B-TREE");
  });
  it("the migration is idempotent and changes no row", () => {
    const count = () =>
      Number(
        database().prepare("SELECT COUNT(*) n FROM delivery_jobs").get()!.n,
      );
    const before = count();
    migrateDeliveryJobPaging(database());
    migrateDeliveryJobPaging(database());
    expect(count()).toBe(before);
  });
});
