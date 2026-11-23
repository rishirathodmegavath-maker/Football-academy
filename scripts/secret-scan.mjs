// Looks for credentials committed by mistake: private keys, well-known provider
// token formats, passwords inside URLs, secret-looking assignments (quoted in
// code, unquoted in shell/env/config files), and files that should never be in
// the repository (.env files, databases, key files). No dependencies.
//
// It prints WHERE and WHICH RULE, never the value. Exit 1 when it finds anything.
//
//   node scripts/secret-scan.mjs [directory]     (default: the current directory)
//
// Limits (be honest about them): it scans the CURRENT files only, not the git
// history (a credential that was committed and later deleted is still in the
// history and must be rotated); it recognises patterns, so a secret with no
// recognisable shape or name can pass; and it only protects anything if CI runs
// it as a required check. A deliberate fake is allowed on its line with the
// marker  secret-scan:allow  - that skips the generic assignment rule only,
// never a private key or a provider token format.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Shapes that are credentials wherever they appear (tests and docs included).
const FORMAT_RULES = [
  [
    "private key block",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\bsk_live_[0-9a-zA-Z]{20,}\b/],
  ["Anthropic or OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  [
    "JSON web token",
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ],
  ["bearer token literal", /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/],
  [
    "password in a URL",
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"'`]+:[^/\s@"'`${}<>]{4,}@[^\s"'`]+/i,
  ],
];
const NAME =
  "(?:secret|token|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|encryption[_-]?key|signing[_-]?key|access[_-]?key|credential|[a-z]_key)";
// code: name = "long value" (quoted)
const QUOTED = new RegExp(
  `${NAME}\\w*["']?\\s*[:=]\\s*["'\`]([^"'\`\\s]{20,})["'\`]`,
  "i",
);
// shell, env, yaml, ini, units: NAME=long-value (unquoted), in config-like files only
const UNQUOTED = new RegExp(
  `^\\s*(?:export\\s+)?[A-Za-z0-9_.-]*${NAME}[A-Za-z0-9_.-]*\\s*[:=]\\s*["']?([^"'\\s#]{20,})["']?\\s*$`,
  "i",
);
const CONFIG_FILE =
  /\.(sh|env|ya?ml|ini|conf|service|timer|properties|cfg)$|(^|\/)[^/]*\.env(\.[^/]*)?$|Caddyfile/i;
// Values that are references or placeholders, not credentials.
const NOT_A_VALUE =
  /^(?:process\.env|env\.|\$\{?[A-Z_]|\$\(|<|\{\{|%|\[|change[-_]?me|your[-_]|example|placeholder|xxx|\.\.\.|true$|false$|null$|undefined$|[a-z]+(?:[A-Z][a-z]+)+$|[A-Za-z_]+\()/i;
const FORBIDDEN_FILES = [
  [/(^|\/)\.env(\.|$)/, ".env file"],
  [/(^|\/)[^/]*\.env$/, "environment file"],
  [/\.(sqlite|sqlite3|db)(-wal|-shm)?$/, "database file"],
  [/\.(pem|key|p12|pfx)$/, "key file"],
  [/(^|\/)\.local\//, "local runtime data"],
];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "test-results",
  "playwright-report",
]);
const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|enc|lock)$|pnpm-lock\.yaml$/i;
const MAX_BYTES = 2_000_000;

function listFiles(root) {
  try {
    const out = execFileSync(
      "git",
      // The repository being scanned could configure helpers; never run them.
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    const walk = (dir) =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) return []; // never follow links out of the tree
        if (info.isDirectory())
          return SKIP_DIRS.has(name) ||
            name.startsWith(".next") ||
            name === ".local"
            ? []
            : walk(path);
        return [relative(root, path).split(sep).join("/")];
      });
    return walk(root);
  }
}
const looksLikeValue = (value) =>
  !NOT_A_VALUE.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
export function scan(root) {
  const findings = [];
  for (const file of listFiles(root)) {
    for (const [pattern, label] of FORBIDDEN_FILES)
      if (pattern.test(file) && !/\.example$/.test(file))
        findings.push({ file, line: 0, rule: label });
    if (SKIP_EXT.test(file) || file.startsWith("docs/screenshots/")) continue;
    let text;
    try {
      const path = join(root, file);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (info.size > MAX_BYTES) {
        // Design reference exports are large generated pages, not source.
        if (!file.startsWith("docs/reference/"))
          findings.push({ file, line: 0, rule: "file too large to scan" });
        continue;
      }
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    // Documentation and test fixtures legitimately show fake assignments.
    const lenient = file.startsWith("tests/") || file.startsWith("docs/");
    const config = CONFIG_FILE.test(file);
    text.split(/\r?\n/).forEach((line, index) => {
      for (const [label, pattern] of FORMAT_RULES)
        if (pattern.test(line))
          findings.push({ file, line: index + 1, rule: label });
      if (lenient || line.includes("secret-scan:allow")) return;
      const quoted = QUOTED.exec(line);
      if (quoted && looksLikeValue(quoted[1]))
        findings.push({
          file,
          line: index + 1,
          rule: "secret-looking assignment",
        });
      else if (config) {
        const bare = UNQUOTED.exec(line);
        if (bare && looksLikeValue(bare[1]))
          findings.push({
            file,
            line: index + 1,
            rule: "secret-looking assignment",
          });
      }
    });
  }
  return findings;
}
if (process.argv[1]?.endsWith("secret-scan.mjs")) {
  const root = resolve(process.argv[2] ?? ".");
  const findings = scan(root);
  for (const f of findings)
    console.log(`${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}`);
  console.log(
    findings.length
      ? `\n${findings.length} possible secret${findings.length === 1 ? "" : "s"} found. Values are not printed.`
      : "No secrets found.",
  );
  process.exit(findings.length ? 1 : 0);
}
