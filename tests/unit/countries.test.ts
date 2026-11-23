import { describe, expect, it } from "vitest";
import {
  COUNTRIES,
  CURRENCIES,
  DEFAULT_COUNTRY,
  countryInfo,
  regionalDefaults,
} from "@/domain/countries";
import { academySchema } from "@/domain/academy-configuration-schema";

const base = {
  name: "Test Academy",
  contactEmail: "office@example.test",
  country: "IN",
  language: "English",
  currency: "INR",
  timezone: "Asia/Kolkata",
  dateLocale: "en-IN",
  measurementSystem: "METRIC" as const,
  brandAccent: "#008463" as const,
};

describe("countries on offer", () => {
  it("offers an international list, each with a unique two-letter code", () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(55);
    const codes = COUNTRIES.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
    // The list covers every continent a football academy may be on.
    for (const code of ["IN", "US", "GB", "AE", "AU", "BR", "ZA", "JP", "DE"])
      expect(countryInfo(code), code).toBeTruthy();
  });

  it("gives every country a currency, time zone and locale the server accepts", () => {
    // The same checks the server makes when an academy is created.
    for (const country of COUNTRIES) {
      expect(country.timezones.length, country.code).toBeGreaterThan(0);
      for (const timeZone of country.timezones)
        expect(
          () => new Intl.DateTimeFormat(country.locale, { timeZone }),
          `${country.code} ${timeZone}`,
        ).not.toThrow();
      expect(
        () =>
          new Intl.NumberFormat(country.locale, {
            style: "currency",
            currency: country.currency,
          }),
        `${country.code} ${country.currency}`,
      ).not.toThrow();
      expect(
        CURRENCIES.some((currency) => currency.code === country.currency),
        `${country.code} currency is on offer`,
      ).toBe(true);
      expect(country.cities.length, `${country.code} cities`).toBeGreaterThan(
        0,
      );
    }
  });

  it("lists each currency once, with a name", () => {
    const codes = CURRENCIES.map((currency) => currency.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const currency of CURRENCIES) {
      expect(currency.code).toMatch(/^[A-Z]{3}$/);
      expect(currency.name.length).toBeGreaterThan(2);
    }
  });

  it("fills in the region's defaults when a country is chosen", () => {
    expect(regionalDefaults("IN")).toEqual({
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dateLocale: "en-IN",
      measurementSystem: "METRIC",
    });
    expect(regionalDefaults("GB")).toMatchObject({
      currency: "GBP",
      timezone: "Europe/London",
    });
    expect(regionalDefaults("US")).toMatchObject({
      currency: "USD",
      timezone: "America/New_York",
      measurementSystem: "IMPERIAL",
    });
    expect(regionalDefaults("AE").currency).toBe("AED");
    // An unknown code never produces a half-empty form.
    expect(regionalDefaults("ZZ").country).toBe(DEFAULT_COUNTRY);
  });

  it("keeps every default the stored academy configuration accepts", () => {
    for (const country of COUNTRIES) {
      const defaults = regionalDefaults(country.code);
      expect(
        academySchema.safeParse({ ...base, ...defaults, city: "Anywhere" })
          .success,
        country.code,
      ).toBe(true);
    }
  });
});

describe("the academy's city", () => {
  it("is stored trimmed, and is optional for academies made without one", () => {
    expect(academySchema.parse({ ...base, city: "  Mumbai " }).city).toBe(
      "Mumbai",
    );
    expect(academySchema.parse(base).city).toBeUndefined();
  });
});
