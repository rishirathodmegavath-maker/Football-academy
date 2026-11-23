import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { sessionPolicy } from "@/server/account-security";

describe("stay signed in until sign out", () => {
  it("keeps the strict default when the operator has not chosen it", () => {
    expect(sessionPolicy({}).absoluteSeconds).toBe(8 * 3600);
    expect(
      sessionPolicy({ SPORTOZEN_SESSION_PERSISTENT: "0" }).absoluteSeconds,
    ).toBe(8 * 3600);
    expect(
      sessionPolicy({ SPORTOZEN_SESSION_PERSISTENT: "true" }).absoluteSeconds,
    ).toBe(8 * 3600);
  });

  it("lasts a year and renews while used, when switched on", () => {
    const year = 365 * 24 * 3600;
    expect(sessionPolicy({ SPORTOZEN_SESSION_PERSISTENT: "1" })).toEqual({
      absoluteSeconds: year,
      expiresIn: year,
      updateAge: undefined,
    });
  });

  it("does not loosen the other limits when it is off", () => {
    expect(() =>
      sessionPolicy({ SPORTOZEN_SESSION_MAX_HOURS: "100" }),
    ).toThrow();
  });
});
