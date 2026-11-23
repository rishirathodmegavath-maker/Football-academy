import { domainToASCII } from "node:url";
import { z } from "zod";

/**
 * Recipient address check for every message the application sends. Standards
 * based and country-neutral: any domain and any top-level domain is accepted
 * (.com, .co.uk, .ae, .com.au, .de, .in, new TLDs), and internationalised
 * domains (IDN) are converted to their ASCII form for sending. Nothing here
 * looks at the domain's country or at a list of "known" providers.
 *
 * Accepted: RFC 5322 dot-atom local parts (including + tags) and Unicode
 * letters and digits in the local part (RFC 6531); a domain of letters, digits
 * and hyphens in labels of 1-63 characters, with at least two labels and a
 * non-numeric last label. Refused: quoted local parts, comments, display names,
 * IP literals, control characters and anything that could inject a header.
 */
export type Recipient =
  | { ok: true; address: string; ascii: string }
  | { ok: false; reason: string };

const LOCAL_ATOM = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+$/u;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkRecipient(raw: string): Recipient {
  const value = raw.normalize("NFC").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (/[\u0000-\u001f\u007f-\u009f\s<>,;:()[\]\\"]/u.test(value))
    return { ok: false, reason: "forbidden character" };
  if (Buffer.byteLength(value, "utf8") > 254)
    return { ok: false, reason: "too long" };
  const at = value.lastIndexOf("@");
  if (at < 1 || value.indexOf("@") !== at)
    return { ok: false, reason: "needs exactly one @" };
  const local = value.slice(0, at),
    domain = value.slice(at + 1);
  if (Buffer.byteLength(local, "utf8") > 64)
    return { ok: false, reason: "local part too long" };
  if (!local.split(".").every((atom) => LOCAL_ATOM.test(atom)))
    return { ok: false, reason: "invalid local part" };
  const ascii = domainToASCII(domain.toLowerCase());
  if (!ascii || ascii.length > 253)
    return { ok: false, reason: "invalid domain" };
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    return { ok: false, reason: "invalid domain" };
  if (/^\d+$/.test(labels.at(-1)!))
    return { ok: false, reason: "invalid domain" };
  return { ok: true, address: `${local}@${domain.toLowerCase()}`, ascii: `${local}@${ascii}` };
}

/** Control characters and line breaks removed, for names placed in a header or subject. */
export const headerSafe = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The form in which an address is stored as an account name and compared at
 * sign-in: lower case, with an internationalised domain converted to ASCII
 * (anna@münchen.de becomes anna@xn--mnchen-3ya.de), because Better Auth only
 * accepts ASCII. Null when the address is not valid or has a non-ASCII local
 * part (SMTPUTF8): no account can be created for it and mainstream providers do
 * not deliver to it, so it is refused with a clear message instead.
 */
export function accountEmail(raw: string): string | null {
  const checked = checkRecipient(raw);
  if (!checked.ok || /\P{ASCII}/u.test(checked.ascii)) return null;
  return checked.ascii.toLowerCase();
}
/** For API bodies: a valid address from any country, stored in account form. */
export const accountEmailSchema = z
  .string()
  .max(254)
  .transform((value, ctx) => {
    const email = accountEmail(value);
    if (!email) {
      ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
      return z.NEVER;
    }
    return email;
  });
