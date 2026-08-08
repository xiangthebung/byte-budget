/**
 * Minimal deterministic ZIP writer.
 *
 * Node already ships deflate and a store-format zip is a few dozen lines, so
 * there is no dependency and nothing shells out to a `zip` binary that a stock
 * Windows machine does not have.
 *
 * Every entry gets a fixed 1980-01-01 timestamp, so building the same source
 * twice produces a byte-identical archive and two releases can be diffed.
 *
 * Started as a copy of the writer in grt-bus-time — the same problem with the same
 * answer, and a second implementation would have been a second thing to get wrong.
 * It has since diverged: the header fields below now describe UTF-8 names and a
 * Unix host, and verification is done with an independent CRC. Changes belong here
 * rather than upstream-and-back.
 */
import zlib, { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 1980-01-01 00:00:00 in DOS date/time form. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * General-purpose bit 11: "the name and comment are UTF-8".
 *
 * The names are written as UTF-8 either way, so without this bit an unzip is
 * entitled to decode them as CP437 — and several do. Today every file in the build
 * is ASCII, where the two encodings agree, so this costs nothing and buys the day a
 * Vite asset hash sits next to a non-ASCII source filename. The alternative, an
 * archive whose bytes and whose declaration disagree, is the kind of thing that
 * works everywhere it is tested and breaks on one reviewer's machine.
 */
const FLAG_UTF8 = 0x0800;

/**
 * "Version made by": host 3 (Unix) in the high byte, spec 2.0 in the low byte.
 *
 * The high byte is what decides whether the top 16 bits of the external attributes
 * are read as a Unix mode at all. This used to say host 0 (MS-DOS) while writing
 * `0o644` up there, so the mode was silently discarded and the "regular file"
 * comment described an intention rather than the archive.
 */
const MADE_BY_UNIX = (3 << 8) | 20;

/**
 * External attributes: a regular file (`S_IFREG`) with mode 0644.
 *
 * The file-type bits matter as much as the permission bits — a Unix-host entry with
 * mode 0644 and no type is a file of type 0, which extractors are free to treat as
 * anything. `>>> 0` because the shift lands above 2^31 and `writeUInt32LE` rejects
 * the negative that a signed shift produces.
 */
const EXTERNAL_REGULAR_0644 = (0o100644 << 16) >>> 0;

/**
 * @param {Array<{ name: string, data: Buffer }>} files
 *   `name` uses forward slashes and is relative to the archive root.
 * @returns {Buffer}
 */
export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Tiny or incompressible entries can grow when deflated; store those.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    // Sizes are known up front, so no data-descriptor bit; only the UTF-8 name bit.
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    // Version made by; its high byte is what makes the external attributes a Unix mode.
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6); // version needed
    // Must match the local header exactly; verifyZip checks that it does.
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(EXTERNAL_REGULAR_0644, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/**
 * Node's own CRC-32, and the only one allowed on the verification side.
 *
 * It landed in Node 22.2. Before it existed, `verifyZip` recomputed checksums with
 * the same hand-rolled `crc32` that had written them, which meant the two agreed by
 * construction: a systematically wrong CRC verified perfectly. That is not a check,
 * it is a mirror. If the oracle is missing, verification refuses rather than quietly
 * falling back to the writer's own function and restoring the mirror.
 *
 * Read off the default export rather than imported by name so that an older Node
 * fails at the `verifyZip` call with the message below, instead of dying at module
 * link time with "does not provide an export named 'crc32'".
 */
const referenceCrc32 = zlib.crc32;

/**
 * Read an archive back and verify it, entry by entry.
 *
 * A hand-rolled zip writer is exactly the kind of code that appears to work
 * while producing something the Web Store rejects. So packaging parses its own
 * output through the central directory, inflates every entry and checks each CRC
 * against the stored one — with Node's CRC, not the one that wrote it. A malformed
 * archive fails here instead of at upload.
 *
 * @param {Buffer} archive
 * @returns {Array<{ name: string, size: number }>}
 */
export function verifyZip(archive) {
  if (typeof referenceCrc32 !== 'function') {
    throw new Error(
      'zip: node:zlib has no crc32 (Node 22.2+ required). Refusing to verify an ' +
        'archive with the same function that wrote it.',
    );
  }

  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error('zip: no end-of-central-directory record');

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const directorySize = archive.readUInt32LE(eocdOffset + 12);
  const directoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (directoryOffset + directorySize > archive.length) {
    throw new Error('zip: central directory runs past the end of the file');
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central directory header for entry ${index}`);
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip: bad local header for ${name}`);
    }

    // The two headers describe the same entry twice, and an unzip may believe
    // either. Setting a flag or a method in one and not the other is the mistake
    // this format invites, and it produces an archive that most tools open and one
    // rejects — so the disagreement is caught here rather than by a reviewer.
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc) {
      throw new Error(`zip: local and central headers disagree for ${name}`);
    }
    // The names are written as UTF-8 unconditionally, so an entry that does not say
    // so is one an unzip is free to decode as CP437.
    if ((flags & FLAG_UTF8) === 0) {
      throw new Error(`zip: ${name} does not declare its name as UTF-8`);
    }

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = archive.subarray(bodyStart, bodyStart + compressedSize);
    const data = method === METHOD_DEFLATE ? inflateRawSync(body) : body;

    if (data.length !== uncompressedSize) {
      throw new Error(`zip: ${name} inflated to ${data.length}, expected ${uncompressedSize}`);
    }
    if (referenceCrc32(data) !== expectedCrc) {
      throw new Error(`zip: checksum mismatch for ${name}`);
    }

    entries.push({ name, size: uncompressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
