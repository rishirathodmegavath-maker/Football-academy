import "server-only";
import { z } from "zod";
import { WorkspaceError } from "./auth";
import { requireRole, requirePlayer, type WorkspaceAccess } from "./workspace-access";
import { workspaceRepository as repo } from "./workspace-repository";
import { audit, atomic } from "./database";
import { academyToday } from "./drill-library-service";
import type { WorkspacePlayer } from "@/domain/workspace";
import {
  ageState,
  daysBetween,
  isCalendarDay,
  isUnder18,
  type AgeDecision,
} from "@/domain/player-age";

/**
 * Players are under 18 and always have a date of birth. Every way a player record comes into being or changes goes
 * through requireUnder18 (the player form, the CSV import, the conversion of an enquiry and any API call).
 *   - A date of birth is required and must be a real day that is not in the future.
 *   - A player who is 18 or older is refused, except to archive them, or while the owner's "keep for now" decision about
 *     that very player has not run out (only ever recorded by reviewAge, never by editing the profile).
 */
export function requireUnder18(
  profile: { birthDate?: string | null; status?: string | null },
  today: string,
  decision: AgeDecision | null | undefined,
): void {
  const birth = (profile.birthDate ?? "").trim();
  if (!birth)
    throw new WorkspaceError(400, "Enter the player's date of birth.");
  if (!isCalendarDay(birth) || birth > today)
    throw new WorkspaceError(400, "Choose a valid birth date.");
  if (profile.status === "ARCHIVED" || isUnder18(birth, today)) return;
  if (
    ageState(
      { birthDate: birth, status: profile.status, ageDecision: decision ?? null },
      today,
    ).kind === "KEPT"
  )
    return;
  throw new WorkspaceError(
    400,
    "Players must be under 18. This date of birth makes the player 18 or older, so the owner has to decide in the age review.",
  );
}

const MAX_KEEP_DAYS = 366;
/**
 * The owner's decision about a player who has turned 18.
 *   ARCHIVE (accept): the player leaves the active list. The record, history and reports are kept; an owner can restore it.
 *   KEEP (reject): the player stays, with a written reason and a day to look again (at most a year ahead). When that day
 *     passes the decision is asked for again.
 * Only an owner decides, and nothing else records the decision: editing the profile cannot set, change or clear it.
 */
export function reviewAge(ctx: WorkspaceAccess, playerId: string, input: unknown) {
  requireRole(ctx, ["OWNER"]);
  const v = z
    .object({
      decision: z.enum(["ARCHIVE", "KEEP"]),
      reason: z.string().trim().max(500).default(""),
      recheckOn: z.string().max(10).optional(),
    })
    .parse(input ?? {});
  return atomic(() => {
    const player = requirePlayer(ctx, playerId) as WorkspacePlayer;
    const today = academyToday(ctx);
    const state = ageState(player, today);
    if (state.kind !== "DECIDE" && state.kind !== "KEPT")
      throw new WorkspaceError(409, "This player does not need an age decision.");
    let next: WorkspacePlayer;
    if (v.decision === "ARCHIVE") {
      next = { ...player, status: "ARCHIVED", ageDecision: null };
    } else {
      if (v.reason.length < 10)
        throw new WorkspaceError(422, "Write why this player stays (at least 10 characters).");
      const recheckOn = v.recheckOn ?? "";
      if (
        !isCalendarDay(recheckOn) ||
        recheckOn <= today ||
        daysBetween(today, recheckOn) > MAX_KEEP_DAYS
      )
        throw new WorkspaceError(
          422,
          "Choose a day to look at this again: after today and within a year.",
        );
      next = {
        ...player,
        ageDecision: {
          decision: "KEEP",
          reason: v.reason,
          decidedBy: ctx.user.id,
          decidedAt: new Date().toISOString(),
          recheckOn,
        },
      };
    }
    repo.save(ctx.academy.id, "player", {
      ...next,
      recordVersion: undefined,
    });
    audit(
      ctx.academy.id,
      ctx.user.id,
      v.decision === "ARCHIVE"
        ? "Age review: player archived (turned 18)"
        : "Age review: player kept for now (turned 18)",
      playerId,
    );
    return repo.find(ctx.academy.id, "player", playerId) as WorkspacePlayer;
  });
}
