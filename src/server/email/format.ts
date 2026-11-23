/**
 * Dates in messages. The application stores and compares instants in UTC (ISO
 * strings); only the text shown to a person is converted. The recipient's time
 * zone and language are never guessed from the address or its domain: callers
 * pass what the person or their academy has chosen, and without one the time
 * is shown in UTC and says so.
 */
export type RecipientLocale = { locale?: string; timeZone?: string };

function validTimeZone(value?: string) {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}
function validLocale(value?: string) {
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/** "Monday, 3 November 2026 at 6:30 pm IST": an instant in the recipient's own zone. */
export function formatInstant(iso: string, options: RecipientLocale = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date.");
  return new Intl.DateTimeFormat(validLocale(options.locale) ?? "en", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: validTimeZone(options.timeZone) ?? "UTC",
    timeZoneName: "short",
  }).format(date);
}

/** An amount in the currency it was charged in, formatted for the recipient's language. */
export function formatMoney(
  minorUnits: number,
  currency: string,
  options: RecipientLocale = {},
) {
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Invalid currency code.");
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency: code })
      .resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(validLocale(options.locale) ?? "en", {
    style: "currency",
    currency: code,
  }).format(minorUnits / 10 ** digits);
}
