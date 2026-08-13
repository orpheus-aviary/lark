#!/usr/bin/env node
// resources/icon.icns from resources/lark-icon-source.png.
//
// `sips` and `iconutil` ship with macOS, so the scaling half of this needs no
// dependency at all — and the target is macOS-only anyway. The masking half is
// a small PNG codec below, for the reason in the next comment. The generated
// files are gitignored: the 1024px source is the artifact worth tracking.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const RESOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const SOURCE = join(RESOURCES, 'lark-icon-source.png');
const ICONSET = join(RESOURCES, 'icon.iconset');
const MASTER = join(RESOURCES, 'icon.tile.png');
const OUTPUT = join(RESOURCES, 'icon.icns');

/*
 * WHY THE ARTWORK IS NOT SHIPPED AS-IS.
 *
 * `lark-logo-original.png` is the artwork as delivered: a rounded-square tile
 * floating inside a soft grey halo. That halo is OPAQUE, so macOS rendered it
 * as part of the icon — a visible grey ring, and a tile ~12% smaller than
 * every neighbour in the Dock.
 *
 * `lark-icon-source.png` is that artwork with the halo cut away: the tile
 * alone, real transparency around it, occupying 90% of the canvas. It was
 * produced ONCE from the original, and the recipe is here so it can be redone
 * if the art changes:
 *
 *   1. find the tile: the bounding box of SATURATED pixels (alpha cannot see
 *      the halo — it is opaque), then two pixels in on every side, because the
 *      detector fires on the border and the halo's last breath sits just
 *      outside it. Measured: x 63..964, y 47..937 of a 1024 x 1024 canvas.
 *   2. crop to that, pad to square with TRANSPARENT pixels;
 *   3. scale to 90% of a 1024 canvas, centred, transparent margin.
 *
 * Step 2 is why that step is not done with `sips`: sips pads with a colour,
 * and a colour is exactly what must not be there.
 *
 * THAT WAS NOT ENOUGH, and the reason is not in the file — it is in macOS.
 *
 * The system composites an app icon into a standard rounded-square tile. When
 * the icon's alpha does not already read as that tile, it shrinks the artwork
 * and puts it on a DEFAULT LIGHT GREY tile of its own. lark's artwork has vines
 * and flowers along its top edge with transparent gaps between them, so it
 * failed that test and shipped with a grey frame around it; owl's artwork is a
 * solid rounded square inside its border, so it passed and filled the tile.
 *
 * Measured with `NSWorkspace.icon(forFile:)` against 0.2.0: on a 412px system
 * tile, lark had a 50px grey band on every side and owl had none — while both
 * icns files were structurally identical (0 opaque pixels in the outermost
 * ring, 4.3–4.9% transparent margin at every size). Nothing about the file was
 * wrong; the file simply was not a tile.
 *
 * So `buildTile()` below makes one: the artwork fills the canvas edge to edge,
 * a superellipse (n = 5, close to Apple's continuous corner) becomes the alpha,
 * and the gaps between the vines are backed by a colour sampled from the
 * artwork's own edge rather than by whatever the system would have chosen.
 *
 * If the art is ever redrawn as a solid rounded square with no gaps at its
 * edge, this masking step becomes a no-op worth deleting — check by rendering
 * the built bundle through `NSWorkspace.icon(forFile:)` and looking for a grey
 * band. Note that LaunchServices caches icons by CFBundleIdentifier: to compare
 * two icons, give the two copies of the bundle DIFFERENT identifiers, or the
 * second render is just the first one again.
 */

// ─── PNG (8-bit RGBA only, which is what the source is) ───

function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `${SOURCE}: expected 8-bit RGBA, got bit depth ${bitDepth}, colour type ${colorType}`,
    );
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const guess = a + b - c;
        const da = Math.abs(guess - a);
        const db = Math.abs(guess - b);
        const dc = Math.abs(guess - c);
        v += da <= db && da <= dc ? a : db <= dc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none — this is a build artifact, not a download
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── The tile ──────────────────────────────────────────

/** Bounding box of everything that is not fully transparent. */
function contentBox(img) {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Box-sample the content square into a `size`×`size` canvas, edge to edge. */
function fill(img, box, size) {
  const side = Math.max(box.w, box.h);
  const scale = side / size;
  const offX = box.x0 + (box.w - side) / 2;
  const offY = box.y0 + (box.h - side) / 2;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const sy1 = Math.ceil(offY + (y + 1) * scale);
      const sx1 = Math.ceil(offX + (x + 1) * scale);
      for (let sy = Math.floor(offY + y * scale); sy < sy1; sy++) {
        for (let sx = Math.floor(offX + x * scale); sx < sx1; sx++) {
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
          const i = (sy * img.width + sx) * 4;
          const pa = img.data[i + 3];
          // premultiplied, so a transparent pixel's colour cannot bleed in
          r += img.data[i] * pa;
          g += img.data[i + 1] * pa;
          b += img.data[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      if (n === 0) continue;
      const o = (y * size + x) * 4;
      out[o + 3] = Math.round(a / n);
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
    }
  }
  return { width: size, height: size, data: out };
}

/** Median opaque colour of the outer band — what shows through the vines' gaps. */
function edgeColour(img, bandRatio = 0.12) {
  const band = Math.round(img.width * bandRatio);
  const rs = [];
  const gs = [];
  const bs = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const inside = x > band && x < img.width - band && y > band && y < img.height - band;
      if (inside) continue;
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] <= 200) continue;
      rs.push(img.data[i]);
      gs.push(img.data[i + 1]);
      bs.push(img.data[i + 2]);
    }
  }
  const median = (xs) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  return [median(rs), median(gs), median(bs)];
}

/** Superellipse coverage, 4×4 supersampled so the corners are not stair-stepped. */
function tileAlpha(size) {
  const N = 5;
  const r = size / 2;
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = Math.abs((x + (sx + 0.5) / 4 - r) / r);
          const v = Math.abs((y + (sy + 0.5) / 4 - r) / r);
          if (u ** N + v ** N <= 1) hit++;
        }
      }
      mask[y * size + x] = Math.round((hit / 16) * 255);
    }
  }
  return mask;
}

function buildTile(source, size) {
  const art = fill(source, contentBox(source), size);
  const [br, bg, bb] = edgeColour(art);
  const mask = tileAlpha(size);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (mask[i] === 0) continue;
    const a = art.data[o + 3] / 255;
    out[o] = Math.round(art.data[o] * a + br * (1 - a));
    out[o + 1] = Math.round(art.data[o + 1] * a + bg * (1 - a));
    out[o + 2] = Math.round(art.data[o + 2] * a + bb * (1 - a));
    out[o + 3] = mask[i];
  }
  return { image: { width: size, height: size, data: out }, backing: [br, bg, bb] };
}

// ─── Build ─────────────────────────────────────────────

if (!existsSync(SOURCE)) {
  process.stderr.write(`source image not found: ${SOURCE}\n`);
  process.exit(1);
}

const source = decodePng(readFileSync(SOURCE));
const { image: tile, backing } = buildTile(source, 1024);
writeFileSync(MASTER, encodePng(tile));
process.stdout.write(`[icons] tile master 1024px, gaps backed by rgb(${backing.join(',')})\n`);

// The names are a fixed contract: `iconutil` reads them, not a manifest.
const SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [size, name] of SIZES) {
  execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', join(ICONSET, name)], {
    stdio: 'pipe',
  });
}

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', OUTPUT], { stdio: 'inherit' });
rmSync(ICONSET, { recursive: true });
rmSync(MASTER, { force: true });

process.stdout.write(`[icons] wrote ${OUTPUT}\n`);
