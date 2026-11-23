// The one environment notice: shown everywhere except an explicitly declared production
// environment (UX decision UX-D12; owner correction round after the Wave 1 review).
import { describe, expect, it } from "vitest";
import {
  environmentNotice,
  environmentNoticeText,
  isProductionEnvironment,
} from "@/services/environment-notice";

describe("environment notice", () => {
  it("has the approved wording", () => {
    expect(environmentNoticeText).toBe(
      "Pilot environment. Please do not enter real customer information yet.",
    );
  });
  it("is absent only when production is declared explicitly", () => {
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: "production" })).toBeNull();
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: " Production " })).toBeNull();
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: "PRODUCTION" })).toBeNull();
  });
  it("is shown for every named non-production environment", () => {
    for (const name of ["pilot", "local", "development", "staging", "test"]) {
      expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: name })).toBe(environmentNoticeText);
    }
  });
  it("is shown when the variable is missing or empty", () => {
    expect(environmentNotice({})).toBe(environmentNoticeText);
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: "" })).toBe(environmentNoticeText);
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: "   " })).toBe(environmentNoticeText);
    expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: undefined })).toBe(environmentNoticeText);
  });
  it("is shown when the value is invalid, so a typo can never hide it", () => {
    for (const value of ["prod", "live", "production!", "productio", "1", "true", "yes"]) {
      expect(environmentNotice({ SPORTOZEN_ENVIRONMENT: value })).toBe(environmentNoticeText);
    }
  });
  it("does not guess from the address of the site", () => {
    expect(environmentNotice({ BETTER_AUTH_URL: "https://app.example.com" })).toBe(
      environmentNoticeText,
    );
    expect(environmentNotice({ BETTER_AUTH_URL: "http://127.0.0.1:3200" })).toBe(
      environmentNoticeText,
    );
    expect(
      isProductionEnvironment({
        SPORTOZEN_ENVIRONMENT: "pilot",
        BETTER_AUTH_URL: "https://app.example.com",
      }),
    ).toBe(false);
    expect(
      isProductionEnvironment({
        SPORTOZEN_ENVIRONMENT: "production",
        BETTER_AUTH_URL: "http://127.0.0.1:3200",
      }),
    ).toBe(true);
  });
  it("does not say what is or is not switched on", () => {
    expect(environmentNoticeText).not.toMatch(/verification|recovery|hardening/i);
  });
});
