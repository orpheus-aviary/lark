// These run the REAL static binaries. A mocked child_process would prove the
// argument list is what we wrote down and nothing about whether ffmpeg accepts
// it — and the arguments are exactly where this can be wrong (a codec name, a
// flag order, an output that is silently not an mp3).
//
// The fixture is synthesised by ffmpeg itself, so there is no binary in git.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FfmpegError } from '../errors.js';
import { ensureMp3, isMp3Format, probeAudio, resolveFfmpegBinaries } from './ffmpeg.js';
import { DEFAULT_TIMEOUTS } from './timeouts.js';

let dir = '';
/** 1s of tone in an m4a container — the shape bilibili's dash audio arrives in. */
let sourceM4a = '';
/**
 * 300s of the same. Transcoding it takes ~0.7s here, which is long enough
 * that a cancellation lands with the child genuinely mid-run — a 1s fixture
 * would finish before the abort and the test would pass without proving
 * anything.
 */
let longM4a = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lark-ffmpeg-'));
  sourceM4a = join(dir, 'source.m4a');
  longM4a = join(dir, 'long.m4a');
  const { ffmpeg } = resolveFfmpegBinaries();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const synth = (seconds: number, out: string) =>
    promisify(execFile)(ffmpeg.path, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:a',
      'aac',
      '-y',
      out,
    ]);
  await synth(1, sourceM4a);
  await synth(300, longM4a);
}, 60_000);

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('resolveFfmpegBinaries', () => {
  it('prefers the static packages in a dev checkout', () => {
    const { ffmpeg, ffprobe } = resolveFfmpegBinaries();
    expect(ffmpeg.source).toBe('static');
    expect(ffprobe.source).toBe('static');
    // The @derhuerst fork default-exports the path itself; the older package
    // exported `{path}`, which would show up here as a resolution failure.
    expect(ffmpeg.path).toMatch(/ffmpeg-static\/ffmpeg$/);
    expect(ffprobe.path).toMatch(/ffprobe-static\/ffprobe$/);
  });

  it('lets the env override win — the seam a packaged build uses', () => {
    vi.stubEnv('LARK_FFMPEG_PATH', '/opt/lark/ffmpeg');
    vi.stubEnv('LARK_FFPROBE_PATH', '/opt/lark/ffprobe');
    try {
      expect(resolveFfmpegBinaries().ffmpeg).toEqual({ path: '/opt/lark/ffmpeg', source: 'env' });
      expect(resolveFfmpegBinaries().ffprobe).toEqual({ path: '/opt/lark/ffprobe', source: 'env' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores an empty override rather than resolving to ""', () => {
    vi.stubEnv('LARK_FFMPEG_PATH', '');
    try {
      expect(resolveFfmpegBinaries().ffmpeg.source).toBe('static');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('ensureMp3', () => {
  it('transcodes to a real 44.1kHz mp3', async () => {
    const out = join(dir, 'out.mp3');
    await ensureMp3(sourceM4a, out);

    const info = await probeAudio(out);
    expect(isMp3Format(info.format)).toBe(true);
    expect(info.duration).toBeGreaterThan(0.9);
    expect(info.duration).toBeLessThan(1.5);
  }, 60_000);

  it('overwrites an existing output instead of prompting', async () => {
    const out = join(dir, 'overwrite.mp3');
    await writeFile(out, 'stale');
    await ensureMp3(sourceM4a, out);
    expect(isMp3Format((await probeAudio(out)).format)).toBe(true);
  }, 60_000);

  it("reports a non-audio input as FfmpegError with ffmpeg's own reason", async () => {
    const junk = join(dir, 'junk.mp3');
    await writeFile(junk, 'this is not audio');
    await expect(ensureMp3(junk, join(dir, 'never.mp3'))).rejects.toThrow(FfmpegError);
  }, 60_000);

  it('names a missing binary instead of failing as a generic spawn error', async () => {
    vi.stubEnv('LARK_FFMPEG_PATH', join(dir, 'no-such-ffmpeg'));
    try {
      await expect(ensureMp3(sourceM4a, join(dir, 'never.mp3'))).rejects.toThrow(
        /ffmpeg not found.*LARK_FFMPEG_PATH/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Cancellation is the whole reason for the AbortSignal plumbing: without it
  // `downloads.close()` waits out a 10-minute transcode.
  it('kills a running child when the caller aborts', async () => {
    const controller = new AbortController();
    const out = join(dir, 'aborted.mp3');
    const promise = ensureMp3(longM4a, out, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancelled or timed out/);

    // Had the child survived the abort it would have finished and left a
    // complete 300s mp3 here. Anything shorter (or unreadable) means it died.
    const info = await probeAudio(out).catch(() => ({ duration: 0 }));
    expect(info.duration).toBeLessThan(250);
  }, 60_000);

  it('gives up on its own deadline', async () => {
    const out = join(dir, 'timeout.mp3');
    await expect(
      ensureMp3(longM4a, out, { timeouts: { ...DEFAULT_TIMEOUTS, ffmpeg: 5 } }),
    ).rejects.toThrow(/cancelled or timed out/);
  }, 60_000);

  it('rejects an already-aborted signal without spawning anything', async () => {
    await expect(
      ensureMp3(sourceM4a, join(dir, 'never.mp3'), { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled or timed out/);
  });
});

describe('probeAudio', () => {
  it('reads duration and container format', async () => {
    const info = await probeAudio(sourceM4a);
    expect(info.duration).toBeGreaterThan(0.9);
    expect(info.format).toContain('m4a');
  }, 60_000);

  it('rejects a file with no media rather than reporting duration 0', async () => {
    const junk = join(dir, 'not-media.mp3');
    await writeFile(junk, 'hello');
    await expect(probeAudio(junk)).rejects.toThrow(FfmpegError);
  }, 60_000);

  it('rejects a missing file', async () => {
    await expect(probeAudio(join(dir, 'absent.mp3'))).rejects.toThrow(FfmpegError);
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
