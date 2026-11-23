import { describe, expect, it } from "vitest";
import { writeMonthlyFromSources } from "@/services/reports/auto-monthly";
import type { MonthlySources } from "@/domain/communication";

const sources = (over: Partial<MonthlySources["model"]> = {}, attendance = { total: 8, present: 6, absent: 1, excused: 1, unmarked: 0 }) =>
  ({
    period: { key: "2026-10" },
    model: {
      presentationData: { attendance },
      focus: "First touch under pressure",
      practised: "Rondo; Passing gates",
      evidence: [
        { text: "Attendance basis.", source: "Recorded session attendance" },
        { text: "Kept the ball well in tight spaces.", source: "Coach observation" },
      ],
      ...over,
    },
  }) as unknown as MonthlySources;

describe("monthly report written from the records", () => {
  it("states attendance, activities, focus and the coach's own recorded observations", () => {
    const out = writeMonthlyFromSources({ playerName: "Aadi Sharma", sources: sources() });
    expect(out.observation).toContain("Aadi attended 6 of 8 recorded sessions in 2026-10 (1 absent, 1 excused).");
    expect(out.observation).toContain("Activities practised: Rondo; Passing gates.");
    expect(out.observation).toContain("Training focus this month: First touch under pressure.");
    expect(out.observation).toContain("Coach observations recorded: Kept the ball well in tight spaces.");
    expect(out.nextStep).toBe("Continue working on: First touch under pressure.");
  });
  it("keeps the plan's own next step when there is one", () => {
    expect(writeMonthlyFromSources({ playerName: "A B", sources: sources(), planNextStep: "Work on weaker foot." }).nextStep).toBe("Work on weaker foot.");
  });
  it("writes nothing for a month with no recorded sessions", () => {
    const out = writeMonthlyFromSources({ playerName: "A B", sources: sources({}, { total: 0, present: 0, absent: 0, excused: 0, unmarked: 0 }) });
    expect(out).toEqual({ observation: "", nextStep: "", closingNote: "" });
  });
  it("never praises or scores", () => {
    const out = writeMonthlyFromSources({ playerName: "A B", sources: sources() });
    expect(`${out.observation} ${out.nextStep}`).not.toMatch(/excellent|great|improved|struggl|outstanding|poor/i);
  });
});
