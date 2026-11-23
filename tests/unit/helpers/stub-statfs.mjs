// Test-only preload for spawned ops CLIs (ops.test.ts). The disk check reads the
// host's real free space; a nearly full test machine would add an alert the
// fixture does not expect and, because only three alerts are sent per run,
// defer one of the others. This reports a healthy, fixed disk so the CLI tests
// depend on what they set up and not on the machine they run on. The disk
// thresholds themselves are tested with injected values in ops.test.ts.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.statfsSync = () => ({ bavail: 80, blocks: 100, files: 1000, ffree: 900 });
syncBuiltinESMExports();
