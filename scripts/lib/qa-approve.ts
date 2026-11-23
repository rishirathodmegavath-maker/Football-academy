// QA seeding creates its synthetic academy through the real service, which now
// starts every academy in CONFIGURING (it must be approved by a platform
// administrator before it can run operations). The seeding scripts build a
// whole working academy, so they record the approval here, in the throw-away QA
// database, as the system: the history says so ("system:qa-seed"), and no
// real academy is ever approved this way.
export const QA_ACTOR = "system:qa-seed";

export async function approveForQa(academyId: string) {
  const { database, atomic } = await import("../../src/server/database");
  const at = new Date().toISOString();
  atomic(() => {
    const db = database();
    const row = db
      .prepare("SELECT state FROM academy_lifecycle WHERE academyId=?")
      .get(academyId);
    if (!row) throw new Error("The academy has no lifecycle record.");
    if (row.state === "ACTIVE") return;
    const reason = "Approved by the QA seeding script (synthetic data).";
    db.prepare(
      "UPDATE academy_lifecycle SET state='ACTIVE', version=version+1, decidedAt=?, decidedBy=?, reason=?, updatedAt=? WHERE academyId=?",
    ).run(at, QA_ACTOR, reason, at, academyId);
    db.prepare(
      "INSERT INTO academy_lifecycle_history(academyId,fromState,toState,action,actorId,actorKind,reason,at) VALUES(?,?,?,?,?,'SYSTEM',?,?)",
    ).run(academyId, row.state, "ACTIVE", "APPROVED", QA_ACTOR, reason, at);
  });
}
