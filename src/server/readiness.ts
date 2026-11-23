import "server-only";
import { database } from "./database";
import { isDraining } from "./shutdown";

/** Tables created by the migrations; a missing one means the database is not
 * the schema this release expects (for example a wrong or empty file). */
export const REQUIRED_TABLES = [
  "academy_workspaces",
  "workspace_records",
  "workspace_audit",
  "request_rate_limits",
  "email_outbox",
];
export type Readiness = {
  ready: boolean;
  checks: Record<string, "ok" | "failed" | "draining">;
};
/** Deliberately reports no paths, versions, counts or error text. */
export function readiness(): Readiness {
  const checks: Readiness["checks"] = { database: "ok", schema: "ok" };
  try {
    const db = database();
    db.prepare("SELECT 1").get();
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
    if (!REQUIRED_TABLES.every((name) => names.has(name)))
      checks.schema = "failed";
  } catch {
    checks.database = "failed";
    checks.schema = "failed";
  }
  if (isDraining()) checks.service = "draining";
  return {
    ready: Object.values(checks).every((value) => value === "ok"),
    checks,
  };
}
