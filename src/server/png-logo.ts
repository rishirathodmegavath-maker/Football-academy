import "server-only";
import { crc32, inflateSync } from "node:zlib";

const PREFIX = "data:image/png;base64,";
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Samples per pixel for each PNG colour type.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_SIDE = 4096;

/**
 * True when `dataUrl` is a PNG that a decoder will accept: the signature, a
 * well-formed IHDR, every chunk's checksum, an IEND, and image data that
 * inflates to exactly the size the header promises. The schema only checks the
 * data URL's prefix and size, so without this a file that merely starts like a
 * PNG is stored and then breaks the PDF renderer (pdf-lib throws on it) the next
 * time an invoice, receipt or report snapshots the logo.
 */
export function isDecodablePng(dataUrl: string): boolean {
  if (!dataUrl.startsWith(PREFIX)) return false;
  const bytes = Buffer.from(dataUrl.slice(PREFIX.length), "base64");
  if (bytes.length < SIGNATURE.length + 25) return false;
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return false;
  let offset = 8,
    header:
      | {
          width: number;
          height: number;
          depth: number;
          type: number;
          interlace: number;
        }
      | undefined,
    palette = false,
    ended = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length && !ended) {
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString("latin1", offset + 4, offset + 8),
      end = offset + 8 + length;
    if (end + 4 > bytes.length) return false;
    const body = bytes.subarray(offset + 8, end);
    if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end))
      return false;
    if (!header) {
      if (type !== "IHDR" || length !== 13) return false;
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        type: body[9],
        interlace: body[12],
      };
      if (
        !header.width ||
        !header.height ||
        header.width > MAX_SIDE ||
        header.height > MAX_SIDE ||
        !(header.type in CHANNELS) ||
        ![1, 2, 4, 8, 16].includes(header.depth) ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        ![0, 1].includes(header.interlace)
      )
        return false;
    } else if (type === "IDAT") data.push(body);
    else if (type === "PLTE") palette = true;
    else if (type === "IEND") ended = length === 0;
    offset = end + 4;
  }
  if (!header || !ended || !data.length) return false;
  if (header.type === 3 && !palette) return false;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return false;
  }
  if (header.interlace === 1) return raw.length > 0;
  const rowBytes = Math.ceil(
    (header.width * CHANNELS[header.type] * header.depth) / 8,
  );
  return raw.length === header.height * (1 + rowBytes);
}
