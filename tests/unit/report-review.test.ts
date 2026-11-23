import { describe, expect, it } from "vitest";
import type { WorkspaceReport } from "@/domain/workspace";
import {
  reportReviewEligibility,
  reviewSubject,
} from "@/services/reports/report-review";

const report: WorkspaceReport = {
  id: "report",
  academyId: "academy",
  sportId: "football",
  playerId: "player",
  planId: "",
  period: "2026-08",
  observation: "",
  closingNote: "",
  nextStep: "Observe close control in the next session.",
  evidenceType: "MISSING_OR_UNCLEAR",
  status: "Draft",
  externalDeliveryStatus: "NOT_SENT",
  reportingPeriod: {
    key: "2026-08",
    timezone: "Asia/Kolkata",
    startAt: "2026-07-31T18:30:00.000Z",
    endAt: "2026-08-31T18:30:00.000Z",
  },
  monthlySources: {
    period: {
      key: "2026-08",
      timezone: "Asia/Kolkata",
      startAt: "2026-07-31T18:30:00.000Z",
      endAt: "2026-08-31T18:30:00.000Z",
    },
    sessionIds: [],
    evidenceIds: [],
    fingerprint: "saved",
    trainingFingerprint: "saved",
    model: {
      focus: "No focus recorded",
      practised: "No participation recorded",
      activities: [],
      evidence: [],
    },
  },
};
const options = {
  dirty: false,
  reviewed: true,
  now: new Date("2026-10-17T00:00:00Z"),
};

describe("monthly report review guidance", () => {
  it("keeps an explicitly reviewed limited-evidence report eligible without inventing achievements", () => {
    expect(reportReviewEligibility(report, options)).toMatchObject({
      canApprove: true,
      queueStatus: "Ready for Approval",
    });
    expect(report.monthlySources?.model.activities).toEqual([]);
  });
  it.each([
    [{ ...options, dirty: true }, /Save your changes/],
    [{ ...options, reviewed: false }, /Confirm that you reviewed/],
    [{ ...options, now: new Date("2026-08-30T00:00:00Z") }, /month ends/],
    [
      {
        ...options,
        sourceReview: {
          sourcesCurrent: false,
          reason: "Recorded attendance changed",
        },
      },
      /Recorded attendance changed/,
    ],
    [{ ...options, busy: true }, /save to finish/],
  ])("shows the actual blocked action: %j", (settings, reason) => {
    const result = reportReviewEligibility(report, settings);
    expect(result.canApprove).toBe(false);
    expect(result.reason).toMatch(reason);
  });
  it("requires saved next focus but permits incomplete drafts", () => {
    expect(
      reportReviewEligibility({ ...report, nextStep: "" }, options),
    ).toMatchObject({ canApprove: false, queueStatus: "Draft" });
    expect(
      reportReviewEligibility({ ...report, nextStep: "" }, options).reason,
    ).toMatch(/next development focus/);
  });
  it("never marks an approved historical report editable", () => {
    expect(
      reportReviewEligibility({ ...report, status: "Approved" }, options),
    ).toMatchObject({ canApprove: false, queueStatus: "Approved" });
  });
  it("handles a missing draft and malformed historical period without approving", () => {
    expect(reportReviewEligibility(undefined, options).queueStatus).toBe(
      "Draft",
    );
    expect(
      reportReviewEligibility(
        {
          ...report,
          reportingPeriod: { ...report.reportingPeriod!, endAt: "missing" },
        },
        options,
      ).canApprove,
    ).toBe(false);
  });
});

describe("review guidance from a listed report", () => {
  const variants: [string, Partial<WorkspaceReport>][] = [
    ["a draft with a next step", {}],
    ["an untouched draft", { nextStep: "" }],
    ["text in the observation only", { nextStep: "", observation: "Seen." }],
    [
      "a missing next step after feedback",
      { nextStep: "  ", closingNote: "x" },
    ],
    ["an approved report", { status: "Approved" }],
    ["a report without monthly sources", { monthlySources: undefined }],
    [
      "a malformed period",
      { reportingPeriod: { ...report.reportingPeriod!, endAt: "missing" } },
    ],
  ];
  it.each(variants)(
    "agrees with the full report for %s, whatever the options",
    (_name, change) => {
      const full = { ...report, ...change } as WorkspaceReport;
      for (const extra of [
        options,
        { ...options, dirty: true },
        { ...options, reviewed: false },
        { ...options, now: new Date("2026-08-30T00:00:00Z") },
        {
          ...options,
          sourceReview: { sourcesCurrent: false, reason: "Changed." },
        },
      ])
        expect(reportReviewEligibility(reviewSubject(full), extra)).toEqual(
          reportReviewEligibility(full, extra),
        );
    },
  );
});
