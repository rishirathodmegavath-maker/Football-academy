// DL-002: a drill's coaching content cannot change without a new contentVersion.
// A recorded manifest holds, for every catalogue drill, its content version and
// a hash of everything a coach reads. A release that edits a drill fails here
// until the drill's contentVersion is raised and the manifest is regenerated:
//
//   UPDATE_DRILL_MANIFEST=1 npx vitest run tests/unit/drill-content-lock.test.ts
//
// Sessions keep their own complete snapshot, so the version is a label for the
// catalogue release, not what makes history readable; this test keeps that
// label honest.
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("server-only", () => ({}));
import { UNIVERSAL_CATALOGUE } from "@/config/drills";

const manifestPath = join(process.cwd(), "tests/unit/helpers/drill-content-manifest.json");
type Manifest = Record<string, { version: number; hash: string }>;
const hashOf = (d: (typeof UNIVERSAL_CATALOGUE)[number]) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        number: d.number,
        categoryId: d.categoryId,
        name: d.name,
        originalObjective: d.originalObjective,
        focusArea: d.focusArea,
        purpose: d.purpose,
        cue: d.cue,
        summary: d.summary,
        status: d.status,
        minimumAge: d.minimumAge ?? null,
        interpretation: d.interpretation ?? null,
        content: d.content,
      }),
    )
    .digest("hex");
const current: Manifest = Object.fromEntries(
  UNIVERSAL_CATALOGUE.map((d) => [d.id, { version: d.contentVersion, hash: hashOf(d) }]),
);

describe("catalogue content is locked to its version", () => {
  if (process.env.UPDATE_DRILL_MANIFEST === "1") {
    it("regenerates the manifest, refusing a change that kept its version", () => {
      const previous: Manifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : {};
      for (const [id, now] of Object.entries(current)) {
        const before = previous[id];
        if (before && before.hash !== now.hash)
          expect(now.version, `${id} changed without a higher contentVersion`).toBeGreaterThan(before.version);
      }
      writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
    });
    return;
  }
  it("has a manifest entry for every drill and no extra", () => {
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(current).sort());
  });
  it("no drill's content differs from the recorded version", () => {
    const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const changed = Object.entries(current)
      .filter(([id, now]) => manifest[id].hash !== now.hash || manifest[id].version !== now.version)
      .map(([id, now]) =>
        manifest[id].hash !== now.hash && manifest[id].version === now.version
          ? `${id}: content changed but contentVersion is still ${now.version}`
          : `${id}: version or content differs from the manifest (regenerate it)`,
      );
    expect(changed, changed.join("; ")).toEqual([]);
  });
  it("the check itself notices an edit", () => {
    const drill = structuredClone(UNIVERSAL_CATALOGUE[0]);
    drill.content.steps = [...drill.content.steps, "An unrecorded extra step."];
    expect(hashOf(drill)).not.toBe(current[drill.id].hash);
  });
});
