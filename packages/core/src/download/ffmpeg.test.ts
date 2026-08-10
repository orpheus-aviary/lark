// These run a REAL ffmpeg. A mocked child_process would prove the argument
// list is what we wrote down and nothing about whether ffmpeg accepts it — and
// the arguments are exactly where this can be wrong (a codec name, a flag
// order, an output that is silently not an mp3).
//
// The inputs are WAV files written by hand here, not synthesised with
// `-f lavfi`: the vendored build is a minimal LGPL profile with no lavfi
// demuxer and no AAC encoder (M7 T0), so a test that asked ffmpeg to generate
// its own fixture would only pass against a full system build. A PCM WAV needs
// nothing but a 44-byte header, and it exercises the same argument list.
//
// The container the download pipeline actually receives (bilibili's m4a) is
// covered where it belongs: `just fetch-ffmpeg` and accept-pack run the real
// M4A → MP3 → ffprobe closed loop against a checked-in fixture.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegError } from '../errors.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { toneWav } from '../testing/tone-wav.js';
import { ensureMp3, isMp3Format, probeAudio } from './ffmpeg.js';
import { DEFAULT_TIMEOUTS } from './timeouts.js';

let dir = '';
let tools: ResolvedMediaTools;
/** 1s of tone. */
let shortWav = '';
/**
 * 120s of the same. Transcoding it takes several hundred ms here, which is
 * long enough that a cancellation lands with the child genuinely mid-run — a
 * 1s fixture would finish before the abort and the test would pass without
 * proving anything.
 */
let longWav = '';

beforeAll(async () => {
  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  const probe = await probeCapabilities(outcome.tools);
  if (probe.state !== 'ready') {
    throw new Error(
      `no usable ffmpeg for the test run (${probe.state}): ${probe.detail} — run \`just fetch-ffmpeg\` or \`brew install ffmpeg\``,
    );
  }
  tools = outcome.tools;

  dir = await mkdtemp(join(tmpdir(), 'lark-ffmpeg-'));
  shortWav = join(dir, 'source.wav');
  longWav = join(dir, 'long.wav');
  await writeFile(shortWav, toneWav(1));
  await writeFile(longWav, toneWav(120));
}, 60_000);

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('ensureMp3', () => {
  it('transcodes to a real 44.1kHz mp3', async () => {
    const out = join(dir, 'out.mp3');
    await ensureMp3(tools.ffmpeg.path, shortWav, out);

    const info = await probeAudio(tools.ffprobe.path, out);
    expect(isMp3Format(info.format)).toBe(true);
    expect(info.duration).toBeGreaterThan(0.9);
    expect(info.duration).toBeLessThan(1.5);
  }, 60_000);

  it('overwrites an existing output instead of prompting', async () => {
    const out = join(dir, 'overwrite.mp3');
    await writeFile(out, 'stale');
    await ensureMp3(tools.ffmpeg.path, shortWav, out);
    expect(isMp3Format((await probeAudio(tools.ffprobe.path, out)).format)).toBe(true);
  }, 60_000);

  it("reports a non-audio input as FfmpegError with ffmpeg's own reason", async () => {
    const junk = join(dir, 'junk.mp3');
    await writeFile(junk, 'this is not audio');
    await expect(ensureMp3(tools.ffmpeg.path, junk, join(dir, 'never.mp3'))).rejects.toThrow(
      FfmpegError,
    );
  }, 60_000);

  it('names a missing binary instead of failing as a generic spawn error', async () => {
    await expect(
      ensureMp3(join(dir, 'no-such-ffmpeg'), shortWav, join(dir, 'never.mp3')),
    ).rejects.toThrow(/ffmpeg not found.*LARK_FFMPEG_PATH/);
  });

  // Cancellation is the whole reason for the AbortSignal plumbing: without it
  // `downloads.close()` waits out a 10-minute transcode.
  it('kills a running child when the caller aborts', async () => {
    const controller = new AbortController();
    const out = join(dir, 'aborted.mp3');
    const promise = ensureMp3(tools.ffmpeg.path, longWav, out, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancelled or timed out/);

    // Had the child survived the abort it would have finished and left a
    // complete 120s mp3 here. Anything shorter (or unreadable) means it died.
    const info = await probeAudio(tools.ffprobe.path, out).catch(() => ({ duration: 0 }));
    expect(info.duration).toBeLessThan(100);
  }, 60_000);

  it('gives up on its own deadline', async () => {
    const out = join(dir, 'timeout.mp3');
    await expect(
      ensureMp3(tools.ffmpeg.path, longWav, out, {
        timeouts: { ...DEFAULT_TIMEOUTS, ffmpeg: 5 },
      }),
    ).rejects.toThrow(/cancelled or timed out/);
  }, 60_000);

  it('rejects an already-aborted signal without spawning anything', async () => {
    await expect(
      ensureMp3(tools.ffmpeg.path, shortWav, join(dir, 'never.mp3'), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/cancelled or timed out/);
  });
});

describe('probeAudio', () => {
  it('reads duration and container format', async () => {
    const info = await probeAudio(tools.ffprobe.path, shortWav);
    expect(info.duration).toBeGreaterThan(0.9);
    expect(info.format).toContain('wav');
  }, 60_000);

  it('rejects a file with no media rather than reporting duration 0', async () => {
    const junk = join(dir, 'not-media.mp3');
    await writeFile(junk, 'hello');
    await expect(probeAudio(tools.ffprobe.path, junk)).rejects.toThrow(FfmpegError);
  }, 60_000);

  it('rejects a missing file', async () => {
    await expect(probeAudio(tools.ffprobe.path, join(dir, 'absent.mp3'))).rejects.toThrow(
      FfmpegError,
    );
  }, 60_000);
});

describe('isMp3Format', () => {
  // The import guard: an AAC renamed to .mp3 must not enter the library as one.
  it('tells a real mp3 apart from a renamed m4a', () => {
    expect(isMp3Format('mp3')).toBe(true);
    expect(isMp3Format('mov,mp4,m4a,3gp,3g2,mj2')).toBe(false);
    expect(isMp3Format('aac')).toBe(false);
    expect(isMp3Format('flac')).toBe(false);
    expect(isMp3Format('')).toBe(false);
  });
});
