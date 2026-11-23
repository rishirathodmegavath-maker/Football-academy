/**
 * Strips what must never reach a log or an alert from free text: links (which
 * carry tokens in their query strings), e-mail addresses, bearer and
 * long token-like strings, and long digit runs (telephone and card-like
 * numbers). Deliberately blunt: a log line that loses detail is a smaller
 * problem than one that keeps a child's guardian's address.
 *
 * Applied to every string the structured logger writes (log.ts) and to error
 * messages and stacks, which can echo request data.
 */
// ISO dates and times are kept as they are (otherwise "2026-11-02" reads as a long number).
const ISO_STAMP = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;
export function redact(value: string, max = 300): string {
  const stamps: string[] = [];
  const hidden = value.replace(
    ISO_STAMP,
    (m) => `\u0000${stamps.push(m) - 1}\u0000`,
  );
  return hidden
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, "[email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[token]")
    .replace(/\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => stamps[Number(i)])
    .slice(0, max);
}
