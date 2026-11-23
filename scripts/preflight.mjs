// Usage: node scripts/preflight.mjs [--build | --artifact] [--env-file <path>]
// Checks the production configuration and exits 1 on any FAIL. It prints
// check names and verdicts only, never the value of a secret.
import { failed, runChecks } from "./lib/preflight.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--env-file");
if (at >= 0) {
  if (!args[at + 1]) throw new Error("--env-file needs a path");
  process.loadEnvFile(args[at + 1]);
}
const mode = args.includes("--build")
  ? "build"
  : args.includes("--artifact")
    ? "artifact"
    : "start";
const results = runChecks({
  env: process.env,
  cwd: process.cwd(),
  nodeVersion: process.version,
  platform: process.platform,
  mode,
});
for (const r of results)
  console.log(`${r.level.padEnd(4)}  ${r.name}: ${r.message}`);
const bad = failed(results);
console.log(
  bad.length
    ? `\nPreflight (${mode}) FAILED: ${bad.length} check${bad.length === 1 ? "" : "s"}.`
    : `\nPreflight (${mode}) passed${results.some((r) => r.level === "WARN") ? " with warnings" : ""}.`,
);
process.exit(bad.length ? 1 : 0);
