import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // Several suites start real child processes (database start-up, backups,
    // shutdown, CLIs). With one worker per core on a 12-core machine they
    // starve ordinary tests: a 0.3 s test was measured at 6 s and timed out
    // in about half of the full runs. Eight workers keep the machine usable;
    // smaller machines are unaffected (Vitest already uses fewer there).
    maxWorkers: 8,
    // Tests that take well under a second alone (commits fsync on every write)
    // were measured at 5.7-7 s while the other workers saturated the disk, so the
    // default 5 s limit failed them in roughly one full run in five. A genuine
    // hang is still caught, just after 15 s.
    testTimeout: 15_000,
  },
});
