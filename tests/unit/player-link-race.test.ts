// A player link works once, even when several people open it at the same moment.
//
// One JavaScript process cannot show this: node:sqlite is synchronous, so two claims inside one process can never overlap.
// This test starts several real operating-system processes. Each opens its own connection to the same database file, waits
// at a barrier (a file that appears), and then calls the real acceptInvitationAs at the same moment. It checks, from
// outside, that exactly one of them joined and that the others left nothing behind.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { createPlayerLink } from "@/server/player-link-service";
import type { WorkspaceAccess } from "@/server/workspace-access";
import type { AcademyConfiguration } from "@/domain/workspace";
import { activateAcademy } from "./helpers/lifecycle";

const RACERS = 4,
  ROUNDS = 3;
const base = join(tmpdir(), `sportozen-link-race-${randomUUID()}`);
const filename = join(base, "race.sqlite");
mkdirSync(base, { recursive: true });
process.env.SPORTOZEN_DATABASE_PATH = filename;
process.env.SPORTOZEN_PLAYER_LINKS_ENABLED = "1";

let academyId = "";
const tokens: string[] = [],
  invitationIds: string[] = [];
const children: ChildProcess[] = [];

beforeAll(() => {
  const db = database();
  academyId = randomUUID();
  const academy = {
    id: academyId,
    academyId,
    name: "Race Academy",
    contactEmail: "race@example.test",
    country: "IN",
    language: "English",
    currency: "INR",
    timezone: "Asia/Kolkata",
    dateLocale: "en-IN",
    measurementSystem: "METRIC",
    brandAccent: "#008463",
    sportIds: ["football"],
    ageGroups: ["U12"],
    reviewFrequency: "Monthly",
    modules: ["development", "reports", "communication", "fees", "update"],
    nutritionOptional: true,
    demo: true,
    onboardingStatus: "ACTIVE",
  } as AcademyConfiguration;
  db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(academyId, JSON.stringify(academy));
  db.prepare("INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)").run(
    academyId,
    "TEST",
    JSON.stringify(academy.modules),
    "ACTIVE",
  );
  activateAcademy(db, academyId);
  db.prepare("INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)").run(
    academyId + "-owner",
    academyId,
    "owner",
    "OWNER",
    '["football"]',
  );
  const owner = {
    academy,
    membership: { id: "m-owner", userId: "owner", academyId, role: "OWNER", active: true, sportIds: ["football"] },
    user: { id: "owner", name: "owner", email: "owner@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date(), image: null },
  } as unknown as WorkspaceAccess;
  for (let round = 0; round < ROUNDS; round++) {
    const link = createPlayerLink(owner, {});
    tokens.push(link.token);
    invitationIds.push(link.id);
  }
  writeFileSync(join(base, "tokens.json"), JSON.stringify(tokens));
  mkdirSync(join(base, "go"), { recursive: true });
});
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  database().close();
  rmSync(base, { recursive: true, force: true });
});

type Outcome = { round: number; userId: string; ok: boolean; status?: number; code?: string; message?: string };

describe("one link, several people at the same moment (real processes)", () => {
  it("lets exactly one person in per link, and the others leave nothing behind", async () => {
    const lines: Outcome[] = [],
      ready = new Set<string>(),
      failures: string[] = [];
    const waiters: (() => void)[] = [];
    const notify = () => waiters.splice(0).forEach((w) => w());
    const until = (condition: () => boolean, label: string, ms = 60_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
        const check = () => {
          if (failures.length) return reject(new Error(failures.join("\n")));
          if (condition()) {
            clearTimeout(timer);
            return resolve();
          }
          waiters.push(check);
        };
        check();
      });
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    for (let i = 0; i < RACERS; i++) {
      const who = `racer${i}`;
      const child = spawn(
        process.execPath,
        [tsx, join(process.cwd(), "tests", "unit", "helpers", "claim-worker.ts"), who, join(base, "tokens.json"), join(base, "go")],
        {
          // react-server lets "server-only" load outside Next.js, exactly as the build does for server code.
          env: { ...process.env, NODE_OPTIONS: "--conditions=react-server --no-warnings", SPORTOZEN_DATABASE_PATH: filename },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (d) => (stderr += String(d)));
      child.on("exit", (code) => {
        if (code !== 0) failures.push(`worker ${who} exited ${code}: ${stderr.slice(0, 600)}`);
        notify();
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const value = JSON.parse(line) as Outcome & { ready?: string };
        if (value.ready) ready.add(value.ready);
        else lines.push(value);
        notify();
      });
    }
    await until(() => ready.size === RACERS, "all workers to be ready");

    for (let round = 0; round < ROUNDS; round++) {
      writeFileSync(join(base, "go", `go-${round}`), "");
      await until(() => lines.filter((l) => l.round === round).length === RACERS, `round ${round} results`);
    }
    await until(() => children.every((c) => c.exitCode !== null), "workers to exit");

    const db = database();
    const summary: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const results = lines.filter((l) => l.round === round);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      // exactly one winner
      expect(winners, `round ${round}: winners`).toHaveLength(1);
      expect(losers).toHaveLength(RACERS - 1);
      // every loser was refused by the application, never by a crash or a locked database
      for (const loser of losers) {
        // a refusal from the application (it carries an HTTP status), not a crash or a locked database
        expect([403, 409], JSON.stringify(loser)).toContain(loser.status);
        expect(loser.message ?? "").not.toMatch(/locked|busy/i);
      }
      summary.push(`round ${round}: ${winners[0].userId} won; refused: ${losers.map((l) => `${l.status} "${l.message}"`).join(" | ")}`);
      const racers = results.map((r) => r.userId);
      // the link is used exactly once
      const invitation = db.prepare("SELECT acceptedAt FROM workspace_invitations WHERE id=?").get(invitationIds[round]) as { acceptedAt: string | null };
      expect(invitation.acceptedAt).toBeTruthy();
      // only the winner joined this academy; nobody else has a membership, a pending form or a record of using this link
      const members = racers.filter((id) => db.prepare("SELECT 1 FROM academy_memberships WHERE academyId=? AND userId=?").get(academyId, id));
      expect(members).toEqual([winners[0].userId]);
      const pending = db.prepare("SELECT userId FROM player_self_pending WHERE academyId=? AND invitationId=?").all(academyId, invitationIds[round]);
      expect(pending).toEqual([{ userId: winners[0].userId }]);
      const audited = db.prepare("SELECT COUNT(*) n FROM workspace_audit WHERE resourceId=? AND action LIKE 'Player invitation link used%'").get(invitationIds[round]);
      expect(audited).toMatchObject({ n: 1 });
    }
    // The distribution is printed so a reviewer can see the race really happened: refused 403 = read the link after it was used;
    // refused 409 = passed the first check and lost at the claim, which is the guard this test exists for.
    console.log("player-link race:\n  " + summary.join("\n  "));
  }, 120_000);
});
