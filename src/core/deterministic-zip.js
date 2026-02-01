import { createHash } from "node:crypto";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertUint8Array(value, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
}

function dosTimeDateFromDate(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) throw new TypeError("mtime must be a valid Date");
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();

  // DOS date starts at 1980.
  const y = Math.max(1980, Math.min(2107, year)) - 1980;
  const dosDate = (y << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | Math.floor(seconds / 2);
  return { dosTime, dosDate };
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = crc32Table();

function crc32(bytes) {
  assertUint8Array(bytes, "bytes");
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function concatBuffers(buffers) {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const b of buffers) {
    b.copy(out, off);
    off += b.length;
  }
  return out;
}

export function sha256HexBytes(bytes) {
  assertUint8Array(bytes, "bytes");
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * Deterministic ZIP (STORE only).
 * - Sorted entries
 * - Fixed mtime
 * - UTF-8 names
 * - No compression (STORE) to avoid environment/library drift
 */
export function buildDeterministicZipStore({ files, mtime } = {}) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map(name -> Uint8Array)");
  const { dosTime, dosDate } = dosTimeDateFromDate(mtime ?? new Date("2000-01-01T00:00:00.000Z"));

  const entries = Array.from(files.entries())
    .map(([name, bytes]) => ({ name: String(name), bytes }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    assertNonEmptyString(entry.name, "zip entry name");
    assertUint8Array(entry.bytes, `zip entry ${entry.name} bytes`);
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.bytes);
    const crc = crc32(entry.bytes);
    const size = data.length;
    const flags = 0x0800; // UTF-8
    const method = 0; // STORE

    // Local file header
    const localHeader = concatBuffers([
      u32(0x04034b50),
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0) // extra len
    ]);
    localParts.push(localHeader, nameBytes, data);

    // Central directory header
    const centralHeader = concatBuffers([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra len
      u16(0), // comment len
      u16(0), // disk start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + size;
  }

  const centralDir = concatBuffers(centralParts);
  const centralOffset = offset;
  const centralSize = centralDir.length;
  offset += centralSize;

  // End of central directory record
  const eocd = concatBuffers([
    u32(0x06054b50),
    u16(0), // disk
    u16(0), // disk start
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralOffset),
    u16(0) // comment len
  ]);

  const zip = concatBuffers([...localParts, centralDir, eocd]);
  return new Uint8Array(zip);
}

