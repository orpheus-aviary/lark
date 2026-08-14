// These run a REAL ffmpeg. A mocked child_process would prove the argument
// list is what we wrote down and nothing about whether ffmpeg accepts it — and
// the arguments are exactly where this can be wrong (a codec name, a flag
// order, an output that is silently not what it claims to be).
//
// The inputs are WAV files written by hand here, not synthesised with
// `-f lavfi`: the vendored build is a minimal LGPL profile with no lavfi
// demuxer (M7 T0), so a test that asked ffmpeg to generate its own fixture
// would only pass against a full system build. A PCM WAV needs nothing but a
// 44-byte header, and it exercises the same argument list.
//
// The m4a the copy path needs IS produced here, by the transcode path, because
// that is the only encoder in the profile. It costs nothing in confidence: if
// the encoder were broken the transcode tests fail first and say so.
//
// One branch cannot be run for real — `copy-adts` — because the profile has no
// ADTS muxer (nothing in lark writes one). `planAudioConversion` is a pure
// function of the probe precisely so that branch is still covered by argument
// assertions; T4's import matrix adds a checked-in .aac fixture.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegError } from '../errors.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { toneWav } from '../testing/tone-wav.js';
import {
  type AudioProbe,
  isMp3Format,
  planAudioConversion,
  probeAudio,
  processAudio,
} from './ffmpeg.js';
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
/**
 * The probe of `shortWav`, and equally of `longWav`: same writer, same codec,
 * rate and layout — only the duration differs, and no rule reads it.
 */
let wavProbe: AudioProbe;

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
  wavProbe = await probeAudio(tools.ffprobe.path, shortWav);
}, 60_000);

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

describe('probeAudio', () => {
  it('reads duration and container format', async () => {
    const info = await probeAudio(tools.ffprobe.path, shortWav);
    expect(info.duration).toBeGreaterThan(0.9);
    expect(info.container).toContain('wav');
  }, 60_000);

  it('describes the stream the conversion will use', async () => {
    const info = await probeAudio(tools.ffprobe.path, shortWav);
    expect(info.selected_stream_global_index).toBe(0);
    expect(info.codec).toBe('pcm_s16le');
    expect(info.sample_rate).toBe(22_050);
    expect(info.channels).toBe(1);
    // Empty on purpose: a PCM WAV declares no layout and ffprobe then omits
    // the key entirely. Every rule reads `channels`; the layout is for humans.
    expect(info.channel_layout).toBe('');
    expect(info.audio_stream_count).toBe(1);
  }, 60_000);

  // Cover art is a video stream, and mp3/m4a carry it routinely. Reading it as
  // "this is a video file" would refuse most of a real music library.
  it('reports no video for a plain audio file', async () => {
    const info = await probeAudio(tools.ffprobe.path, shortWav);
    expect(info.has_real_video).toBe(false);
    expect(info.has_attached_pic).toBe(false);
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

describe('planAudioConversion', () => {
  const base: AudioProbe = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: 200,
    selected_stream_global_index: 0,
    codec: 'aac',
    sample_rate: 44_100,
    channels: 2,
    channel_layout: 'stereo',
    audio_stream_count: 1,
    has_attached_pic: false,
    has_real_video: false,
  };

  it('copies AAC that is already in an MP4', () => {
    const plan = planAudioConversion(base);
    expect(plan.mode).toBe('copy');
    expect(plan.args).toEqual([
      '-map',
      '0:0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
    ]);
  });

  it('copies raw ADTS with the bitstream filter MP4 requires', () => {
    const plan = planAudioConversion({ ...base, container: 'aac' });
    expect(plan.mode).toBe('copy-adts');
    expect(plan.args).toEqual([
      '-map',
      '0:0',
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
    ]);
  });

  it('encodes anything else at 192k, leaving a sane rate and layout alone', () => {
    const plan = planAudioConversion({ ...base, container: 'mp3', codec: 'mp3' });
    expect(plan.mode).toBe('transcode');
    expect(plan.args).toEqual([
      '-map',
      '0:0',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-f',
      'ipod',
    ]);
  });

  it('resamples above 48kHz and downmixes above stereo', () => {
    const plan = planAudioConversion({
      ...base,
      container: 'flac',
      codec: 'flac',
      sample_rate: 96_000,
      channels: 6,
    });
    expect(plan.args).toContain('-ar');
    expect(plan.args).toContain('48000');
    expect(plan.args).toContain('-ac');
    expect(plan.args).toContain('2');
  });

  // The bug this rules out: `-map 0:a:0` means "the first AUDIO stream", and
  // a file whose cover art is stream 0 has its audio at global index 1. Mixing
  // the two selects the picture.
  it('maps the global stream index, not the audio ordinal', () => {
    const plan = planAudioConversion({ ...base, selected_stream_global_index: 1 });
    expect(plan.args.slice(0, 2)).toEqual(['-map', '0:1']);
  });

  it('refuses a file with no audio stream instead of building a command', () => {
    expect(() => planAudioConversion({ ...base, selected_stream_global_index: -1 })).toThrow(
      FfmpegError,
    );
  });
});

describe('processAudio', () => {
  it('encodes a WAV into a real AAC-in-MP4', async () => {
    const out = join(dir, 'processed.m4a');
    expect(await processAudio(tools.ffmpeg.path, shortWav, out, wavProbe)).toBe('transcode');

    const info = await probeAudio(tools.ffprobe.path, out);
    expect(info.container.split(',')).toContain('m4a');
    expect(info.codec).toBe('aac');
    expect(info.duration).toBeGreaterThan(0.9);
  }, 60_000);

  // The download path: bilibili hands over AAC in an MP4 already, so the bytes
  // must survive untouched — a re-encode here is lossy for no reason.
  it('copies an m4a without re-encoding it', async () => {
    const source = join(dir, 'source.m4a');
    await processAudio(tools.ffmpeg.path, shortWav, source, wavProbe);
    const sourceProbe = await probeAudio(tools.ffprobe.path, source);

    const out = join(dir, 'copied.m4a');
    expect(await processAudio(tools.ffmpeg.path, source, out, sourceProbe)).toBe('copy');
    const info = await probeAudio(tools.ffprobe.path, out);
    expect(info.codec).toBe('aac');
    expect(info.sample_rate).toBe(sourceProbe.sample_rate);
    expect(info.duration).toBeCloseTo(sourceProbe.duration, 1);
  }, 60_000);

  // The defect accept-gui caught: MP4 writes its index (`moov`) after the
  // audio by default, and a media element served such a file over HTTP cannot
  // report so much as a duration until it has range-requested the tail. Only a
  // real run proves the flag did anything.
  it('writes the index before the audio, so a player can start at byte 0', async () => {
    const out = join(dir, 'faststart.m4a');
    await processAudio(tools.ffmpeg.path, shortWav, out, wavProbe);

    const bytes = (await readFile(out)).toString('latin1');
    expect(bytes.indexOf('moov')).toBeGreaterThan(-1);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
  }, 60_000);

  it('overwrites an existing output instead of prompting', async () => {
    const out = join(dir, 'overwrite.m4a');
    await writeFile(out, 'stale');
    await processAudio(tools.ffmpeg.path, shortWav, out, wavProbe);
    expect((await probeAudio(tools.ffprobe.path, out)).codec).toBe('aac');
  }, 60_000);

  it('names a missing binary instead of failing as a generic spawn error', async () => {
    await expect(
      processAudio(join(dir, 'no-such-ffmpeg'), shortWav, join(dir, 'never.m4a'), wavProbe),
    ).rejects.toThrow(/ffmpeg not found.*LARK_FFMPEG_PATH/);
  });

  it('gives up on its own deadline', async () => {
    await expect(
      processAudio(tools.ffmpeg.path, longWav, join(dir, 'timeout.m4a'), wavProbe, {
        timeouts: { ...DEFAULT_TIMEOUTS, ffmpeg: 5 },
      }),
    ).rejects.toThrow(/cancelled or timed out/);
  }, 60_000);

  it('rejects an already-aborted signal without spawning anything', async () => {
    await expect(
      processAudio(tools.ffmpeg.path, shortWav, join(dir, 'never.m4a'), wavProbe, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/cancelled or timed out/);
  });

  it('reports a non-audio input as FfmpegError', async () => {
    const junk = join(dir, 'junk-process.m4a');
    await writeFile(junk, 'this is not audio');
    await expect(
      processAudio(tools.ffmpeg.path, junk, join(dir, 'never.m4a'), wavProbe),
    ).rejects.toThrow(FfmpegError);
  }, 60_000);

  it('kills a running child when the caller aborts', async () => {
    const controller = new AbortController();
    const out = join(dir, 'aborted.m4a');
    const promise = processAudio(tools.ffmpeg.path, longWav, out, wavProbe, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancelled or timed out/);

    const info = await probeAudio(tools.ffprobe.path, out).catch(() => ({ duration: 0 }));
    expect(info.duration).toBeLessThan(100);
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
