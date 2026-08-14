// 附表 A, executed. Every row of the frozen classification table is a case
// here, and the rows that say "content" — the only ones that can end with a
// user's mp3 being deleted — are driven by a REAL vendored ffmpeg against a
// REAL damaged mp3, not by a hand-written error object.
//
// That distinction is the whole point of the batch order: the table and these
// fixtures land before the converter, because the converter is what unlinks.
// A synthetic `new Error('Invalid data found')` would prove that the pattern
// list matches itself.
//
// The rows that cannot be produced honestly on a developer's machine (a full
// disk, a quota) are synthesised from the errno the kernel would raise, which
// is the signal the rule actually reads.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeAudio, processAudio } from '../download/ffmpeg.js';
import { DEFAULT_TIMEOUTS } from '../download/timeouts.js';
import { FfmpegError, MediaToolsUnavailableError } from '../errors.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { type Mp3Damage, damageMp3, readToneMp3 } from '../testing/mp3-fixture.js';
import { toneWav } from '../testing/tone-wav.js';
import { classifyMigrationError } from './error-class.js';
import { assessCanonicalAudio } from './verify.js';

let dir = '';
let tools: ResolvedMediaTools;
/** The tracked fixture, undamaged: 1s of 192kbps mp3. */
let goodMp3 = '';

async function damaged(name: Mp3Damage): Promise<string> {
  const path = join(dir, `${name}.mp3`);
  await writeFile(path, damageMp3(await readToneMp3(), name));
  return path;
}

/** Probe + convert, the way the converter will, returning whatever it threw. */
async function convert(input: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const probe = await probeAudio(tools.ffprobe.path, input, { signal });
    await processAudio(tools.ffmpeg.path, input, join(dir, 'out.m4a'), probe, { signal });
    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(async () => {
  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  const probe = await probeCapabilities(outcome.tools);
  if (probe.state !== 'ready') {
    throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
  }
  tools = outcome.tools;
  dir = await mkdtemp(join(tmpdir(), 'lark-migration-err-'));
  goodMp3 = join(dir, 'good.mp3');
  await writeFile(goodMp3, await readToneMp3());
}, 60_000);

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('content — a real damaged mp3', () => {
  // The three shapes that fail loudly. All of them come out of the tools as a
  // non-zero exit plus stderr, which is the only combination allowed to be
  // classified as content.
  it.each<Mp3Damage>(['unreadable', 'junk', 'empty'])(
    'classifies a %s mp3 as content',
    async (damage) => {
      const err = await convert(await damaged(damage));
      expect(err).toBeInstanceOf(FfmpegError);
      expect(classifyMigrationError(err, 'convert')).toBe('content');
    },
    60_000,
  );

  // And the two that fail QUIETLY: ffmpeg exits 0 and writes a valid m4a
  // holding a fraction of the song. Nothing in the error path sees these —
  // only the output assessment does, which is why the migration verifies
  // before it deletes.
  it.each<Mp3Damage>(['truncated', 'scrambled'])(
    'converts a %s mp3 successfully and catches it on the output',
    async (damage) => {
      const input = await damaged(damage);
      const source = await probeAudio(tools.ffprobe.path, input);
      const out = join(dir, `${damage}.m4a`);
      await processAudio(tools.ffmpeg.path, input, out, source);

      const result = await probeAudio(tools.ffprobe.path, out);
      expect(result.codec).toBe('aac');
      expect(result.duration).toBeLessThan(source.duration);
      const verdict = assessCanonicalAudio(result, source.duration);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('源文件已损坏');
    },
    60_000,
  );

  it('accepts an undamaged conversion', async () => {
    const source = await probeAudio(tools.ffprobe.path, goodMp3);
    const out = join(dir, 'good.m4a');
    await processAudio(tools.ffmpeg.path, goodMp3, out, source);
    expect(
      assessCanonicalAudio(await probeAudio(tools.ffprobe.path, out), source.duration),
    ).toEqual({ ok: true, reason: '' });
  }, 60_000);
});

describe('environment', () => {
  it('classifies a missing binary as environment, not as a broken file', async () => {
    const err = await new Promise((resolve) => {
      processAudio(join(dir, 'no-such-ffmpeg'), goodMp3, join(dir, 'never.m4a'), {
        container: 'mp3',
        duration: 1,
        selected_stream_global_index: 0,
        codec: 'mp3',
        sample_rate: 44_100,
        channels: 1,
        channel_layout: '',
        audio_stream_count: 1,
        has_attached_pic: false,
        has_real_video: false,
      }).then(resolve, resolve);
    });
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
  }, 60_000);

  it('classifies an unwritable output directory as environment', async () => {
    await writeFile(join(dir, 'blocker'), 'not a directory');
    // A file where ffmpeg expects a directory: EACCES and ENOTDIR both reach
    // the same rule, and this one needs no chmod dance that a root CI would
    // sail straight through.
    const probe = await probeAudio(tools.ffprobe.path, goodMp3);
    let err: unknown = null;
    try {
      await processAudio(tools.ffmpeg.path, goodMp3, join(dir, 'blocker', 'out.m4a'), probe);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FfmpegError);
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
  }, 60_000);

  it('classifies a timeout as environment, never as abort', async () => {
    const wav = join(dir, 'long.wav');
    await writeFile(wav, toneWav(120));
    const probe = await probeAudio(tools.ffprobe.path, wav);
    let err: unknown = null;
    try {
      await processAudio(tools.ffmpeg.path, wav, join(dir, 'timeout.m4a'), probe, {
        timeouts: { ...DEFAULT_TIMEOUTS, ffmpeg: 5 },
      });
    } catch (e) {
      err = e;
    }
    // Same wrapper message as a real abort ("cancelled or timed out"), and it
    // must not resume as if the user had cancelled: nobody cancelled, the
    // machine ran out of time, and the pass should stop and change nothing.
    expect(classifyMigrationError(err, 'convert', new AbortController().signal)).toBe(
      'environment',
    );
  }, 60_000);

  it('classifies MediaToolsUnavailableError as environment', () => {
    const err = new MediaToolsUnavailableError('missing', 'no ffmpeg in the bundle');
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
    expect(classifyMigrationError(err, 'file_action')).toBe('environment');
  });

  it.each(['ENOSPC', 'EROFS', 'EIO', 'EDQUOT'])(
    'classifies %s as environment from either step',
    (code) => {
      const err = Object.assign(new Error('write failed'), { code });
      expect(classifyMigrationError(err, 'convert')).toBe('environment');
      expect(classifyMigrationError(err, 'file_action')).toBe('environment');
    },
  );

  // The ordering rule, and the reason there is an environment pattern list at
  // all: a run that dies on a full disk mid-transcode has ALSO printed the
  // decoder's complaints, and whichever list is consulted first decides
  // whether this song's mp3 gets deleted.
  it('reads a full disk before the decoder noise it printed alongside', () => {
    const stderr = [
      '[mp3float @ 0x1] Header missing',
      '[out#0/ipod @ 0x2] Error writing trailer: No space left on device',
    ].join('\n');
    const err = new FfmpegError(`ffmpeg failed: ${stderr}`, {
      cause: Object.assign(new Error('exited 1'), { code: 1, stderr }),
    });
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
  });

  it('classifies an unrecognised failure as environment', () => {
    expect(classifyMigrationError(new Error('something new'), 'convert')).toBe('environment');
    expect(classifyMigrationError(null, 'convert')).toBe('environment');
  });

  // Content patterns only apply to a tool that RAN. Without an exit code this
  // is our own wrapper failing on its own output, which says nothing about
  // the file.
  it('does not call it content when no tool exit code is present', () => {
    const err = new FfmpegError('ffprobe output was not JSON for song.mp3');
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
  });
});

describe('abort', () => {
  it('classifies a cancelled run as abort from either step', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await convert(goodMp3, controller.signal);
    expect(err).not.toBeNull();
    expect(classifyMigrationError(err, 'convert', controller.signal)).toBe('abort');
    expect(classifyMigrationError(err, 'file_action', controller.signal)).toBe('abort');
  }, 60_000);

  // Abort wins over every other signal: teardown while the disk happens to be
  // full is still a teardown, and a teardown resumes.
  it('wins over an errno', () => {
    const controller = new AbortController();
    controller.abort();
    const err = Object.assign(new Error('unlink failed'), { code: 'EACCES' });
    expect(classifyMigrationError(err, 'file_action', controller.signal)).toBe('abort');
  });
});

describe('file_action', () => {
  it.each(['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EXDEV', 'ENOENT'])(
    'classifies %s during a file action as this song being blocked',
    (code) => {
      const err = Object.assign(new Error('rename failed'), { code });
      expect(classifyMigrationError(err, 'file_action')).toBe('file_action');
    },
  );

  // The same errno from the convert step is the machine, not the song: it is
  // the spawn failing, and every other song is about to fail identically.
  it.each(['EACCES', 'EPERM', 'ENOENT'])('classifies %s during convert as environment', (code) => {
    const err = Object.assign(new Error('spawn failed'), { code });
    expect(classifyMigrationError(err, 'convert')).toBe('environment');
  });

  it('classifies an errno-less file action failure as blocked too', () => {
    expect(classifyMigrationError(new Error('move refused'), 'file_action')).toBe('file_action');
  });
});

describe('assessCanonicalAudio', () => {
  const aac = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 240,
    selected_stream_global_index: 0,
    codec: 'aac',
    sample_rate: 44_100,
    channels: 2,
    channel_layout: 'stereo',
    audio_stream_count: 1,
    has_attached_pic: false,
    has_real_video: false,
  };

  it('accepts a conversion that grew slightly', () => {
    // An AAC encoder adds priming samples; the output is legitimately longer.
    expect(assessCanonicalAudio({ ...aac, duration: 240.05 }, 240).ok).toBe(true);
  });

  it('accepts a loss inside the tolerance', () => {
    expect(assessCanonicalAudio({ ...aac, duration: 238.5 }, 240).ok).toBe(true);
  });

  it('refuses a loss past it', () => {
    expect(assessCanonicalAudio({ ...aac, duration: 120 }, 240).ok).toBe(false);
  });

  it('uses a floor so a short clip is not judged by a percentage', () => {
    expect(assessCanonicalAudio({ ...aac, duration: 0.9 }, 1).ok).toBe(true);
    expect(assessCanonicalAudio({ ...aac, duration: 0.4 }, 1).ok).toBe(false);
  });

  it('skips the length check when nothing is known to compare against', () => {
    expect(assessCanonicalAudio({ ...aac, duration: 1 }, null).ok).toBe(true);
    expect(assessCanonicalAudio({ ...aac, duration: 1 }, 0).ok).toBe(true);
  });

  it('refuses anything that is not AAC in an MP4', () => {
    expect(assessCanonicalAudio({ ...aac, codec: 'mp3' }, null).ok).toBe(false);
    expect(assessCanonicalAudio({ ...aac, container: 'mp3' }, null).ok).toBe(false);
    expect(assessCanonicalAudio({ ...aac, selected_stream_global_index: -1 }, null).ok).toBe(false);
  });

  // The wreckage of an interrupted run: the container exists, `moov` never
  // got written, and every restart would otherwise call it a valid result.
  it('refuses a file with no duration', () => {
    expect(assessCanonicalAudio({ ...aac, duration: 0 }, null).ok).toBe(false);
  });
});
