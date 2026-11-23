import {
  DRILL_CATEGORIES,
  type DrillCategoryId,
  type UniversalDrill,
} from "@/domain/drill-library";
import { warmUpActivation } from "./warm-up-activation";
import { ballControlDribbling } from "./ball-control-dribbling";
import { passingCombinationPlay } from "./passing-combination-play";
import { possessionSmallSidedGames } from "./possession-small-sided-games";
import { shootingCrossingFinishing } from "./shooting-crossing-finishing";
import { defendingPressing } from "./defending-pressing";
import { fitnessSpeedGoalkeeping } from "./fitness-speed-goalkeeping";

/**
 * The universal drill catalogue: the approved 50 drills, in their original
 * numbering. It is code, changed only by a reviewed release, and read-only at
 * run time. Entries marked DRAFT are never served.
 */
export const UNIVERSAL_CATALOGUE: readonly UniversalDrill[] = Object.freeze(
  [
    ...warmUpActivation,
    ...ballControlDribbling,
    ...passingCombinationPlay,
    ...possessionSmallSidedGames,
    ...shootingCrossingFinishing,
    ...defendingPressing,
    ...fitnessSpeedGoalkeeping,
  ].sort((a, b) => a.number - b.number),
);

export const publishedDrills = (): UniversalDrill[] =>
  UNIVERSAL_CATALOGUE.filter((d) => d.status === "PUBLISHED");

export function findUniversalDrill(id: string): UniversalDrill | undefined {
  return publishedDrills().find((d) => d.id === id);
}

/** Initial counts are fixed constants; published counts are derived. */
export function categorySummary() {
  const published = publishedDrills();
  return DRILL_CATEGORIES.map((c) => ({
    id: c.id as DrillCategoryId,
    name: c.name,
    initialCount: c.initialCount,
    publishedCount: published.filter((d) => d.categoryId === c.id).length,
  }));
}
