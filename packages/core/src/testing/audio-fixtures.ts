// The checked-in containers, and where they are (0.3.0 T4).
//
// Unit tests build their own input wherever they can — `toneWav()` writes a
// WAV with 44 bytes of header and a sine, so nothing depends on the build
// under test being able to produce its own fixture. Two things cannot work
// that way, and both are here:
//
//   - the one-time mp3 → m4a migration reads mp3, and since T1b this repo has
//     no encoder that makes one;
//   - the import matrix accepts ALAC, ADTS, FLAC, Vorbis and Opus, and the
//     vendored profile decodes all five while encoding none of them.
//
// So those inputs are tracked bytes with a recipe and a sha256 recorded in
// `scripts/fixtures/README.md`, produced once by a full ffmpeg. The build
// under test is then asked to do only what it ships to do: read them.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every tracked fixture, spelled as its filename.
 *
 * A union rather than a string so a typo is a type error: a missing fixture
 * would otherwise surface as ffprobe complaining about a path, several layers
 * from the test that asked for it.
 */
export type AudioFixture =
  /** 1s AAC in MP4 — canonical audio, the copy branch. */
  | 'tone-1s.m4a'
  /** 1s MP3, exactly what 0.2.x wrote into `songs/<id>/song.mp3`. */
  | 'tone-1s.mp3'
  /** 1s ALAC in MP4: MP4 family, but lossless — has to be re-encoded. */
  | 'tone-1s-alac.m4a'
  /** 1s AAC in a raw ADTS stream: the `aac_adtstoasc` branch. */
  | 'tone-1s.aac'
  /** 1s FLAC. */
  | 'tone-1s.flac'
  /** 1s Vorbis in Ogg, STEREO (the native encoder refuses mono). */
  | 'tone-1s.ogg'
  /** 1s Opus in Ogg, 48kHz (Opus has no other rate). */
  | 'tone-1s.opus'
  /** 1s AAC in MP4 plus cover art — an attached_pic is not a video. */
  | 'tone-1s-cover.m4a'
  /** Two AAC tracks, 1s then 2s: the second is longer so tests can tell. */
  | 'tone-two-tracks.m4a'
  /** H.264 + AAC. A real video track, and its audio is NOT stream 0. */
  | 'tone-1s-video.mp4'
  /** An MP4 carrying nothing but cover art: no audio at all. */
  | 'cover-only.m4a';

/**
 * The checkout's own ffmpeg build, if `just fetch-ffmpeg` has produced one.
 *
 * Pass it as `LARK_MEDIA_TOOLS_DIR` to `resolveMediaTools()` in any suite whose
 * subject is WHAT THE SHIPPED BUILD CAN DO — the import matrix asserts that a
 * profile with no external libraries still decodes ALAC and Vorbis, and left
 * to itself the resolver prefers Homebrew's full ffmpeg, which would pass that
 * claim on a developer's machine and ship it broken.
 *
 * `null` when the directory is absent: the binaries are not tracked, so a
 * fresh checkout has none until the recipe runs.
 */
export function vendoredToolsDir(): string | null {
  const dir = join(repoRoot(), 'vendor', 'ffmpeg');
  return existsSync(join(dir, 'ffmpeg')) && existsSync(join(dir, 'ffprobe')) ? dir : null;
}

/** Absolute path to a tracked fixture. Dev checkout only, by design. */
export function fixturePath(name: AudioFixture): string {
  return join(repoRoot(), 'scripts', 'fixtures', name);
}

/** A tracked fixture's bytes. */
export async function readFixture(name: AudioFixture): Promise<Buffer> {
  return readFile(fixturePath(name));
}

export function repoRoot(): string {
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
    'no pnpm-workspace.yaml above this module — the audio fixtures only exist in a dev checkout',
  );
}
