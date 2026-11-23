import type { DatabaseSync } from "node:sqlite";
import { PLAYER_STATUSES } from "../domain/player-lifecycle";

/**
 * Read-only consistency checks over a Sportozen database.
 *
 * Records live as JSON in `workspace_records` and `academy_finance_records`,
 * so SQLite cannot enforce the links between them (a payment's invoice, an
 * attendance row's session). The services enforce them on write; these checks
 * show whether stored data actually satisfies them. Nothing here writes,
 * repairs or deletes anything: a finding is a question for a person.
 */
export type IntegritySeverity = "ERROR" | "WARNING";
export interface IntegrityFinding {
  check: string;
  severity: IntegritySeverity;
  count: number;
  /** A few offending identifiers, enough to find the rows. */
  examples: string[];
}
type Json = Record<string, unknown>;
interface Row {
  academyId: string;
  kind: string;
  id: string;
  playerId: string | null;
  sportId: string | null;
  body: Json;
}
const ROLES = ["OWNER", "ADMIN", "COACH", "PARENT", "SUPPORT"];
const STAFF = ["OWNER", "ADMIN", "COACH"];
const MAX_EXAMPLES = 5;

class Findings {
  private readonly found = new Map<string, IntegrityFinding>();
  add(check: string, severity: IntegritySeverity, example: string) {
    const entry = this.found.get(check) ?? {
      check,
      severity,
      count: 0,
      examples: [],
    };
    entry.count++;
    if (entry.examples.length < MAX_EXAMPLES) entry.examples.push(example);
    this.found.set(check, entry);
  }
  list() {
    return [...this.found.values()].sort(
      (a, b) =>
        a.severity.localeCompare(b.severity) || a.check.localeCompare(b.check),
    );
  }
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
// Corrupt data is what this tool exists to report, so a malformed list or a
// null entry must be skipped, never thrown on.
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
const list = (value: unknown): Json[] =>
  Array.isArray(value)
    ? (value as unknown[]).filter(
        (entry): entry is Json => !!entry && typeof entry === "object",
      )
    : [];

function tableExists(db: DatabaseSync, name: string) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}
function loadRecords(db: DatabaseSync, findings: Findings) {
  const rows: Row[] = [];
  for (const r of db
    .prepare(
      "SELECT academyId,kind,id,playerId,sportId,body FROM workspace_records",
    )
    .all()) {
    const where = `${r.academyId}/${r.kind}/${r.id}`;
    let body: Json;
    try {
      body = JSON.parse(String(r.body)) as Json;
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new Error("not an object");
    } catch {
      findings.add("record body is not a JSON object", "ERROR", where);
      continue;
    }
    if (body.academyId !== r.academyId)
      findings.add(
        "record body academyId differs from its row (tenant mismatch)",
        "ERROR",
        where,
      );
    if (body.id !== r.id)
      findings.add("record body id differs from its row", "ERROR", where);
    rows.push({
      academyId: String(r.academyId),
      kind: String(r.kind),
      id: String(r.id),
      playerId: r.playerId === null ? null : String(r.playerId),
      sportId: r.sportId === null ? null : String(r.sportId),
      body,
    });
  }
  return rows;
}

/** The approval lifecycle must exist for every academy, and agree with the
 * entitlement that actually opens and closes it. */
function checkLifecycle(db: DatabaseSync, findings: Findings) {
  for (const r of db
    .prepare(
      `SELECT a.id,l.state,e.status FROM academy_workspaces a
       LEFT JOIN academy_lifecycle l ON l.academyId=a.id
       LEFT JOIN platform_entitlements e ON e.academyId=a.id`,
    )
    .all()) {
    const id = String(r.id);
    if (!r.state)
      findings.add(
        "academy has no approval lifecycle record (it cannot operate)",
        "ERROR",
        id,
      );
    else if (
      (r.state === "ACTIVE" && r.status !== "ACTIVE") ||
      (r.state !== "ACTIVE" && r.state !== "SUSPENDED" && r.status !== "ACTIVE") ||
      (r.state === "SUSPENDED" && r.status === "ACTIVE")
    )
      findings.add(
        "approval lifecycle state disagrees with the platform entitlement",
        "WARNING",
        `${id}: ${r.state} / ${r.status ?? "none"}`,
      );
  }
}

export function checkDataIntegrity(db: DatabaseSync): IntegrityFinding[] {
  const findings = new Findings();
  const academies = new Set(
    db
      .prepare("SELECT id FROM academy_workspaces")
      .all()
      .map((r) => String(r.id)),
  );
  const rows = loadRecords(db, findings);
  const byKind = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    const key = `${row.academyId}\u0000${row.kind}`;
    if (!byKind.has(key)) byKind.set(key, new Map());
    byKind.get(key)!.set(row.id, row);
    if (!academies.has(row.academyId))
      findings.add(
        "record belongs to an academy that does not exist",
        "ERROR",
        `${row.academyId}/${row.kind}/${row.id}`,
      );
  }
  const has = (academyId: string, kind: string, id: unknown) =>
    byKind.get(`${academyId}\u0000${kind}`)?.has(text(id)) ?? false;
  const get = (academyId: string, kind: string, id: unknown) =>
    byKind.get(`${academyId}\u0000${kind}`)?.get(text(id));

  const members = db
    .prepare("SELECT academyId,userId,role,active FROM academy_memberships")
    .all();
  const activeStaff = new Set(
    members
      .filter((m) => m.active && STAFF.includes(String(m.role)))
      .map((m) => `${m.academyId}\u0000${m.userId}`),
  );
  for (const m of members)
    if (!ROLES.includes(String(m.role)))
      findings.add(
        "membership has an unknown role",
        "ERROR",
        `${m.academyId}/${m.userId}/${m.role}`,
      );

  // How many batch rosters list each player (a player belongs on one).
  const rosterCount = new Map<string, number>();
  for (const row of rows)
    if (row.kind === "squad")
      for (const playerId of new Set(strings(row.body.playerIds))) {
        const key = `${row.academyId}\u0000${playerId}`;
        rosterCount.set(key, (rosterCount.get(key) ?? 0) + 1);
      }
  for (const row of rows) {
    const { academyId, kind, id, body } = row,
      where = `${academyId}/${kind}/${id}`;
    if (
      "playerId" in body &&
      row.playerId !== null &&
      row.playerId !== body.playerId
    )
      findings.add(
        "indexed playerId column differs from the record body",
        "ERROR",
        where,
      );
    if (kind === "player") {
      // Placement (decision D9): player.squadId is the source of truth and a
      // batch roster is derived from it. A disagreement is reported, never
      // repaired by guessing which side is right.
      if (
        body.status !== undefined &&
        !(PLAYER_STATUSES as readonly string[]).includes(text(body.status))
      )
        findings.add("player has an unknown status", "WARNING", where);
      if (body.squadId) {
        const placedIn = get(academyId, "squad", body.squadId);
        if (placedIn && !strings(placedIn.body.playerIds).includes(id))
          findings.add(
            "player is placed in a batch whose roster does not list them",
            "WARNING",
            where,
          );
      }
      if ((rosterCount.get(`${academyId}\u0000${id}`) ?? 0) > 1)
        findings.add(
          "player is listed on more than one batch roster",
          "WARNING",
          where,
        );
      if (!activeStaff.has(`${academyId}\u0000${text(body.coachId)}`))
        findings.add(
          "player's coach is not an active staff member",
          "WARNING",
          where,
        );
      if (body.squadId && !has(academyId, "squad", body.squadId))
        findings.add("player's batch does not exist", "ERROR", where);
    }
    if (kind === "squad") {
      if (!has(academyId, "branch", body.branchId))
        findings.add("batch's branch does not exist", "ERROR", where);
      for (const playerId of strings(body.playerIds)) {
        const listed = get(academyId, "player", playerId);
        if (!listed)
          findings.add(
            "batch lists a player that does not exist",
            "ERROR",
            where,
          );
        else if (listed.body.squadId && listed.body.squadId !== id)
          findings.add(
            "batch lists a player who is placed in a different batch",
            "WARNING",
            where,
          );
        else if (!listed.body.squadId)
          findings.add(
            "batch lists a player with no recorded placement (roster-only, older data)",
            "WARNING",
            where,
          );
      }
    }
    if (kind === "enquiry") {
      if (body.status === "CONVERTED" && !has(academyId, "player", body.convertedPlayerId))
        findings.add(
          "converted enquiry points at a player that does not exist",
          "ERROR",
          where,
        );
    }
    if (kind === "closure") {
      if (body.branchId && !has(academyId, "branch", body.branchId))
        findings.add("closure's branch does not exist", "ERROR", where);
      if (text(body.endDate) < text(body.startDate))
        findings.add("closure ends before it starts", "ERROR", where);
    }
    if (kind === "session") {
      if (!has(academyId, "branch", body.branchId))
        findings.add("session's branch does not exist", "ERROR", where);
      if (!has(academyId, "squad", body.squadId))
        findings.add("session's batch does not exist", "ERROR", where);
      if (body.venueId && !has(academyId, "venue", body.venueId))
        findings.add("session's venue does not exist", "ERROR", where);
      for (const entry of list(body.roster))
        if (!has(academyId, "player", entry.playerId))
          findings.add(
            "session roster lists a player that does not exist",
            "ERROR",
            where,
          );
      // A session generated by a recurring series carries the series' id and
      // its own date in its id, so a date can exist once.
      if (body.seriesId) {
        if (!has(academyId, "series", body.seriesId))
          findings.add(
            "session belongs to a series that does not exist",
            "ERROR",
            where,
          );
        else if (id !== `${text(body.seriesId)}:${text(body.occurrenceDate)}`)
          findings.add(
            "series session id is not series:date (a duplicate date could exist)",
            "ERROR",
            where,
          );
      }
    }
    if (kind === "series") {
      if (!has(academyId, "branch", body.branchId))
        findings.add("series' branch does not exist", "ERROR", where);
      if (!has(academyId, "squad", body.squadId))
        findings.add("series' batch does not exist", "ERROR", where);
      if (body.status === "CANCELLED") {
        // A cancelled series must not leave future scheduled sessions behind,
        // except ones it reported as left alone.
        const left = new Set(
          list(
            (body.cancelOutcome as Json | undefined)?.left as Json[] | undefined,
          ).map((entry) => text(entry.sessionId)),
        );
        for (const session of rows)
          if (
            session.academyId === academyId &&
            session.kind === "session" &&
            session.body.seriesId === id &&
            session.body.status === "SCHEDULED" &&
            text(session.body.startAt) > text(body.cancelledAt) &&
            !left.has(session.id)
          )
            findings.add(
              "cancelled series still has a scheduled future session",
              "WARNING",
              `${where} -> ${session.id}`,
            );
      }
    }
    if (kind === "wrapup") {
      const session = get(academyId, "session", body.sessionId);
      if (!session)
        findings.add(
          "wrap-up refers to a session that does not exist",
          "ERROR",
          where,
        );
      else if (id !== text(body.sessionId))
        findings.add(
          "wrap-up id is not its session id (a second wrap-up could exist)",
          "ERROR",
          where,
        );
      else if (!["IN_PROGRESS", "COMPLETED"].includes(text(session.body.status)))
        findings.add(
          "wrap-up exists for a session that never started",
          "WARNING",
          where,
        );
    }
    if (kind === "attendance" || kind === "evidence") {
      const session = get(academyId, "session", body.sessionId);
      if (!session)
        findings.add(
          `${kind} refers to a session that does not exist`,
          "ERROR",
          where,
        );
      else if (
        !list(session.body.roster).some((p) => p.playerId === body.playerId)
      )
        findings.add(
          `${kind} is for a player who is not on the session roster`,
          "ERROR",
          where,
        );
      if (!has(academyId, "player", body.playerId))
        findings.add(
          `${kind} refers to a player that does not exist`,
          "ERROR",
          where,
        );
      if (
        kind === "attendance" &&
        id !== `${text(body.sessionId)}:${text(body.playerId)}`
      )
        findings.add(
          "attendance id is not session:player (a duplicate could exist)",
          "ERROR",
          where,
        );
    }
    if (
      [
        "plan",
        "report",
        "update",
        "conversation",
        "dietary",
        "weekly",
      ].includes(kind) &&
      body.playerId &&
      !has(academyId, "player", body.playerId)
    )
      findings.add(
        `${kind} refers to a player that does not exist`,
        "ERROR",
        where,
      );
    if (kind === "report" && body.status === "Approved" && !body.snapshot)
      findings.add("approved report has no snapshot", "ERROR", where);
  }

  // Parent and support links are plain tables; check the player half.
  for (const table of ["guardian_relationships", "support_relationships"])
    for (const r of db
      .prepare(`SELECT academyId,userId,playerId FROM ${table}`)
      .all())
      if (!has(String(r.academyId), "player", r.playerId))
        findings.add(
          `${table} row names a player that does not exist`,
          "ERROR",
          `${r.academyId}/${r.userId}/${r.playerId}`,
        );
  const guardians = new Set(
    db
      .prepare("SELECT academyId,userId FROM guardian_relationships")
      .all()
      .map((r) => `${r.academyId}\u0000${r.userId}`),
  );
  for (const m of members)
    if (
      m.role === "PARENT" &&
      m.active &&
      !guardians.has(`${m.academyId}\u0000${m.userId}`)
    )
      findings.add(
        "active parent is linked to no player",
        "WARNING",
        `${m.academyId}/${m.userId}`,
      );

  if (tableExists(db, "academy_finance_records"))
    checkFinance(db, findings, has);
  if (tableExists(db, "academy_lifecycle")) checkLifecycle(db, findings);
  return findings.list();
}

function checkFinance(
  db: DatabaseSync,
  findings: Findings,
  has: (academyId: string, kind: string, id: unknown) => boolean,
) {
  const records = db
    .prepare("SELECT academyId,kind,id,body FROM academy_finance_records")
    .all()
    .flatMap((r) => {
      try {
        return [
          {
            academyId: String(r.academyId),
            kind: String(r.kind),
            id: String(r.id),
            body: JSON.parse(String(r.body)) as Json,
          },
        ];
      } catch {
        findings.add(
          "finance record body is not valid JSON",
          "ERROR",
          `${r.academyId}/${r.kind}/${r.id}`,
        );
        return [];
      }
    });
  // One index, so large finance tables are checked in linear time.
  const index = new Map(
    records.map((r) => [`${r.academyId}\u0000${r.kind}\u0000${r.id}`, r]),
  );
  const find = (academyId: string, kind: string, id: unknown) =>
    index.get(`${academyId}\u0000${kind}\u0000${text(id)}`);
  const invoiceKey = new Set<string>(),
    numbers = new Set<string>(),
    verified = new Map<string, number>(),
    adjustments = new Map<string, number>(),
    receiptsFor = new Map<string, number>();
  for (const r of records) {
    const { academyId, kind, id, body } = r,
      where = `${academyId}/${kind}/${id}`;
    if (body.academyId !== academyId)
      findings.add("finance record belongs to another academy", "ERROR", where);
    if (kind !== "invoice" && body.invoiceId) {
      const invoice = find(academyId, "invoice", body.invoiceId);
      if (!invoice)
        findings.add(
          `${kind} refers to an invoice that does not exist`,
          "ERROR",
          where,
        );
      else if (invoice.body.playerId !== body.playerId)
        findings.add(
          `${kind} is for a different player than its invoice`,
          "ERROR",
          where,
        );
    }
    if (body.playerId && !has(academyId, "player", body.playerId))
      findings.add(
        `${kind} refers to a player that does not exist`,
        "ERROR",
        where,
      );
    if (
      typeof body.amountMinor === "number" &&
      (!Number.isInteger(body.amountMinor) || body.amountMinor < 0)
    )
      findings.add(
        `${kind} amount is not a whole non-negative number`,
        "ERROR",
        where,
      );
    if (kind === "invoice") {
      const number = `${academyId}\u0000${text(body.number)}`;
      if (numbers.has(number))
        findings.add("two invoices share a number", "ERROR", where);
      numbers.add(number);
      invoiceKey.add(`${academyId}\u0000${id}`);
    }
    if (kind === "payment" && body.status === "VERIFIED") {
      const key = `${academyId}\u0000${text(body.invoiceId)}`;
      verified.set(key, (verified.get(key) ?? 0) + Number(body.amountMinor));
    }
    if (kind === "adjustment") {
      const key = `${academyId}\u0000${text(body.invoiceId)}`,
        signed =
          (body.direction === "CREDIT" ? -1 : 1) * Number(body.amountMinor);
      adjustments.set(key, (adjustments.get(key) ?? 0) + signed);
    }
    if (kind === "receipt") {
      const payment = find(academyId, "payment", body.paymentId);
      if (!payment)
        findings.add(
          "receipt refers to a payment that does not exist",
          "ERROR",
          where,
        );
      else if (payment.body.status !== "VERIFIED")
        findings.add(
          "receipt exists for a payment that is not verified",
          "ERROR",
          where,
        );
      else if (payment.body.amountMinor !== body.amountMinor)
        findings.add("receipt amount differs from its payment", "ERROR", where);
      const key = `${academyId}\u0000${text(body.paymentId)}`;
      receiptsFor.set(key, (receiptsFor.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of receiptsFor)
    if (count > 1)
      findings.add(
        "a payment has more than one receipt",
        "ERROR",
        key.replace("\u0000", "/"),
      );
  for (const r of records)
    if (r.kind === "payment" && r.body.status === "VERIFIED") {
      const hasReceipt = receiptsFor.has(`${r.academyId}\u0000${r.id}`);
      if (!hasReceipt)
        findings.add(
          "verified payment has no receipt",
          "WARNING",
          `${r.academyId}/payment/${r.id}`,
        );
    }
  for (const r of records)
    if (r.kind === "invoice") {
      const key = `${r.academyId}\u0000${r.id}`,
        billed = Number(r.body.chargeMinor) + (adjustments.get(key) ?? 0);
      if (billed < 0)
        findings.add(
          "adjustments take an invoice below zero",
          "ERROR",
          `${r.academyId}/invoice/${r.id}`,
        );
      if ((verified.get(key) ?? 0) > billed)
        findings.add(
          "verified payments exceed the amount billed",
          "ERROR",
          `${r.academyId}/invoice/${r.id}`,
        );
    }
}
