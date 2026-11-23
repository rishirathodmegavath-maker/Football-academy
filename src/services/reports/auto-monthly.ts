import type { MonthlySources } from "@/domain/communication";

/**
 * The words of a monthly report written from the records alone, for the one-click batch report. Everything here is a count,
 * a drill name, a focus a coach recorded, or an observation a coach recorded and the academy reviewed. It never praises,
 * scores, compares players or predicts, and the coach can change every word before the report is approved.
 * A player with no recorded sessions in the month gets nothing written (the report stays a plain draft).
 */
export function writeMonthlyFromSources(input: {
  playerName: string;
  sources: MonthlySources;
  /** The next step already on the player's development plan, kept when there is one. */
  planNextStep?: string;
}): { observation: string; nextStep: string; closingNote: string } {
  const { sources } = input;
  const model = sources.model;
  const attendance = model.presentationData?.attendance;
  const first = input.playerName.trim().split(/\s+/)[0] || "The player";
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (!attendance || !attendance.total)
    return {
      observation: "",
      nextStep: input.planNextStep ?? "",
      closingNote: "",
    };
  const away = [
    attendance.absent && `${attendance.absent} absent`,
    attendance.excused && `${attendance.excused} excused`,
  ].filter(Boolean);
  const lines = [
    `${first} attended ${attendance.present} of ${plural(attendance.total, "recorded session")} in ${sources.period.key}${away.length ? ` (${away.join(", ")})` : ""}.` +
      (attendance.unmarked
        ? ` Attendance is not marked for ${plural(attendance.unmarked, "session")}.`
        : ""),
  ];
  const practised = model.practised?.trim();
  if (practised && !/^No confirmed/i.test(practised))
    lines.push(`Activities practised: ${practised}.`);
  const focus = model.focus?.trim();
  const hasFocus = !!focus && !/^No training focus/i.test(focus);
  if (hasFocus) lines.push(`Training focus this month: ${focus}.`);
  const observed = (model.evidence ?? [])
    .filter(
      (item) =>
        item.source !== "Recorded session attendance" &&
        !/^Missing evidence/i.test(item.source),
    )
    .map((item) => item.text.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean);
  if (observed.length)
    lines.push(`Coach observations recorded: ${observed.slice(0, 5).join("; ")}.`);
  return {
    observation: lines.join(" "),
    nextStep:
      input.planNextStep?.trim() ||
      (hasFocus
        ? `Continue working on: ${focus}.`
        : "Continue the training plan set by the coach, building on the activities practised this month."),
    closingNote: "",
  };
}
