// Country policy for heading content. Heading practice is never authored or
// enabled until a country's guidance has been verified against PRIMARY sources
// (the national football association's own documents). The default is closed:
// an unknown country, or an entry without a source and a verification date,
// leaves heading disabled. Adding a country is a data change here; the
// catalogue itself does not change.

export interface HeadingPolicy {
  /** ISO 3166-1 alpha-2, as in the academy configuration. */
  country: string;
  /** True only after primary-source verification. */
  verified: boolean;
  /** The primary source that was checked (required when verified). */
  source?: string;
  /** ISO date of the verification (required when verified). */
  verifiedOn?: string;
  note: string;
}

export const HEADING_POLICIES: Readonly<Record<string, HeadingPolicy>> = {
  IN: {
    country: "IN",
    verified: false,
    note: "India is the initial operating jurisdiction. No authoritative Indian guidance has been verified, so heading stays disabled.",
  },
};

export interface HeadingStatus {
  country: string;
  headingEnabled: boolean;
  note: string;
}

export function headingPolicyFor(country: string | undefined): HeadingStatus {
  const code = (country ?? "").toUpperCase();
  const policy = HEADING_POLICIES[code];
  const enabled =
    !!policy && policy.verified === true && !!policy.source && !!policy.verifiedOn;
  return {
    country: code,
    headingEnabled: enabled,
    note: enabled
      ? policy.note
      : (policy?.note ??
        "No verified heading guidance exists for this country, so heading stays disabled."),
  };
}
