// A synthetic academy with one member per role, for service-level tests. Every
// call creates a new academy id, so tests in one file never see each other's
// rows and no table needs clearing. All names and addresses are fictional.
import { randomUUID } from "node:crypto";
import { database } from "@/server/database";
import type { AcademyConfiguration, AcademyRole } from "@/domain/workspace";
import type { WorkspaceAccess } from "@/server/workspace-access";
import { activateAcademy } from "./lifecycle";

export function newAcademyConfig(
  overrides: Partial<AcademyConfiguration> = {},
): AcademyConfiguration {
  const id = randomUUID();
  return {
    id,
    academyId: id,
    name: "Synthetic football academy",
    contactEmail: "academy@example.test",
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
    ...overrides,
  };
}
export const memberId = (role: AcademyRole, cfg: AcademyConfiguration) =>
  `${role}-${cfg.id}`;

/** Inserts the academy, an ACTIVE entitlement and approval, and an OWNER, ADMIN,
 * COACH, PARENT and SUPPORT membership each (user id `ROLE-<academy id>`). */
export function seedAcademy(cfg: AcademyConfiguration) {
  const db = database();
  db.exec(
    'CREATE TABLE IF NOT EXISTS "user"(id TEXT PRIMARY KEY,name TEXT NOT NULL);',
  );
  db.prepare("INSERT INTO academy_workspaces(id,config) VALUES(?,?)").run(
    cfg.id,
    JSON.stringify(cfg),
  );
  db.prepare(
    "INSERT INTO platform_entitlements(academyId,tier,modules,status) VALUES(?,?,?,?)",
  ).run(cfg.id, "TEST", JSON.stringify(cfg.modules), "ACTIVE");
  activateAcademy(db, cfg.id);
  for (const role of ["OWNER", "ADMIN", "COACH", "PARENT", "SUPPORT"] as const) {
    const userId = memberId(role, cfg);
    db.prepare(
      "INSERT INTO academy_memberships(id,academyId,userId,role,sportIds) VALUES(?,?,?,?,?)",
    ).run(userId, cfg.id, userId, role, '["football"]');
    db.prepare('INSERT OR REPLACE INTO "user"(id,name) VALUES(?,?)').run(
      userId,
      role,
    );
  }
}
export function actorFor(
  role: AcademyRole,
  cfg: AcademyConfiguration,
): WorkspaceAccess {
  const userId = memberId(role, cfg);
  return {
    academy: cfg,
    membership: {
      id: userId,
      userId,
      academyId: cfg.id,
      role,
      active: true,
      sportIds: ["football"],
    },
    user: {
      id: userId,
      name: role,
      email: `${role}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: null,
    },
  };
}
/** The HTTP-style status of the error `fn` throws, or 0 when it does not throw. */
export async function statusOf(fn: () => unknown): Promise<number> {
  try {
    await fn();
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
  return 0;
}
/** Links a parent to a player (the guardian relationship a parent reads through). */
export function linkGuardian(
  cfg: AcademyConfiguration,
  userId: string,
  playerId: string,
) {
  database()
    .prepare("INSERT INTO guardian_relationships VALUES(?,?,?)")
    .run(cfg.id, userId, playerId);
}
