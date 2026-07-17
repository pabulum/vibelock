// Valve KV3 for the in-game build export: a *binary v5* ("\x053VK") reader and a *text* writer —
// the two halves `injectBuildIntoCache` needs to read `cached_hero_builds.kv3` and re-emit it with
// a build appended. A TS port of the pure-Python `keyvalues3` (0.7) reader we previously ran under
// Pyodide; kv3.test.ts pins both halves byte-for-byte against that implementation's output on a
// real cache file.
//
// Scope: v5 only (the only version Deadlock writes for this file; older magics get a clear error),
// LZ4 or uncompressed (v5's method 2, zstd, would need a real dependency — the game uses LZ4).
//
// Format notes (mirroring keyvalues3's binaryreader):
//  - After a 68-byte header come two independently LZ4-compressed regions. Region 0 carries the
//    string table plus one set of value buffers; region 1 carries the object-member-count table,
//    a second set of value buffers, the per-value type stream, and the binary-blob size table.
//  - Each region splits into byte/short/int/double buffers (sizes from the header, each aligned to
//    its element size); values are read from the buffer matching their width, not in stream order.
//  - Binary blobs live in a third region: an LZ4 *chain* (frames share a sliding dictionary
//    window, so they must be decoded into one contiguous buffer) holding all blobs concatenated,
//    split by the size table. 0xFFEEDD00 sentinels guard the blob table and the chain's end.

// ---- Value model ----

/** A parsed KV3 double. Kept distinct from `number` (which models KV3's integer types) because the
 * text writer must print doubles with a decimal point (`1.0`) the way Python's `str()` does —
 * collapsing both into `number` would lose that. */
export class Kv3Double {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** A value carrying a KV3 specifier flag (`resource:`, `soundevent:`, …). Never seen in
 * `cached_hero_builds.kv3`, but the type stream can encode it, so we keep it representable. */
export class Kv3Flagged {
  readonly flag: string;
  readonly value: Kv3Value;
  constructor(flag: string, value: Kv3Value) {
    this.flag = flag;
    this.value = value;
  }
}

/** Objects are Maps, not plain records: KV3 members are ordered and may have numeric-string names
 * (an unnamed member serializes as its index), which plain JS objects would silently reorder. */
export type Kv3Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Kv3Double
  | Kv3Flagged
  | Uint8Array
  | Kv3Value[]
  | Map<string, Kv3Value>;

// ---- LZ4 block decoding ----

/**
 * Decode one LZ4 block into `out` starting at `outPos`, returning the new write position. Matches
 * may reference bytes before `outPos` (already-decoded output acts as the dictionary — that's what
 * makes the blob chain's shared window work "for free" when every frame decodes into one buffer).
 * Hand-rolled because the block format is ~30 lines and no dependency-free browser lib ships it.
 */
export function lz4BlockDecode(
  src: Uint8Array,
  out: Uint8Array,
  outPos: number,
  maxLen: number,
): number {
  const outLimit = outPos + maxLen;
  let s = 0;
  let d = outPos;
  while (s < src.length) {
    const token = src[s++];
    // Literal run: length in the high nibble, 15 meaning "keep adding the next byte(s)".
    let litLen = token >> 4;
    if (litLen === 0xf) {
      let b;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 0xff);
    }
    if (s + litLen > src.length || d + litLen > outLimit)
      throw new Error("Corrupt LZ4 block: literal run out of bounds");
    out.set(src.subarray(s, s + litLen), d);
    s += litLen;
    d += litLen;
    if (s >= src.length) break; // the final sequence is literals-only
    // Match: 2-byte little-endian back-offset, then length (min 4) with the same extension rule.
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d)
      throw new Error("Corrupt LZ4 block: match offset out of range");
    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 0xf) {
      let b;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 0xff);
    }
    if (d + matchLen > outLimit)
      throw new Error("Corrupt LZ4 block: match overruns output");
    // Byte-at-a-time on purpose: offset < matchLen overlaps (that's how LZ4 encodes runs).
    for (let i = 0; i < matchLen; i++) {
      out[d] = out[d - offset];
      d++;
    }
  }
  return d;
}

/** Decode a whole region whose exact decompressed size is known. */
function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  const end = lz4BlockDecode(src, out, 0, decompressedSize);
  if (end !== decompressedSize)
    throw new Error(
      `LZ4 size mismatch: got ${end}, expected ${decompressedSize}`,
    );
  return out;
}

// ---- Little-endian cursor over a Uint8Array ----

class Cursor {
  private view: DataView;
  bytes: Uint8Array;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
  read(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length)
      throw new Error("KV3: read past end of buffer");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  align(to: number): void {
    const pad = (to - (this.pos % to)) % to;
    if (this.pos + pad <= this.bytes.length) this.pos += pad;
  }
  u8 = () => this.view.getUint8(this.pos++);
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  /** NUL-terminated UTF-8 string (the string table's encoding). */
  cString(): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0)
      this.pos++;
    const s = new TextDecoder().decode(this.bytes.subarray(start, this.pos));
    this.pos++; // consume the NUL
    return s;
  }
}

// ---- Binary v5 reader ----

const KV3_MAGICS: Record<string, number> = {
  "4c4b5601": 0, // 'VKV\x03' legacy — listed only to name the version in the error
  "0133564b": 1,
  "0233564b": 2,
  "0333564b": 3,
  "0433564b": 4,
  "0533564b": 5,
};
const SENTINEL = 0xffeedd00;

// keyvalues3's BinaryType enum, same numbering.
const BinType = {
  null: 1,
  boolean: 2,
  int64: 3,
  uint64: 4,
  double: 5,
  string: 6,
  binaryBlob: 7,
  array: 8,
  dictionary: 9,
  arrayTyped: 10,
  int32: 11,
  uint32: 12,
  booleanTrue: 13,
  booleanFalse: 14,
  int64Zero: 15,
  int64One: 16,
  doubleZero: 17,
  doubleOne: 18,
  float: 19,
  int16: 20,
  uint16: 21,
  int8: 22,
  uint8: 23,
  arrayTypedByteLength: 24,
  arrayTypedByteLength2: 25,
} as const;

// Specifier values 1–5 map to text-encoding flag prefixes; the rest carry no flag.
const SPECIFIER_FLAGS: Record<number, string> = {
  1: "resource",
  2: "resource_name",
  3: "panorama",
  4: "soundevent",
  5: "subclass",
};
const MAX_SPECIFIER = 8; // UNSPECIFIED — highest value the type stream may carry (MaxPersistedFlag)

/** One region's width-split value buffers. */
interface Buffers {
  bytes: Cursor;
  shorts: Cursor;
  ints: Cursor;
  doubles: Cursor;
}

/** Split a region into byte/short/int/double buffers, honoring the same alignment rule as the
 * Python reader (align before a segment only when it's non-empty). */
function splitBuffer(
  cur: Cursor,
  byteCount: number,
  shortCount: number,
  intCount: number,
  doubleCount: number,
): Buffers {
  const bytes = new Cursor(cur.read(byteCount));
  if (shortCount) cur.align(2);
  const shorts = new Cursor(cur.read(shortCount * 2));
  if (intCount) cur.align(4);
  const ints = new Cursor(cur.read(intCount * 4));
  if (doubleCount) cur.align(8);
  const doubles = new Cursor(cur.read(doubleCount * 8));
  return { bytes, shorts, ints, doubles };
}

/** An int64/uint64 as a plain number when it's exactly representable, else a bigint — build ids and
 * timestamps stay ergonomic, and huge ids don't silently lose precision. */
function narrow(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v;
}

class V5Reader {
  private active: Buffers;
  private strings: string[];
  private buffer0: Buffers;
  private buffer1: Buffers;
  private types: Cursor;
  private memberCounts: Cursor;
  private blobSizes: number[] | null;
  private blobs: Cursor | null;
  constructor(
    strings: string[],
    buffer0: Buffers,
    buffer1: Buffers,
    types: Cursor,
    memberCounts: Cursor,
    blobSizes: number[] | null,
    blobs: Cursor | null,
  ) {
    this.strings = strings;
    this.buffer0 = buffer0;
    this.buffer1 = buffer1;
    this.types = types;
    this.memberCounts = memberCounts;
    this.blobSizes = blobSizes;
    this.blobs = blobs;
    this.active = buffer1;
  }

  private readType(): { type: number; flag: string | undefined } {
    let t = this.types.u8();
    let flag: string | undefined;
    if (t & 0x80) {
      t &= 0x3f;
      const spec = this.types.u8();
      if (spec > MAX_SPECIFIER)
        throw new Error(`KV3: unexpected specifier ${spec}`);
      flag = SPECIFIER_FLAGS[spec];
    }
    return { type: t, flag };
  }

  readValue(): Kv3Value {
    const { type, flag } = this.readType();
    const v = this.readTyped(type);
    return flag ? new Kv3Flagged(flag, v) : v;
  }

  private readString(): string {
    const id = this.active.ints.i32();
    return id === -1 ? "" : this.strings[id];
  }

  private readBlob(): Uint8Array {
    if (this.blobSizes) {
      const size = this.blobSizes.shift()!;
      if (size === 0) return new Uint8Array(0);
      return this.blobs!.read(size);
    }
    return this.active.bytes.read(this.active.ints.i32());
  }

  private readTypedArray(count: number): Kv3Value[] {
    const b = this.active;
    const { type, flag } = this.readType();
    const out: Kv3Value[] = new Array(count);
    for (let i = 0; i < count; i++) {
      // Zero/one shorthands consume nothing per element, so the loop is uniform.
      const v = this.readTyped(type, b);
      out[i] = flag ? new Kv3Flagged(flag, v) : v;
    }
    return out;
  }

  private readTyped(type: number, b: Buffers = this.active): Kv3Value {
    switch (type) {
      case BinType.null:
        return null;
      case BinType.boolean:
        return b.bytes.u8() === 1;
      case BinType.booleanTrue:
        return true;
      case BinType.booleanFalse:
        return false;
      case BinType.int64:
        return narrow(b.doubles.i64());
      case BinType.uint64:
        return narrow(b.doubles.u64());
      case BinType.int64Zero:
        return 0;
      case BinType.int64One:
        return 1;
      case BinType.double:
        return new Kv3Double(b.doubles.f64());
      case BinType.doubleZero:
        return new Kv3Double(0);
      case BinType.doubleOne:
        return new Kv3Double(1);
      case BinType.float:
        return new Kv3Double(b.ints.f32());
      case BinType.int32:
        return b.ints.i32();
      case BinType.uint32:
        return b.ints.u32();
      case BinType.int16:
        return b.shorts.i16();
      case BinType.uint16:
        return b.shorts.u16();
      case BinType.int8: // the Python reader reads int8 unsigned too; mirror it
      case BinType.uint8:
        return b.bytes.u8();
      case BinType.string:
        return this.readString();
      case BinType.binaryBlob:
        return this.readBlob();
      case BinType.array: {
        const count = this.active.ints.i32();
        const out: Kv3Value[] = new Array(count);
        for (let i = 0; i < count; i++) out[i] = this.readValue();
        return out;
      }
      case BinType.dictionary: {
        const count = this.memberCounts.u32();
        const obj = new Map<string, Kv3Value>();
        for (let i = 0; i < count; i++) {
          const nameId = this.active.ints.i32();
          const name = nameId === -1 ? String(i) : this.strings[nameId];
          obj.set(name, this.readValue());
        }
        return obj;
      }
      case BinType.arrayTyped:
        return this.readTypedArray(this.active.ints.u32());
      case BinType.arrayTypedByteLength:
        return this.readTypedArray(this.active.bytes.u8());
      case BinType.arrayTypedByteLength2: {
        // Short typed arrays store their *elements* in region 0's buffers.
        const count = this.active.bytes.u8();
        this.active = this.buffer0;
        const out = this.readTypedArray(count);
        this.active = this.buffer1;
        return out;
      }
      default:
        throw new Error(`KV3: unsupported value type ${type}`);
    }
  }
}

/** Parse a binary KV3 v5 file (e.g. `cached_hero_builds.kv3`) into a value tree. */
export function parseBinaryKv3(fileBytes: Uint8Array): Kv3Value {
  const cur = new Cursor(fileBytes);
  const magic = [...cur.read(4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const version = KV3_MAGICS[magic];
  if (version === undefined)
    throw new Error("Not a binary KV3 file — is this really the build cache?");
  if (version !== 5)
    throw new Error(
      `Unsupported KV3 version ${version} — expected v5. Launch Deadlock once so it rewrites the cache, then retry.`,
    );

  cur.read(16); // format GUID — not needed, we always re-emit generic text

  const compressionMethod = cur.u32();
  const compressionDictId = cur.u16();
  const compressionFrameSize = cur.u16();

  const byteCount = cur.u32();
  const intCount = cur.u32();
  const doubleCount = cur.u32();

  const typesSize = cur.u32();
  cur.u16(); // object count
  cur.u16(); // array count

  cur.u32(); // total uncompressed size
  const compressedTotalSize = cur.u32();
  const blockCount = cur.u32();
  const blockTotalSize = cur.u32();
  const shortCount = cur.u32();
  const compressedBlockSizeCount = cur.u32() / 2;

  const buffer0DecompressedSize = cur.u32();
  const block0CompressedSize = cur.u32();
  const buffer1DecompressedSize = cur.u32();
  const block1CompressedSize = cur.u32();
  const byteCount2 = cur.u32();
  const shortCount2 = cur.u32();
  const intCount2 = cur.u32();
  const doubleCount2 = cur.u32();
  cur.u32(); // field_54
  const objectCountV5 = cur.u32();
  cur.u32(); // field_5c
  cur.u32(); // field_60

  let region0: Cursor;
  let region1: Cursor;
  if (compressionMethod === 0) {
    if (compressionDictId !== 0 || compressionFrameSize !== 0)
      throw new Error("KV3: malformed uncompressed header");
    region0 = new Cursor(cur.read(buffer0DecompressedSize));
    region1 = new Cursor(cur.read(buffer1DecompressedSize));
  } else if (compressionMethod === 1) {
    if (compressionDictId !== 0 || compressionFrameSize !== 16384)
      throw new Error("KV3: malformed LZ4 header");
    region0 = new Cursor(
      lz4Decompress(cur.read(block0CompressedSize), buffer0DecompressedSize),
    );
    region1 = new Cursor(
      lz4Decompress(cur.read(block1CompressedSize), buffer1DecompressedSize),
    );
  } else {
    // Method 2 is zstd; Deadlock writes this file LZ4-compressed, so we don't carry a zstd decoder.
    throw new Error(`KV3: unsupported compression method ${compressionMethod}`);
  }

  const buffer0 = splitBuffer(
    region0,
    byteCount,
    shortCount,
    intCount,
    doubleCount,
  );
  const stringCount = buffer0.ints.u32();
  const strings: string[] = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) strings[i] = buffer0.bytes.cString();

  const memberCounts = new Cursor(region1.read(objectCountV5 * 4));
  const buffer1 = splitBuffer(
    region1,
    byteCount2,
    shortCount2,
    intCount2,
    doubleCount2,
  );
  const types = new Cursor(region1.read(typesSize));

  let blobSizes: number[] | null = null;
  let blobs: Cursor | null = null;
  if (blockCount > 0) {
    blobSizes = [];
    for (let i = 0; i < blockCount; i++) blobSizes.push(region1.u32());
    if (region1.u32() !== SENTINEL)
      throw new Error("KV3: missing blob-table sentinel");
    const compressedSizes: number[] = [];
    for (let i = 0; i < compressedBlockSizeCount; i++)
      compressedSizes.push(region1.u16());

    let blobData = new Uint8Array(0);
    if (blockTotalSize > 0) {
      if (compressionMethod === 0) {
        const parts = blobSizes.map((size) => cur.read(size));
        blobData = new Uint8Array(blockTotalSize);
        let pos = 0;
        for (const p of parts) {
          blobData.set(p, pos);
          pos += p.length;
        }
      } else {
        // LZ4 chain: each frame's window includes prior frames' output, so decode every frame
        // into one contiguous buffer (see lz4BlockDecode's dictionary note).
        blobData = new Uint8Array(blobSizes.reduce((a, b) => a + b, 0));
        let outPos = 0;
        let frame = 0;
        for (const blockSize of blobSizes) {
          let remaining = blockSize;
          while (remaining > 0 && cur.remaining > 0) {
            const src = cur.read(compressedSizes[frame++]);
            const end = lz4BlockDecode(src, blobData, outPos, remaining);
            remaining -= end - outPos;
            outPos = end;
          }
        }
      }
      if (cur.u32() !== SENTINEL)
        throw new Error("KV3: missing blob-data sentinel");
    }
    blobs = new Cursor(blobData);
  } else {
    if (region1.u32() !== SENTINEL)
      throw new Error("KV3: missing blob-table sentinel");
  }
  void compressedTotalSize;

  return new V5Reader(
    strings,
    buffer0,
    buffer1,
    types,
    memberCounts,
    blobSizes,
    blobs,
  ).readValue();
}

// ---- Text writer ----

const TEXT_HEADER =
  "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} " +
  "format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->";

/** Python's `str(round(v, 6))` for a double: 6-decimal rounding, and integral values keep a
 * trailing `.0`. (Exponent-notation values would render slightly differently than CPython, but the
 * game's caches never contain them.) */
function formatDouble(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

// Python str.isidentifier(), restricted to ASCII — KV3 member names in game files are ASCII.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSameLineScalar(v: Kv3Value): boolean {
  // Mirrors the Python writer's isinstance(item, (int, float)) — which includes bools.
  return (
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "boolean" ||
    v instanceof Kv3Double
  );
}

function serialize(v: Kv3Value, level: number, inDict: boolean): string {
  const indent = "\t".repeat(level);
  const indentNested = "\t".repeat(level + 1);
  if (v instanceof Kv3Flagged) return `${v.flag}:${serialize(v.value, 0, false)}`;
  if (v === null) return "null";
  if (v === false) return "false";
  if (v === true) return "true";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof Kv3Double) return formatDouble(v.value);
  if (typeof v === "string") return `"${v}"`; // KV3 text does not escape quotes; neither does the game
  if (v instanceof Uint8Array)
    return `#[${[...v].map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`;
  if (Array.isArray(v)) {
    if (v.length <= 6 && v.every(isSameLineScalar))
      return `[${v.map((x) => serialize(x, 0, false)).join(", ")}]`;
    let s = `\n${indent}[\n`;
    for (const item of v) s += `${indentNested}${serialize(item, level + 1, false)},\n`;
    return `${s}${indent}]`;
  }
  // Map — a KV3 object.
  let s = `${indent}{\n`;
  if (inDict) s = `\n${s}`;
  for (const [rawKey, value] of v) {
    const key = IDENTIFIER.test(rawKey) ? rawKey : `"${rawKey}"`;
    s += `${indentNested}${key} = ${serialize(value, level + 1, true)}\n`;
  }
  return `${s}${indent}}`;
}

/** Encode a value tree as generic text KV3 (what the game accepts back; it re-saves binary on next
 * launch). Byte-identical to `keyvalues3`'s text writer on these files. */
export function encodeTextKv3(value: Kv3Value): string {
  return `${TEXT_HEADER}\n${serialize(value, 0, false)}\n`;
}
