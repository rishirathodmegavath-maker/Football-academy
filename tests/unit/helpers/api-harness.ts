// API baseline harness: a deterministic synthetic fixture, a route caller and a
// SQL statement counter. Test files mock "server-only" and "@/server/auth"
// (with ./mock-auth) and set SPORTOZEN_DATABASE_PATH to a temporary file
// before the first database() call.
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { database } from "@/server/database";
import { workspaceRepository as repo } from "@/server/workspace-repository";
import { saveRecord, approveReport } from "@/server/workspace-service";
import { financeAction } from "@/server/finance-service";
import type { WorkspaceAccess } from "@/server/workspace-access";
import type {
  AcademyConfiguration,
  AcademyRole,
  WorkspacePlayer,
} from "@/domain/workspace";
import type {
  FootballAttendance,
  FootballEvidence,
  FootballSession,
  FootballSquad,
  FootballVenue,
} from "@/domain/training";
import { registerTestUser, type TestUser } from "./mock-auth";
import { activateAcademy } from "./lifecycle";
import { lifecycleOf } from "@/server/academy-lifecycle-state";

export const ORIGIN = "http://127.0.0.1:3000";
export const A = "academy-a",
  B = "academy-b";
/** Two families in academy A: parent1 → p1, parent2 → p2. Coach A owns p1 and
 * p2, coach B owns p3. Academy B is a separate tenant with one player. */
export const ids = {
  ownerA: "owner-a",
  adminA: "admin-a",
  coachA: "coach-a",
  coachB: "coach-b",
  parent1: "parent-1",
  parent2: "parent-2",
  outsider: "outsider",
  ownerB: "owner-b",
  p1: "player-1",
  p2: "player-2",
  p3: "player-3",
  bPlayer: "player-b1",
  branch: "branch-a",
  squadA: "squad-a",
  squadB: "squad-b",
  venue: "venue-a",
  drill: "drill-a",
} as const;
export type Persona =
  | "ownerA"
  | "adminA"
  | "coachA"
  | "coachB"
  | "parent1"
  | "parent2"
  | "outsider"
  | "ownerB";

function academyConfig(id: string, name: string): AcademyConfiguration {
  return {
    id,
    academyId: id,
    name,
    contactEmail: `${id}@example.test`,
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
    modules: ["development", "reports", "communication", "fees"],
    nutritionOptional: true,
    demo: false,
    onboardingStatus: "ACTIVE",
  };
}
export const users = {} as Record<Persona, TestUser>;
export function contextFor(persona: Persona): WorkspaceAccess {
  const academyId = persona === "ownerB" ? B : A;
  const membership = repo.membership(academyId, ids[persona]);
  if (!membership) throw new Error(`No fixture membership for ${persona}`);
  return {
    academy: repo.academy(academyId)!,
    membership,
    user: users[persona],
    // What access() hands every service: the approval state it already read.
    lifecycleState: lifecycleOf(academyId)?.state,
  };
}

export interface Fixture {
  sessions: string[];
  reports: Record<string, string>;
  invoices: Record<string, string>;
  attendance: number;
  evidence: number;
}
/** Seeds both academies through the real services where the flow is short,
 * and through the repository for training records (as other unit tests do). */
export function seedApiFixture(): Fixture {
  process.env.BETTER_AUTH_URL = ORIGIN;
  const db = database();
  db.exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,name TEXT NOT NULL)',
  );
  const names: Record<Persona, string> = {
    ownerA: "Synthetic Owner A",
    adminA: "Synthetic Admin A",
    coachA: "Synthetic Coach A",
    coachB: "Synthetic Coach B",
    parent1: "Synthetic Parent One",
    parent2: "Synthetic Parent Two",
    outsider: "Synthetic Outsider",
    ownerB: "Synthetic Owner B",
  };
  for (const persona of Object.keys(names) as Persona[]) {
    users[persona] = registerTestUser(ids[persona], names[persona]);
    db.prepare('INSERT OR REPLACE INTO "user"(id,name) VALUES(?,?)').run(
      ids[persona],
      names[persona],
    );
  }
  for (const [id, name] of [
    [A, "Synthetic Academy A"],
    [B, "Synthetic Academy B"],
  ] as const) {
    const config = academyConfig(id, name);
    db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(
      id,
      JSON.stringify(config),
    );
    db.prepare(
      "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)",
    ).run(id, "TEST", JSON.stringify(config.modules), "ACTIVE");
    activateAcademy(db, id);
  }
  const memberships: [string, Persona, AcademyRole][] = [
    [A, "ownerA", "OWNER"],
    [A, "adminA", "ADMIN"],
    [A, "coachA", "COACH"],
    [A, "coachB", "COACH"],
    [A, "parent1", "PARENT"],
    [A, "parent2", "PARENT"],
    [B, "ownerB", "OWNER"],
  ];
  for (const [academyId, persona, role] of memberships)
    db.prepare(
      "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
    ).run(`m-${ids[persona]}`, academyId, ids[persona], role, '["football"]');

  const player = (
    academyId: string,
    id: string,
    name: string,
    coachId: string,
    squadId: string,
  ): WorkspacePlayer => ({
    id,
    academyId,
    name,
    coachId,
    sportIds: ["football"],
    squad: squadId ? `Batch ${squadId}` : "",
    squadId,
    ageCategory: "U12",
    birthDate: "",
    position: "",
    status: "ACTIVE",
  });
  repo.save(
    A,
    "player",
    player(A, ids.p1, "Synthetic Asha One", ids.coachA, ids.squadA),
  );
  repo.save(
    A,
    "player",
    player(A, ids.p2, "Synthetic Kabir Two", ids.coachA, ids.squadA),
  );
  repo.save(
    A,
    "player",
    player(A, ids.p3, "Synthetic Meera Three", ids.coachB, ids.squadB),
  );
  repo.save(
    B,
    "player",
    player(B, ids.bPlayer, "Synthetic Other Academy Player", ids.ownerB, ""),
  );
  for (const [userId, playerId] of [
    [ids.parent1, ids.p1],
    [ids.parent2, ids.p2],
  ])
    db.prepare(
      "INSERT INTO guardian_relationships(academyId,userId,playerId) VALUES(?,?,?)",
    ).run(A, userId, playerId);

  const owner = contextFor("ownerA");
  const stamp = {
    version: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedBy: ids.ownerA,
  };
  repo.save(A, "branch", {
    id: ids.branch,
    academyId: A,
    name: "Synthetic ground",
    timezone: "Asia/Kolkata",
  });
  const squad = (id: string, playerIds: string[]): FootballSquad => ({
    id,
    academyId: A,
    sportId: "football",
    ...stamp,
    name: `Batch ${id}`,
    branchId: ids.branch,
    playerIds,
  });
  repo.save(A, "squad", squad(ids.squadA, [ids.p1, ids.p2]));
  repo.save(A, "squad", squad(ids.squadB, [ids.p3]));
  const venue: FootballVenue = {
    id: ids.venue,
    academyId: A,
    sportId: "football",
    ...stamp,
    name: "Synthetic pitch",
    branchId: ids.branch,
    location: "Synthetic address",
  };
  repo.save(A, "venue", venue);
  saveRecord(owner, "drill", {
    name: "Synthetic receiving drill",
    category: "ball-control-dribbling",
    focusArea: "First touch and receiving",
    purpose: "Practise a controlled first touch",
    cue: "Open body shape",
  });
  const drill = repo.list(A, "drill")[0];

  const sessions: string[] = [];
  let attendance = 0,
    evidence = 0;
  const roster: [string, string, string[]][] = [
    [ids.coachA, ids.squadA, [ids.p1, ids.p2]],
    [ids.coachB, ids.squadB, [ids.p3]],
  ];
  for (let day = 1; day <= 4; day++)
    for (const [coachId, squadId, playerIds] of roster) {
      const sessionId = `session-${squadId}-${day}`;
      const date = `2026-09-0${day}`;
      const session: FootballSession = {
        id: sessionId,
        academyId: A,
        sportId: "football",
        ...stamp,
        branchId: ids.branch,
        squadId,
        venueId: ids.venue,
        location: "Synthetic pitch",
        coachIds: [coachId],
        timezone: "Asia/Kolkata",
        startLocal: `${date}T17:00`,
        endLocal: `${date}T18:00`,
        startAt: `${date}T11:30:00.000Z`,
        endAt: `${date}T12:30:00.000Z`,
        theme: "Receiving",
        status: "COMPLETED",
        roster: playerIds.map((playerId) => ({ playerId, name: playerId })),
        agenda: [],
        objectives: [],
      };
      repo.save(A, "session", session);
      sessions.push(sessionId);
      for (const playerId of playerIds) {
        const mark: FootballAttendance = {
          id: `${sessionId}:${playerId}`,
          academyId: A,
          sportId: "football",
          ...stamp,
          sessionId,
          playerId,
          status: day === 4 ? "ABSENT" : "PRESENT",
          correctionReason: "",
        };
        repo.save(A, "attendance", mark);
        attendance++;
        const note: FootballEvidence = {
          id: `evidence-${sessionId}-${playerId}`,
          academyId: A,
          sportId: "football",
          ...stamp,
          sessionId,
          playerId,
          drillId: drill.id,
          drillVersion: 1,
          drillName: drill.name,
          conditions: "Synthetic small-sided practice",
          observation: "Synthetic observation of a controlled first touch",
          staffNote: "SYNTHETIC STAFF-ONLY NOTE",
          recordedAt: `${date}T12:40:00.000Z`,
          reviewedAt: `${date}T13:00:00.000Z`,
          type: "COACH_OBSERVATION",
          visibility: "PARENT_ELIGIBLE",
          measurement: "OBSERVATION",
          unit: "NONE",
          method: "Coach observation",
          status: "REVIEWED",
        } as FootballEvidence;
        repo.save(A, "evidence", note);
        evidence++;
      }
    }

  const reports: Record<string, string> = {};
  for (const playerId of [ids.p1, ids.p2, ids.p3]) {
    const coachId = playerId === ids.p3 ? ids.coachB : ids.coachA;
    const plan = saveRecord(owner, "plan", {
      playerId,
      coachId,
      focus: "First touch and receiving",
      reason: "Synthetic recorded focus",
      drillIds: [drill.id],
      observe: "Controlled first touch",
      homePractice: "Optional gentle ball touches",
      reviewDate: "2026-12-01",
      nextStep: "Repeat the receiving drill",
      status: "ACTIVE",
      privateNote: "SYNTHETIC STAFF-ONLY NOTE",
    }) as { id: string };
    const report = saveRecord(owner, "report", {
      playerId,
      planId: plan.id,
      period: "2026-09",
      observation: "Synthetic coach observation for the month",
      evidenceType: "COACH_OBSERVATION",
      nextStep: "Keep practising the first touch",
      closingNote: "Synthetic closing note",
    }) as { id: string };
    approveReport(
      owner,
      report.id,
      true,
      repo.find(A, "report", report.id)?.recordVersion,
    );
    reports[playerId] = report.id;
  }

  const fee = (action: string, data: unknown) =>
    financeAction(owner, { requestId: randomUUID(), action, data }) as {
      id: string;
    };
  const plan = fee("plan", {
    name: "Synthetic monthly training",
    amountMinor: 250000,
    currency: "INR",
    billingFrequency: "MONTHLY",
    applicableStartDate: "2026-09-01",
    dueAfterDays: 7,
    active: true,
  });
  const invoices: Record<string, string> = {};
  for (const playerId of [ids.p1, ids.p2, ids.p3])
    invoices[playerId] = fee("invoice", {
      playerId,
      planId: plan.id,
      label: "October training fee",
      chargeMinor: 250000,
      currency: "INR",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      dueDate: "2026-10-07",
    }).id;
  return { sessions, reports, invoices, attendance, evidence };
}

export interface RouteResponse {
  status: number;
  body: unknown;
  /** Decoded body size. */
  bytes: number;
  /** Size on the wire (after any Content-Encoding). */
  wireBytes: number;
  headers: Headers;
}
type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;
/** Calls an App Router handler the way Next.js does, with a signed-in persona
 * (or none), the configured origin on writes, and an optional raw body. */
export async function callRoute(
  handler: unknown,
  options: {
    path: string;
    method?: string;
    as?: Persona;
    params?: Record<string, string>;
    json?: unknown;
    rawBody?: string;
    origin?: string | null;
    /** Extra request headers, for example Accept-Encoding. */
    headers?: Record<string, string>;
  },
): Promise<RouteResponse> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.as) headers.set("x-test-user", ids[options.as]);
  if (method !== "GET" && options.origin !== null)
    headers.set("origin", options.origin ?? ORIGIN);
  for (const [name, value] of Object.entries(options.headers ?? {}))
    headers.set(name, value);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.json !== undefined) body = JSON.stringify(options.json);
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(ORIGIN + options.path, { method, headers, body });
  const response = await (handler as Handler)(request, {
    params: Promise.resolve(options.params ?? {}),
  });
  const wire = Buffer.from(await response.arrayBuffer()),
    buffer =
      response.headers.get("content-encoding") === "gzip"
        ? gunzipSync(wire)
        : wire;
  const text = buffer.toString("utf8");
  let parsed: unknown = text;
  if (response.headers.get("content-type")?.includes("json"))
    parsed = JSON.parse(text);
  return {
    status: response.status,
    body: parsed,
    bytes: buffer.byteLength,
    wireBytes: wire.byteLength,
    headers: response.headers,
  };
}

/** Counts executed SQL statements (get/all/run) issued through database()
 * while `fn` runs, including across awaits inside it. */
export async function countQueries<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; queries: number }> {
  const db = database();
  const original = db.prepare;
  let queries = 0;
  db.prepare = ((sql: string) => {
    const statement = original.call(db, sql);
    for (const method of ["get", "all", "run"] as const) {
      const run = statement[method].bind(statement) as (
        ...args: unknown[]
      ) => unknown;
      Object.defineProperty(statement, method, {
        value: (...args: unknown[]) => {
          queries++;
          return run(...args);
        },
      });
    }
    return statement;
  }) as typeof db.prepare;
  try {
    const result = await fn();
    return { result, queries };
  } finally {
    db.prepare = original;
  }
}
