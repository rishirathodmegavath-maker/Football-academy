import type { FootballClosure } from "@/domain/training";

/** Longest closure one record may describe (a school-year break is a year). */
export const MAX_CLOSURE_DAYS = 366;

/** The active closure that covers this branch on this academy-local date, if
 * any. A closure with no branch covers every branch. */
export function closureCovering(
  closures: readonly FootballClosure[],
  branchId: string,
  date: string,
): FootballClosure | undefined {
  return closures.find(
    (closure) =>
      closure.status === "ACTIVE" &&
      (closure.branchId === "" || closure.branchId === branchId) &&
      closure.startDate <= date &&
      date <= closure.endDate,
  );
}
/** The academy-local date of a session or series occurrence (`YYYY-MM-DDTHH:mm`). */
export const localDateOf = (startLocal: string) => startLocal.slice(0, 10);

/** Whole days from start to end, inclusive. Dates are plain calendar dates. */
export function closureDays(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}
/** Staff-facing message for a refusal or a skipped date. */
export function closureMessage(closure: FootballClosure, branchName?: string) {
  const where = closure.branchId ? (branchName ?? "this branch") : "the academy";
  const range =
    closure.startDate === closure.endDate
      ? closure.startDate
      : `${closure.startDate} to ${closure.endDate}`;
  return `${where} is closed on ${range}: ${closure.reason}`;
}
