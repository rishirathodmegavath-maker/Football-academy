/**
 * Player lifecycle (roadmap P0-02). One definition, used by the server rules,
 * the screens and the integrity check, so the meaning of a status cannot drift.
 *
 * - ACTIVE and TRIAL take part in training, billing suggestions and academy
 *   announcements. A record with no status is an older ACTIVE player.
 * - PAUSED: a temporary break. Not placed on new rosters, no recurring fee
 *   suggestion, no new announcements. Everything recorded so far stays.
 * - INACTIVE: has left the academy. Same effects as PAUSED. (The only inactive
 *   state the product had before; its meaning is kept.)
 * - ARCHIVED: closed profile. Same effects, and no new records of any kind
 *   (plans, reports, updates, observations, invoices) until an owner or admin
 *   restores the profile. History stays readable.
 *
 * Only an owner or admin may move a player into or out of PAUSED or ARCHIVED.
 * A coach keeps the limited status control they already had
 * (ACTIVE, TRIAL, INACTIVE) on their own players.
 */
export const PLAYER_STATUSES = [
  "ACTIVE",
  "TRIAL",
  "PAUSED",
  "INACTIVE",
  "ARCHIVED",
] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export const PLAYER_STATUS_LABELS: Record<PlayerStatus, string> = {
  ACTIVE: "Active",
  TRIAL: "Trial",
  PAUSED: "Paused",
  INACTIVE: "Inactive",
  ARCHIVED: "Archived",
};

/** A player who takes part in training, billing suggestions and announcements. */
export function participates(status?: string): boolean {
  return status === undefined || status === "ACTIVE" || status === "TRIAL";
}

/** An archived profile accepts no new records until it is restored. */
export function isArchived(status?: string): boolean {
  return status === "ARCHIVED";
}

/** Whether moving between these two statuses needs an owner or admin. */
export function transitionNeedsManager(
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from === to) return false;
  const managed = (status?: string) =>
    status === "PAUSED" || status === "ARCHIVED";
  return managed(from) || managed(to);
}

export const ARCHIVED_MESSAGE =
  "This player is archived. An owner or admin must restore the profile before new records can be added.";
