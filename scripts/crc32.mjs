/**
 * CRC-32 (IEEE 802.3), used by the ZIP *writer* — and only by the writer.
 *
 * Node 22.2 ships `zlib.crc32`, so this is no longer here because there was no
 * alternative. It is here so that there are two implementations. `verifyZip`
 * checks the archive with Node's, this one puts the numbers in; the two agreeing
 * is evidence. When both sides were this function the check was a tautology — a
 * table typo or a missing final inversion produced an archive that verified
 * perfectly and that every real unzip then rejected, which is a failure that only
 * shows up at Web Store upload.
 *
 * Do not "simplify" by pointing `verifyZip` at this function, and do not use this
 * one on the verification side. The independence is the whole point.
 */

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Uint8Array} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
