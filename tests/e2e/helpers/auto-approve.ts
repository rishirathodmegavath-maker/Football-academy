// The browser suites exercise operational features (players, sessions, fees,
// messages) in academies they create through the real API. Since academies need
// a platform administrator's approval, those suites run against a test database
// in which every newly registered academy is approved at once, by a trigger that
// exists ONLY in that throw-away database file. The product has no such switch
// and no environment variable can turn the approval off.
//
// The real workflow (submit, review, reject, resubmit, approve, suspend) is
// tested in phase8-approval.spec.ts, which runs against a database WITHOUT this
// trigger (playwright.approval.config.ts).
import { DatabaseSync } from "node:sqlite";

export const TRIGGER = "e2e_auto_approve_new_academies";

export async function installAutoApproval(origin: string, database: string) {
  // The server creates the schema when it first opens the database.
  const deadline = Date.now() + 60_000;
  for (;;) {
    await fetch(`${origin}/api/ready`).catch(() => undefined);
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const ready = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='academy_lifecycle'",
        )
        .get();
      if (ready) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${TRIGGER}
          AFTER INSERT ON academy_lifecycle WHEN NEW.state='CONFIGURING'
          BEGIN
            UPDATE academy_lifecycle SET state='ACTIVE' WHERE academyId=NEW.academyId;
          END`);
        return;
      }
    } finally {
      db.close();
    }
    if (Date.now() > deadline)
      throw new Error("The test database never got its approval schema.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
