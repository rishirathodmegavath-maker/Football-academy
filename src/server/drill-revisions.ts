import "server-only";
import type { WorkspaceDrill } from "@/domain/workspace";
import { database } from "./database";
import { WorkspaceError } from "./auth";

/**
 * Append-only revision history of an academy drill.
 *
 * A revision is stored as a row of the existing `workspace_records` table with
 * the kind "drillrevision" and an id that contains its number, so no schema
 * change is needed. Rows are only ever inserted, never replaced: the primary
 * key refuses a second row with the same number, and this module exposes no
 * update or delete. The kind is not one of the record kinds served by the
 * generic record routes, so no ordinary API can write or alter a revision.
 *
 * Database-level tamper resistance (a trigger that rejects UPDATE and DELETE
 * on these rows) would be a schema change and is therefore awaiting approval;
 * see docs/DRILL_LIBRARY_CORRECTIONS.md.
 */
export const REVISION_KIND = "drillrevision";

export interface DrillRevision {
  id: string;
  academyId: string;
  drillId: string;
  revision: number;
  at: string;
  actorId: string;
  actorRole: string;
  /** Why the revision exists, for example "Edited" or "Archived". */
  context: string;
  changedFields: string[];
  /** The drill before the change; null for the first revision. */
  before: WorkspaceDrill | null;
  after: WorkspaceDrill;
}

const revisionId = (drillId: string, revision: number) =>
  `${drillId}:${String(revision).padStart(6, "0")}`;

const strip = (drill: WorkspaceDrill): WorkspaceDrill => {
  const { recordVersion: _version, ...rest } = drill;
  void _version;
  return structuredClone(rest);
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Names of the fields that differ, using the content keys for coaching text. */
export function changedFields(
  before: WorkspaceDrill | null,
  after: WorkspaceDrill,
): string[] {
  if (!before) return ["created"];
  const out: string[] = [];
  for (const key of [
    "name",
    "focusArea",
    "purpose",
    "cue",
    "category",
    "status",
  ] as const)
    if (!same(before[key], after[key])) out.push(key);
  const a = (before.content ?? {}) as Record<string, unknown>,
    b = (after.content ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!same(a[key], b[key])) out.push(`content.${key}`);
  return out;
}

function revisionRows(academyId: string, drillId: string) {
  return database()
    .prepare(
      "SELECT body FROM workspace_records WHERE academyId=? AND kind=? AND json_extract(body,'$.drillId')=? ORDER BY json_extract(body,'$.revision')",
    )
    .all(academyId, REVISION_KIND, drillId)
    .map((row) => JSON.parse(String(row.body)) as DrillRevision);
}

function insert(revision: DrillRevision) {
  database()
    .prepare(
      "INSERT INTO workspace_records(academyId,kind,id,sportId,playerId,body,version) VALUES (?,?,?,?,NULL,?,1)",
    )
    .run(
      revision.academyId,
      REVISION_KIND,
      revision.id,
      "football",
      JSON.stringify(revision),
    );
}

/**
 * Appends one revision. Call it inside the transaction that saves the drill.
 * A drill that existed before revisions were kept first gets a baseline
 * revision holding its earlier state, so the history is never missing a start.
 */
export function recordDrillRevision(
  academyId: string,
  actor: { id: string; role: string },
  before: WorkspaceDrill | undefined,
  after: WorkspaceDrill,
  context: string,
  at = new Date().toISOString(),
) {
  const existing = revisionRows(academyId, after.id);
  let next = existing.length + 1;
  if (before && !existing.length) {
    insert({
      id: revisionId(after.id, next),
      academyId,
      drillId: after.id,
      revision: next,
      at,
      actorId: "system",
      actorRole: "SYSTEM",
      context: "Baseline: the drill as it was before revisions were kept",
      changedFields: ["baseline"],
      before: null,
      after: strip(before),
    });
    next += 1;
  }
  const previous = before ? strip(before) : null,
    current = strip(after);
  insert({
    id: revisionId(after.id, next),
    academyId,
    drillId: after.id,
    revision: next,
    at,
    actorId: actor.id,
    actorRole: actor.role,
    context,
    changedFields: changedFields(previous, current),
    before: previous,
    after: current,
  });
  return next;
}

/** The revisions of one drill, newest first. */
export function drillRevisionHistory(
  academyId: string,
  drillId: string,
): DrillRevision[] {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(drillId))
    throw new WorkspaceError(404, "Drill not found in this academy.");
  return revisionRows(academyId, drillId).reverse();
}
