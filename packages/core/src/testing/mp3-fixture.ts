// A real mp3, and four ways to break one (0.3.0 T2).
//
// Every other audio fixture in this repo is written by `toneWav()` — 44 bytes
// of header and a sine — precisely so no test depends on the build under test
// being able to produce its own input. The migration cannot work that way:
// its input is an mp3, and since T1b removed LAME there is no encoder in this
// repo that can make one. The only honest source is the tracked
// `scripts/fixtures/tone-1s.mp3`, which was generated in T0a for exactly this
// (it carries the parameters 0.2.x wrote into `songs/<id>/song.mp3`).
//
// The damaged variants are derived from it here rather than checked in: the
// recipes are three lines each, they are deterministic against a byte-frozen
// fixture, and reading them beats reading four more opaque blobs.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ways an mp3 in a real library goes bad, named for what the TOOLS see rather
 * than for the byte surgery — the byte surgery is an implementation detail of
 * reaching each of those states.
 */
export type Mp3Damage =
  /** ffprobe refuses it outright: one frame is not two consecutive frames. */
  | 'unreadable'
  /** Probes fine (the Xing header still claims 1s), converts short. */
  | 'truncated'
  /** Probes fine, decodes with errors, converts short. */
  | 'scrambled'
  /** Not audio at all — an html error page saved under the wrong name. */
  | 'junk'
  /** Zero bytes: an interrupted write from a much older lark. */
  | 'empty';

/** The tracked fixture's own bytes: 1s, 192kbps, 44.1kHz, 25748 bytes. */
export async function readToneMp3(): Promise<Buffer> {
  return readFile(toneMp3Path());
}

/** Absolute path to the tracked fixture. Dev checkout only, by design. */
export function toneMp3Path(): string {
  return join(repoRoot(), 'scripts', 'fixtures', 'tone-1s.mp3');
}

/**
 * Damage a copy of the fixture's bytes.
 *
 * The offsets are absolute because the fixture is byte-frozen (its sha256 is
 * recorded in `scripts/fixtures/README.md`): at 192kbps/44.1kHz an mp3 frame
 * is 626 bytes, so 1000 bytes is one complete frame plus a fragment — which is
 * what "two consecutive frames" fails on.
 */
export function damageMp3(source: Buffer, damage: Mp3Damage): Buffer {
  switch (damage) {
    case 'unreadable':
      return Buffer.from(source.subarray(0, 1000));
    case 'truncated':
      return Buffer.from(source.subarray(0, 12_000));
    case 'scrambled': {
      const copy = Buffer.from(source);
      copy.fill(0xff, 2000, 20_000);
      return copy;
    }
    case 'junk':
      return Buffer.from('<html><body>404 Not Found</body></html>', 'utf8');
    case 'empty':
      return Buffer.alloc(0);
  }
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walks from either the TS source or the emitted dist copy, so the same
  // helper works under vitest and under a built daemon's test run.
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'no pnpm-workspace.yaml above this module — the mp3 fixture only exists in a dev checkout',
  );
}
