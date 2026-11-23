// WP7: static tripwires. They do not prove the absence of bugs; they make the
// easiest ways to open an injection hole show up in review instead of passing
// quietly.
//   1. SQL text that is built rather than written out (every case is reviewed).
//   2. Raw HTML or code-execution sinks in application code.
//   3. Reading the caller's own claims about who they are.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
function walk(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "node_modules" || name.startsWith(".")
        ? []
        : walk(path, extensions);
    return extensions.some((e) => name.endsWith(e)) ? [path] : [];
  });
}
const rel = (path: string) => relative(ROOT, path).replace(/\\/g, "/");
const sources = [
  ...walk(join(ROOT, "src"), [".ts", ".tsx"]),
  ...walk(join(ROOT, "scripts"), [".ts", ".mjs"]),
];
const text = new Map(
  sources.map((file) => [rel(file), readFileSync(file, "utf8")]),
);
const applicationSources = [...text].filter(([file]) =>
  file.startsWith("src/"),
);

/** The text of the argument list of the call whose "(" is at `open`. */
function argumentText(source: string, open: number) {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      else if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        // an interpolation: skip to its closing brace
        let braces = 0;
        for (i += 1; i < source.length; i++) {
          if (source[i] === "{") braces++;
          else if (source[i] === "}" && --braces === 0) break;
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}
/** Every `${…}` inside a template literal in `argument`. */
function interpolations(argument: string) {
  const found: string[] = [];
  for (const literal of argument.matchAll(/`((?:[^`\\]|\\[\s\S])*)`/g))
    for (const expression of literal[1].matchAll(/\$\{([^}]*)\}/g))
      found.push(expression[1].trim());
  return found;
}

describe("SQL that is built rather than written out", () => {
  // What each prepare()/exec() call that is not a plain literal builds from, as
  // "${expression}" for an interpolation or "variable: name" for SQL held in a
  // variable. Every entry was read and is a constant or a fixed vocabulary,
  // never request data. A new or removed entry fails this test until it is
  // reviewed here (the comparison includes how many times each occurs).
  const REVIEWED: Record<string, string[]> = {
    "src/server/data-integrity.ts": ["${table}"], // a literal list of two table names
    "src/server/session-notices.ts": [
      // one "?" per player id, joined by commas: the ids themselves are bound
      '${wanted.map(() => "?").join(",")}',
    ],
    "src/server/workspace-access.ts": [
      '${membership.role === "SUPPORT" ? "support_relationships" : "guardian_relationships"}', // two fixed table names chosen by role
    ],
    "src/server/communication-repository.ts": [
      // jobsPage: the sort direction is one of two literals chosen from an
      // enum, and the WHERE is a join of fixed fragments ("state=?", ...);
      // every value is a bound parameter (two direction uses, one WHERE)
      '${newest ? "DESC" : "ASC"}',
      '${newest ? "DESC" : "ASC"}',
      '${where.join(" AND ")}',
    ],
    "src/server/academy-lifecycle.ts": [
      "${STATE_ORDER}", // a module constant: a fixed CASE over the six state names
    ],
    "src/server/delivery-retention.ts": [
      // Module constants, never input: ELIGIBLE_JOB / ELIGIBLE_EVENT are fixed
      // WHERE fragments, FINAL the four literal final job states, UTC one
      // literal GLOB pattern. The cut-off and the batch size are bound
      // parameters. Counts are how many statements use each.
      "${ELIGIBLE_EVENT}",
      "${ELIGIBLE_EVENT}",
      "${ELIGIBLE_EVENT}",
      "${ELIGIBLE_JOB}",
      "${ELIGIBLE_JOB}",
      "${ELIGIBLE_JOB}",
      "${FINAL}",
      "${FINAL}",
      "${FINAL}",
      "${UTC}",
      "${UTC}",
      "${UTC}",
      "${UTC}",
      "${UTC}",
      "${UTC}",
    ],
    "src/server/communication-service.ts": [
      '${playerId ? " AND playerId=?" : ""}', // a fixed fragment; the id itself is a bound parameter
    ],
    "src/server/database.ts": [
      // "sportozen_unit_<depth>": a counter, never input (four uses)
      "${savepoint}",
      "${savepoint}",
      "${savepoint}",
      "${savepoint}",
    ],
    "src/server/migrations/008-integrity-guards.ts": [
      // trigger definitions assembled from a literal list in the same file
      "${guard.name}",
      "${event}",
      "${guard.table}",
      '${guard.violation("")}',
      "${event.toUpperCase()}",
      "${guard.table}",
      '${guard.violation("NEW.")}',
      "${guard.message}",
      "variable: statement", // executes the statements assembled above
    ],
    "src/server/migrations/010-email-delivery.ts": [
      // the outbox table definition (built from a literal list of message
      // kinds), a literal index list and a literal column list, all constants
      // in the same file
      "${INDEXES}",
      "${OLD_COLUMNS}",
      "${OLD_COLUMNS}",
      '${OUTBOX("email_outbox_new")}',
    ],
    "scripts/lib/backup.mjs": [
      "${name.replaceAll('\"', '\"\"')}", // table names read from sqlite_master, quoted
    ],
  };
  const found = new Map<string, string[]>();
  for (const [file, source] of text)
    // prepare() always; .exec() only when it is SQL (RegExp.exec is not).
    for (const call of source.matchAll(/\.(prepare|exec)\(/g)) {
      const argument = argumentText(source, call.index! + call[0].length - 1);
      const sqlLike =
        call[1] === "prepare" ||
        /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(
          argument,
        ) ||
        /^(?:sql|statement|query)\w*$/i.test(argument.trim());
      if (!sqlLike) continue;
      const entries = interpolations(argument).map((e) => `\${${e}}`);
      // SQL held in a variable is invisible to this scan, so it is listed.
      if (/^[A-Za-z_$][\w$.]*$/.test(argument.trim()))
        entries.push(`variable: ${argument.trim()}`);
      if (entries.length)
        found.set(file, [...(found.get(file) ?? []), ...entries]);
    }
  it("matches the reviewed list exactly", () => {
    const sorted = (entries: string[]) => [...entries].sort();
    expect(
      Object.fromEntries([...found].map(([file, e]) => [file, sorted(e)])),
      "new or removed built SQL needs review",
    ).toEqual(
      Object.fromEntries(
        Object.entries(REVIEWED).map(([file, e]) => [file, sorted(e)]),
      ),
    );
  });
});

describe("rendering and code-execution sinks", () => {
  it("never writes raw HTML or runs strings as code", () => {
    const sinks =
      /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*\+?=|insertAdjacentHTML|document\.write|createContextualFragment|\bsrcdoc\b|\beval\s*\(|(?:new\s+)?\bFunction\s*\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`]|setAttribute\(\s*["']on|javascript:/;
    expect(
      applicationSources
        .filter(([, source]) => sinks.test(source))
        .map(([file]) => file),
    ).toEqual([]);
  });
  it("never reads a cookie or storage by hand in components (sessions are HttpOnly)", () => {
    // Components call hooks; only the demo storage adapters may touch storage.
    expect(
      applicationSources
        .filter(([file]) => file.endsWith(".tsx"))
        .filter(([, source]) =>
          /document\.cookie|localStorage|sessionStorage/.test(source),
        )
        .map(([file]) => file),
    ).toEqual([]);
  });
});

describe("who is calling", () => {
  it("is decided from the session only, never from a header the caller controls", () => {
    // The client-supplied academy id is a route parameter that is checked
    // against the signed-in user's memberships; these headers would be claims.
    const claims =
      /headers(?:\.get\(|\[)\s*["'](?:x-user|x-user-id|x-role|x-academy|x-forwarded-user|x-auth)/i;
    expect(
      applicationSources
        .filter(([, source]) => claims.test(source))
        .map(([file]) => file),
    ).toEqual([]);
  });
});
