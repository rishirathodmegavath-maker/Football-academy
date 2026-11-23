/** A short list of priorities ("A; B; C", one per line, or bullets) is shown as
 * separate cards; anything longer or free-form stays as one card with its full
 * wording. Nothing is added, dropped or reworded either way. */
export function developmentPriorities(text: string): string[] {
  const parts = text
    .split(/\r?\n+|;\s+|\s+[•·]\s+/)
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  return parts.length >= 2 &&
    parts.length <= 4 &&
    parts.every((part) => part.length <= 90)
    ? parts
    : [text];
}
