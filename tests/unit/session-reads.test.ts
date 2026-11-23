// WP2.4: session-scoped reads. A session list needs neither the attendance nor
// the evidence of every session; the open session's attendance and evidence are
// read for that session alone. Counts, the evidence comparison flag and the
// session filters all start from visibleRecords, so no viewer reads more than
// the long-standing endpoints already allowed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { visibleRecords } from "@/server/workspace-access";
import * as recordsRoute from "@/app/api/workspaces/[academyId]/records/[kind]/route";
import type { SessionEvidence, SessionSummary } from "@/domain/records-query";
import type { FootballAttendance } from "@/domain/training";
import { comparableEvidence } from "@/services/training-rules";
import {
  A,
  B,
  callRoute,
  contextFor,
  seedApiFixture,
  type Fixture,
  type Persona,
} from "./helpers/api-harness";

const filename = join(
  tmpdir(),
  `sportozen-session-reads-${randomUUID()}.sqlite`,
);
process.env.SPORTOZEN_DATABASE_PATH = filename;
let fixture: Fixture;
beforeAll(() => {
  fixture = seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const read = (
  as: Persona | undefined,
  kind: string,
  query = "",
  academyId = A,
) =>
  callRoute(recordsRoute.GET, {
    path: `/api/workspaces/${academyId}/records/${kind}${query}`,
    as,
    params: { academyId, kind },
  });
const personas = [
  "ownerA",
  "adminA",
  "coachA",
  "coachB",
  "parent1",
  "parent2",
] as const;

describe("session counts", () => {
  it("match the attendance and evidence each viewer can already read", async () => {
    for (const persona of personas) {
      const ctx = contextFor(persona);
      const response = await read(persona, "session", "?view=summary&counts=1");
      expect(response.status, persona).toBe(200);
      const sessions = response.body as SessionSummary[];
      expect(sessions.map((s) => s.id).sort(), persona).toEqual(
        visibleRecords(ctx, "session")
          .map((s) => s.id)
          .sort(),
      );
      for (const session of sessions) {
        const marks = visibleRecords(ctx, "attendance").filter(
          (a) => a.sessionId === session.id,
        );
        const count = (status: FootballAttendance["status"]) =>
          marks.filter((a) => a.status === status).length;
        expect(session.counts, persona + session.id).toEqual({
          present: count("PRESENT"),
          absent: count("ABSENT"),
          excused: count("EXCUSED"),
          unmarked: count("UNMARKED"),
          awaitingReview: visibleRecords(ctx, "evidence").filter(
            (e) =>
              e.sessionId === session.id &&
              ["DRAFT", "AWAITING_REVIEW"].includes(e.status),
          ).length,
        });
      }
    }
  });
  it("are only added when asked for", async () => {
    const plain = (await read("ownerA", "session", "?view=summary"))
      .body as SessionSummary[];
    expect(plain.length).toBeGreaterThan(0);
    for (const session of plain) expect(session).not.toHaveProperty("counts");
  });
  it("count a coach's own sessions only", async () => {
    const mine = (await read("coachA", "session", "?view=summary&counts=1"))
      .body as SessionSummary[];
    const other = (await read("coachB", "session", "?view=summary&counts=1"))
      .body as SessionSummary[];
    expect(mine.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    const ids = new Set(mine.map((s) => s.id));
    expect(other.some((s) => ids.has(s.id))).toBe(false);
  });
  it("are part of the session summary view only", async () => {
    for (const [kind, query] of [
      ["session", "?counts=1"],
      ["report", "?view=summary&counts=1"],
      ["attendance", "?counts=1"],
      ["session", "?view=summary&counts=2"],
    ] as const)
      expect((await read("ownerA", kind, query)).status, kind + query).toBe(
        400,
      );
  });
});

describe("one session's attendance and evidence", () => {
  it("returns exactly what the viewer could read for that session", async () => {
    for (const persona of personas)
      for (const sessionId of fixture.sessions.slice(0, 3)) {
        const ctx = contextFor(persona);
        for (const kind of ["attendance", "evidence"] as const) {
          const response = await read(persona, kind, `?session=${sessionId}`);
          expect(response.status, persona + kind).toBe(200);
          expect(
            (response.body as { id: string }[]).map((r) => r.id).sort(),
            persona + kind + sessionId,
          ).toEqual(
            (visibleRecords(ctx, kind) as { id: string; sessionId: string }[])
              .filter((r) => r.sessionId === sessionId)
              .map((r) => r.id)
              .sort(),
          );
        }
      }
  });
  it("is empty for a coach whose player is not in the session", async () => {
    const coachA = contextFor("coachA");
    const foreign = visibleRecords(contextFor("coachB"), "session").find(
      (s) => !visibleRecords(coachA, "session").some((v) => v.id === s.id),
    )!;
    for (const kind of ["attendance", "evidence"])
      expect(
        (await read("coachA", kind, `?session=${foreign.id}`)).body,
      ).toEqual([]);
  });
  it("keeps academies apart and refuses outsiders and signed-out users", async () => {
    const session = fixture.sessions[0];
    for (const kind of ["attendance", "evidence"]) {
      expect(
        (await read("ownerB", kind, `?session=${session}`, B)).body,
      ).toEqual([]);
      expect((await read("ownerB", kind, `?session=${session}`)).status).toBe(
        403,
      );
      expect((await read("outsider", kind, `?session=${session}`)).status).toBe(
        403,
      );
      expect((await read(undefined, kind, `?session=${session}`)).status).toBe(
        401,
      );
    }
  });
});

describe("evidence compared with the player's other reviewed records", () => {
  it("flags each record exactly as the whole-payload comparison would", async () => {
    for (const persona of ["ownerA", "coachA", "coachB"] as const) {
      const ctx = contextFor(persona);
      const all = visibleRecords(ctx, "evidence");
      for (const sessionId of fixture.sessions.slice(0, 4)) {
        const response = await read(
          persona,
          "evidence",
          `?session=${sessionId}&compare=1`,
        );
        expect(response.status).toBe(200);
        const items = response.body as SessionEvidence[];
        expect(items.map((e) => e.id).sort()).toEqual(
          all
            .filter((e) => e.sessionId === sessionId)
            .map((e) => e.id)
            .sort(),
        );
        for (const item of items) {
          const { comparablePrevious, ...record } = item;
          expect(record).toEqual(all.find((e) => e.id === item.id));
          expect(comparablePrevious, item.id).toBe(
            all
              .filter((v) => v.id !== item.id && v.playerId === item.playerId)
              .some((v) => comparableEvidence(item, v)),
          );
        }
      }
    }
  });
  it("finds a comparable record when there is one", async () => {
    const session = fixture.sessions[1];
    const items = (
      await read("ownerA", "evidence", `?session=${session}&compare=1`)
    ).body as SessionEvidence[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((e) => e.comparablePrevious)).toBe(true);
  });
  it("is read for one session's evidence only", async () => {
    for (const [kind, query] of [
      ["evidence", "?compare=1"],
      ["evidence", "?player=x&compare=1"],
      ["attendance", "?session=s&compare=1"],
      ["report", "?compare=1"],
      ["evidence", "?session=s&compare=0"],
    ] as const)
      expect((await read("ownerA", kind, query)).status, kind + query).toBe(
        400,
      );
  });
});
