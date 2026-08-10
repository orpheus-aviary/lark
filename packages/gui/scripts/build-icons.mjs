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
const SOURCE = join(RESOURCES, 'lark-logo-original.png');
const ICONSET = join(RESOURCES, 'icon.iconset');
const OUTPUT = join(RESOURCES, 'icon.icns');

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
