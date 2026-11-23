// Phase 5: the academy logo must be a PNG a decoder accepts. Before, any string
// that began like a PNG was stored, and the next invoice, receipt or report
// snapshotted it and made the PDF renderer throw.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
vi.hoisted(() => {
  process.env.SPORTOZEN_WRITE_LIMIT_PER_MINUTE = "100000";
});
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => import("./helpers/mock-auth"));
import { database } from "@/server/database";
import { isDecodablePng } from "@/server/png-logo";
import * as workspaceRoute from "@/app/api/workspaces/[academyId]/route";
import { A, callRoute, seedApiFixture } from "./helpers/api-harness";

const filename = join(tmpdir(), `sportozen-logo-${randomUUID()}.sqlite`);
process.env.SPORTOZEN_DATABASE_PATH = filename;
beforeAll(() => {
  seedApiFixture();
});
afterAll(() => {
  database().close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(filename + suffix, { force: true });
});

const url = (png: Buffer) => "data:image/png;base64," + png.toString("base64");
function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const checked = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(checked));
  return Buffer.concat([head, checked, sum]);
}
/** A small valid PNG of the given shape, built from first principles. */
function png(
  width: number,
  height: number,
  { type = 6, depth = 8 }: { type?: number; depth?: number } = {},
) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const raw = Buffer.alloc(height * (1 + rowBytes), 0x7f);
  for (let y = 0; y < height; y++) raw[y * (1 + rowBytes)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = type;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(type === 3
      ? [chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]))]
      : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("isDecodablePng", () => {
  it("accepts every real PNG shipped with the application that a logo could be", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".png") && statSync(path).size <= 200_000)
          files.push(path);
      }
    };
    walk(join(process.cwd(), "public"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files)
      expect(isDecodablePng(url(readFileSync(file))), file).toBe(true);
  });
  it("accepts every colour type and bit depth a PNG can have", () => {
    for (const [type, depths] of [
      [0, [1, 2, 4, 8, 16]],
      [2, [8, 16]],
      [3, [1, 2, 4, 8]],
      [4, [8, 16]],
      [6, [8, 16]],
    ] as const)
      for (const depth of depths)
        expect(
          isDecodablePng(url(png(13, 9, { type, depth }))),
          `${type}/${depth}`,
        ).toBe(true);
  });
  it("refuses what only looks like a PNG", () => {
    const good = png(8, 8);
    const garbage =
      "data:image/png;base64,iVBORw0KGgo" +
      Buffer.from("this is not a real png at all, just padding bytes").toString(
        "base64",
      );
    expect(isDecodablePng(garbage)).toBe(false);
    expect(isDecodablePng("data:image/png;base64,")).toBe(false);
    expect(
      isDecodablePng("data:image/jpeg;base64," + good.toString("base64")),
    ).toBe(false);
    expect(isDecodablePng(good.toString("base64"))).toBe(false);
    // Truncated anywhere: inside a chunk, before IEND.
    for (const cut of [10, 24, 40, good.length - 13, good.length - 1])
      expect(isDecodablePng(url(good.subarray(0, cut))), `cut ${cut}`).toBe(
        false,
      );
    // A flipped byte in the image data fails its checksum.
    const damaged = Buffer.from(good);
    damaged[damaged.length - 20] ^= 0xff;
    expect(isDecodablePng(url(damaged))).toBe(false);
    // Only a chunk's checksum is wrong while all the data is intact: the file
    // is damaged and must still be refused (IHDR's checksum is bytes 29-32).
    const badChecksum = Buffer.from(good);
    badChecksum[32] ^= 0x01;
    expect(isDecodablePng(url(badChecksum))).toBe(false);
    // Missing IEND, and trailing bytes cannot stand in for it.
    expect(isDecodablePng(url(good.subarray(0, good.length - 12)))).toBe(false);
  });
  it("refuses a header that lies about the image", () => {
    expect(isDecodablePng(url(png(0, 8)))).toBe(false);
    expect(isDecodablePng(url(png(8, 0)))).toBe(false);
    expect(isDecodablePng(url(png(4097, 1)))).toBe(false);
    // The data inflates, and its checksum is right, but it is not 8x8 RGBA.
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(8, 4);
    header[8] = 8;
    header[9] = 6;
    const wrongSize = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc(50, 1))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(isDecodablePng(url(wrongSize))).toBe(false);
    // Palette image without a palette; image data that is not a zlib stream.
    const noPalette = Buffer.from(png(8, 8, { type: 3 }));
    expect(isDecodablePng(url(noPalette))).toBe(true);
    const bad = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", Buffer.from("not zlib")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(isDecodablePng(url(bad))).toBe(false);
  });
});

describe("saving the academy configuration", () => {
  const current = () =>
    JSON.parse(
      String(
        database()
          .prepare("SELECT config FROM academy_workspaces WHERE id=?")
          .get(A)!.config,
      ),
    ) as Record<string, unknown>;
  const save = (logoData: string) => {
    const academy = current();
    return callRoute(workspaceRoute.PATCH, {
      path: `/api/workspaces/${A}`,
      method: "PATCH",
      as: "ownerA",
      params: { academyId: A },
      json: {
        ...academy,
        logoData,
        expectedVersion: Number(academy.configVersion ?? 0),
      },
    });
  };
  it("stores a real logo, keeps it when unchanged, and refuses a file that only looks like a PNG", async () => {
    const real = url(
      readFileSync(join(process.cwd(), "public/portal/sportozen-mark.png")),
    );
    const first = await save(real);
    expect(first.status).toBe(200);
    expect(current().logoData).toBe(real);
    const version = current().configVersion;
    const garbage =
      "data:image/png;base64,iVBORw0KGgo" +
      Buffer.from("this is not a real png at all, just padding bytes").toString(
        "base64",
      );
    const refused = await save(garbage);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/not a valid PNG/);
    // Nothing was saved: same logo, same version.
    expect(current().logoData).toBe(real);
    expect(current().configVersion).toBe(version);
    // Saving other settings with the stored logo unchanged is never blocked by the logo check.
    expect((await save(real)).status).toBe(200);
    // Removing the logo is allowed.
    expect((await save("")).status).toBe(200);
    expect(current().logoData || "").toBe("");
  });
});
