// Test fixtures insert academies straight into the database, below the
// service that registers an approval lifecycle. An academy with no lifecycle
// row is not operational (fail closed), so a fixture that wants a working
// academy records it as approved here. Tests of the approval workflow itself
// create academies through createAcademy and never use this.
import type { DatabaseSync } from "node:sqlite";

export function activateAcademy(
  db: DatabaseSync,
  academyId: string,
  state:
    | "CONFIGURING"
    | "SUBMITTED"
    | "PENDING_REVIEW"
    | "REJECTED"
    | "ACTIVE"
    | "SUSPENDED" = "ACTIVE",
) {
  db.prepare(
    "INSERT OR REPLACE INTO academy_lifecycle(academyId,state,version,submissions,updatedAt) VALUES(?,?,1,0,?)",
  ).run(academyId, state, new Date().toISOString());
}
