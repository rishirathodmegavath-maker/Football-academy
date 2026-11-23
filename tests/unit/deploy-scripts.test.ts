// Runs the release and rollback script tests (deploy/tests/test-release.sh)
// against stubbed systemctl, curl and node. They need POSIX symlinks and bash,
// so they run on Linux (CI) and are skipped on Windows, where the same script
// was run inside WSL (see docs/PHASE2_REPORT.md).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe.skipIf(process.platform === "win32")(
  "release and rollback scripts",
  () => {
    it("pass every case of deploy/tests/test-release.sh", () => {
      const result = spawnSync(
        "bash",
        [join(process.cwd(), "deploy/tests/test-release.sh")],
        { encoding: "utf8" },
      );
      expect(result.stdout, result.stderr).toContain("ALL PASSED");
      expect(result.stdout).not.toContain("FAIL -");
      expect(result.status).toBe(0);
    }, 120_000);
  },
);
