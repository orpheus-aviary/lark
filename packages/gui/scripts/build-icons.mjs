#!/usr/bin/env node
// resources/icon.icns from resources/lark-logo-original.png.
//
// `sips` and `iconutil` ship with macOS, so this needs no dependency at all —
// and the target is macOS-only anyway. The generated files are gitignored: the
// 1024px source is the artifact worth tracking.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const SOURCE = join(RESOURCES, 'lark-icon-source.png');
const ICONSET = join(RESOURCES, 'icon.iconset');
const OUTPUT = join(RESOURCES, 'icon.icns');

/*
 * WHY THERE ARE TWO PNGs HERE.
 *
 * `lark-logo-original.png` is the artwork as delivered: a rounded-square tile
 * floating inside a soft grey halo. That halo is OPAQUE, so macOS renders it
 * as part of the icon — the tile came out ~12% smaller than every neighbour in
 * the Dock, with a visible grey ring around it.
 *
 * `lark-icon-source.png` is what an icon is supposed to look like: the tile
 * alone, with real transparency around it, occupying 90% of the canvas — the
 * same proportions owl's artwork already had. It was produced ONCE from the
 * original, and the recipe is here so it can be redone if the art changes:
 *
 *   1. find the tile: the bounding box of SATURATED pixels (alpha cannot see
 *      the halo — it is opaque), then two pixels in on every side, because the
 *      detector fires on the border and the halo's last breath sits just
 *      outside it. Measured: x 63..964, y 47..937 of a 1024 x 1024 canvas.
 *   2. crop to that, pad to square with TRANSPARENT pixels;
 *   3. scale to 90% of a 1024 canvas, centred, transparent margin.
 *
 * Step 2 is why this is not done here with `sips`: sips pads with a colour,
 * and a colour is exactly what must not be there.
 */

if (!existsSync(SOURCE)) {
  process.stderr.write(`source image not found: ${SOURCE}\n`);
  process.exit(1);
}

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
  execFileSync('sips', ['-z', String(size), String(size), SOURCE, '--out', join(ICONSET, name)], {
    stdio: 'pipe',
  });
}

execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', OUTPUT], { stdio: 'inherit' });
rmSync(ICONSET, { recursive: true });

process.stdout.write(`[icons] wrote ${OUTPUT}\n`);
