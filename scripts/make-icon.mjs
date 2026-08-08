/**
 * Renders public/icon.png from the same shapes as public/icon.svg.
 *
 *   node scripts/make-icon.mjs
 *
 * Chrome needs a raster icon and there is no image library here, so the artwork is
 * rasterised directly: a rounded square is the Minkowski sum of a rectangle and a
 * disc, which makes "is this point inside" four lines of arithmetic, and a 4x4
 * supersample per pixel is enough antialiasing at these sizes. PNG itself is a
 * signature, three chunks and a zlib stream, and `node:zlib` supplies the only
 * hard part.
 *
 * Committed output, run by hand. It has no inputs that change.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { crc32 } from './crc32.mjs';

const SIZE = 128;
const SAMPLES = 4;

/** Background: a vertical ramp, so the tile does not read as flat at 128px. */
const BG_TOP = [0x12, 0x7c, 0x72];
const BG_BOTTOM = [0x0a, 0x51, 0x4b];

/**
 * Three ascending bars. The tallest is the accent colour, which is what makes the
 * shape read as a rising chart rather than as three tally marks at 16px.
 */
const BARS = [
  { x: 26, height: 34, color: [0xd3, 0xee, 0xe9] },
  { x: 54, height: 56, color: [0xe9, 0xf7, 0xf4] },
  { x: 82, height: 78, color: [0x62, 0xd6, 0xc4] },
];
const BAR_WIDTH = 20;
const BAR_BASE = 104;
const BAR_RADIUS = 4;
const TILE_RADIUS = 28;

/** Inside a rounded rectangle: distance to the inner rectangle is at most `r`. */
function insideRoundRect(px, py, x, y, w, h, r) {
  const qx = Math.min(Math.max(px, x + r), x + w - r);
  const qy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - qx;
  const dy = py - qy;
  return dx * dx + dy * dy <= r * r;
}

function mix(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/** RGBA scanlines, each prefixed with PNG filter type 0. */
function render() {
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);
  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < SIZE; x++) {
      let tileHits = 0;
      let barHits = 0;
      let barColor = null;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          if (!insideRoundRect(px, py, 0, 0, SIZE, SIZE, TILE_RADIUS)) continue;
          tileHits++;
          for (const bar of BARS) {
            const top = BAR_BASE - bar.height;
            if (insideRoundRect(px, py, bar.x, top, BAR_WIDTH, bar.height, BAR_RADIUS)) {
              barHits++;
              barColor = bar.color;
              break;
            }
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const alpha = Math.round((tileHits / total) * 255);
      const background = mix(BG_TOP, BG_BOTTOM, y / (SIZE - 1));
      const barShare = tileHits > 0 ? barHits / tileHits : 0;
      const colour = barColor ? mix(background, barColor, barShare) : background;

      const index = y * stride + 1 + x * 4;
      raw[index] = colour[0];
      raw[index + 1] = colour[1];
      raw[index + 2] = colour[2];
      raw[index + 3] = alpha;
    }
  }
  return raw;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

function png(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'icon.png');
const bytes = png(render());

// Read the signature back rather than trusting the writer: a JPEG with a .png
// name is a real failure mode in this workspace, and the Web Store rejects it.
if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  throw new Error('make-icon: output is not a PNG');
}

await writeFile(target, bytes);
console.log(`wrote public/icon.png (${SIZE}x${SIZE}, ${(bytes.length / 1024).toFixed(1)} kB)`);
