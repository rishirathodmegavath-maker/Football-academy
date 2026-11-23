import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { authenticatedUser, WorkspaceError } from "./auth";
import { database, audit, atomic } from "./database";
import { requireRole, type WorkspaceAccess } from "./workspace-access";
import { requireMfa } from "./mfa-policy";
import {
  applicationDetail,
  applicationList,
  decideApplication,
} from "./academy-lifecycle";
export async function platformAccess(headers: Headers) {
  const user = await authenticatedUser(headers);
  if (
    !database()
      .prepare("SELECT 1 FROM platform_administrators WHERE userId=?")
      .get(user.id)
  )
    throw new WorkspaceError(
      403,
      "Platform administration is not an academy role.",
    );
  requireMfa(user, "PLATFORM");
  return user;
}
export async function platformAccounts(headers: Headers) {
  await platformAccess(headers);
  return database()
    .prepare(
      "SELECT a.id,a.config,e.tier,e.modules,e.status,l.state AS lifecycle,l.version AS lifecycleVersion FROM academy_workspaces a JOIN platform_entitlements e ON e.academyId=a.id LEFT JOIN academy_lifecycle l ON l.academyId=a.id",
    )
    .all()
    .map((r) => {
      const c = JSON.parse(String(r.config));
      return {
        id: String(r.id),
        name: c.name,
        country: c.country,
        onboardingStatus: r.lifecycle === "ACTIVE" ? "ACTIVE" : "CONFIGURING",
        lifecycle: r.lifecycle ? String(r.lifecycle) : null,
        lifecycleVersion: r.lifecycleVersion ? Number(r.lifecycleVersion) : null,
        demo: c.demo,
        tier: String(r.tier),
        modules: JSON.parse(String(r.modules)),
        status: String(r.status),
      };
    });
}
export async function configureAccount(headers: Headers, input: unknown) {
  const user = await platformAccess(headers),
    value = z
      .object({
        academyId: z.string(),
        // Pausing and resuming an academy is a suspension / reactivation: it
        // needs a written reason and is recorded in the academy's approval
        // history, so it goes through POST /api/platform/applications/{id}/decision.
        // The field is still accepted when it only repeats the current status.
        status: z.enum(["ACTIVE", "PAUSED"]).optional(),
        tier: z.enum(["LOCAL_FOUNDATION", "PILOT", "STANDARD"]),
        modules: z.array(
          z.enum(["development", "reports", "communication", "fees"]),
        ),
      })
      .parse(input);
  const found = database()
    .prepare(
      "SELECT w.id,e.status FROM academy_workspaces w LEFT JOIN platform_entitlements e ON e.academyId=w.id WHERE w.id=?",
    )
    .get(value.academyId);
  if (!found) throw new WorkspaceError(404, "Customer academy not found.");
  if (value.status !== undefined && value.status !== found.status)
    throw new WorkspaceError(
      400,
      "To suspend or reactivate an academy use the approval decision (a written reason is required).",
      {},
      "USE_DECISION",
    );
  // The change and its audit entry stand or fall together.
  atomic(() => {
    database()
      .prepare(
        "UPDATE platform_entitlements SET tier=?,modules=? WHERE academyId=?",
      )
      .run(
        value.tier,
        JSON.stringify(value.modules),
        value.academyId,
      );
    audit(
      value.academyId,
      user.id,
      "Platform entitlement configuration changed; no billing collected",
    );
  });
  return { ok: true };
}
/** The review queue. Platform administrators only. */
export async function platformApplications(
  headers: Headers,
  params: URLSearchParams,
) {
  await platformAccess(headers);
  return applicationList(params);
}
/** One application with its profile and decision history. */
export async function platformApplication(headers: Headers, academyId: string) {
  await platformAccess(headers);
  return applicationDetail(academyId);
}
/** A decision on an application, or a suspension / reactivation. */
export async function platformDecision(
  headers: Headers,
  academyId: string,
  input: unknown,
) {
  const admin = await platformAccess(headers);
  return decideApplication(admin.id, academyId, input);
}
export function grantSupport(ctx: WorkspaceAccess, input: unknown) {
  requireRole(ctx, ["OWNER"]);
  const value = z
    .object({
      userId: z.string(),
      playerIds: z.array(z.string()).min(1),
      reason: z.string().trim().min(10).max(1000),
    })
    .parse(input);
  if (
    !database()
      .prepare("SELECT 1 FROM platform_administrators WHERE userId=?")
      .get(value.userId)
  )
    throw new WorkspaceError(
      400,
      "Select a registered platform support administrator.",
    );
  for (const id of value.playerIds) {
    if (
      !database()
        .prepare(
          "SELECT 1 FROM workspace_records WHERE academyId=? AND kind='player' AND id=?",
        )
        .get(ctx.academy.id, id)
    )
      throw new WorkspaceError(
        400,
        "Support access must name a player in this academy.",
      );
  }
  const existing = database()
    .prepare(
      "SELECT role FROM academy_memberships WHERE academyId=? AND userId=?",
    )
    .get(ctx.academy.id, value.userId);
  if (existing && existing.role !== "SUPPORT")
    throw new WorkspaceError(
      409,
      "An existing academy role cannot be replaced by a support grant.",
    );
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  atomic(() => {
    database()
      .prepare(
        "INSERT INTO academy_memberships(id,academyId,userId,role,active,expiresAt) VALUES(?,?,?,?,1,?) ON CONFLICT(academyId,userId) DO UPDATE SET role='SUPPORT',active=1,expiresAt=excluded.expiresAt",
      )
      .run(randomUUID(), ctx.academy.id, value.userId, "SUPPORT", expiresAt);
    database()
      .prepare(
        "DELETE FROM support_relationships WHERE academyId=? AND userId=?",
      )
      .run(ctx.academy.id, value.userId);
    for (const id of value.playerIds)
      database()
        .prepare(
          "INSERT INTO support_relationships(academyId,userId,playerId) VALUES(?,?,?)",
        )
        .run(ctx.academy.id, value.userId, id);
    audit(
      ctx.academy.id,
      ctx.user.id,
      `Explicit one-hour support grant: ${value.reason}`,
      value.userId,
    );
  });
  return { expiresAt };
}
