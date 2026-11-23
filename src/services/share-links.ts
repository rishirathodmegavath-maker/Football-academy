/**
 * Free messaging by link. Nothing here calls a provider or needs an account with one: the person sending (owner or coach)
 * presses a button, their own WhatsApp or mail app opens with the recipient and the text already filled in, and they press
 * Send there. Pure functions only, so they run in the browser and in tests alike.
 */

/** E.164 digits without "+", or null. A number without "+" is accepted only when a default country code is given. */
export function normalizePhone(
  raw: string,
  defaultCountryCode: string | null,
): string | null {
  const text = (raw ?? "").trim();
  // "+" is valid only as the very first character: "++91..." and "91+98..." are typos, not numbers.
  if (!text || /[^\d\s()+\-.]/.test(text) || text.slice(1).includes("+"))
    return null;
  const digits = text.replace(/\D/g, "");
  let full: string;
  if (text.startsWith("+")) full = digits;
  else if (text.startsWith("00")) full = digits.slice(2);
  else if (defaultCountryCode)
    full = `${defaultCountryCode}${digits.replace(/^0+/, "")}`;
  else return null;
  return /^[1-9]\d{7,14}$/.test(full) ? full : null;
}

/** The calling code a two-letter academy country implies when a number is typed without one. */
export const COUNTRY_CALLING_CODE: Record<string, string> = {
  IN: "91",
  US: "1",
  GB: "44",
  AE: "971",
  AU: "61",
  CA: "1",
  SG: "65",
};

/**
 * https://wa.me/<number>?text=<message>. With a usable number the chat with that person opens; without one WhatsApp
 * opens its own chooser so the sender picks the contact. The text is always percent-encoded.
 */
export function whatsappLink(
  phone: string | null | undefined,
  text: string,
  defaultCountryCode: string | null = null,
): string {
  const digits = phone ? normalizePhone(phone, defaultCountryCode) : null;
  return `https://wa.me/${digits ?? ""}?text=${encodeURIComponent(text)}`;
}

/**
 * The WhatsApp link for a number the app stored: the server keeps it as international digits without a "+" (for example
 * 919876543210). Passing those digits to `whatsappLink` with a country code would read them as a local number and add the
 * country code a second time, so the "+" is put back first.
 */
export function savedPhoneLink(phone: string, text: string): string {
  return whatsappLink(`+${phone.replace(/^\+/, "")}`, text);
}

/** mailto: with the recipient, subject and body filled in (the sender's own mail app does the sending). */
export function mailtoLink(
  email: string | null | undefined,
  subject: string,
  body: string,
): string {
  const to = (email ?? "").trim();
  return `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Web mail compose links. A mailto: link does nothing on a computer with no mail app set up, so these open a ready-to-send
 * message in the browser instead (Gmail or Outlook on the web). The sender is still the person pressing Send there.
 */
export function gmailLink(
  email: string | null | undefined,
  subject: string,
  body: string,
): string {
  const to = (email ?? "").trim();
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function outlookLink(
  email: string | null | undefined,
  subject: string,
  body: string,
): string {
  const to = (email ?? "").trim();
  return `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
