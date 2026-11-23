// Test cleanup for suites that wipe every table between cases. History and
// audit tables refuse DELETE (migration 008), so the cleanup lifts that guard
// for one statement and restores it by running the migration again. Only test
// setup does this; no application code deletes from those tables.
import type { DatabaseSync } from "node:sqlite";
import {
  APPEND_ONLY_TABLES,
  migrateIntegrityGuards,
} from "@/server/migrations/008-integrity-guards";
import { migrateAcademyLifecycle } from "@/server/migrations/013-academy-lifecycle";

export function resetTables(db: DatabaseSync, sql: string) {
  for (const table of APPEND_ONLY_TABLES)
    db.exec(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
  // Removing every academy also removes its approval lifecycle (the lifecycle
  // rows reference the academy); the history guard is lifted for that too.
  const wipesAcademies = /DELETE FROM academy_workspaces/i.test(sql);
  if (wipesAcademies)
    db.exec(`DROP TRIGGER IF EXISTS academy_lifecycle_history_no_delete;
      DELETE FROM academy_lifecycle_history; DELETE FROM academy_lifecycle;`);
  try {
    db.exec(sql);
  } finally {
    migrateIntegrityGuards(db);
    if (wipesAcademies) migrateAcademyLifecycle(db);
  }
}
