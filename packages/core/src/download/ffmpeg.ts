// ffmpeg / ffprobe, wrapped (M3-8).
//
// The Go version shelled out to whatever `ffmpeg` was on PATH, with an
// unbounded buffer and no way to cancel — a stuck transcode was a stuck app.
// Three things change here:
//
//   - WHICH binary runs is not decided here. Both functions take a resolved
//     path from the process-wide `MediaToolsRegistry` (M7-18). They used to
//     re-resolve per call, which is how the daemon ended up able to report
//     "no ffmpeg" while happily transcoding through a Homebrew one;
//   - every run carries an AbortSignal, so cancelling a task or stopping the
//     daemon actually kills the child;
//   - `maxBuffer` is explicit. Node's default is 1MB, but relying on a default
//     for "how much stderr before we SIGKILL the child" is how a verbose
//     failure turns into a mystery crash. `-v error` keeps output tiny anyway.
//
// `probeAudio` returns a whole `AudioProbe` rather than a duration, because
// from 0.3.0 the probe is what DECIDES the conversion: canonical audio is
// `song.m4a`, AAC arrives from bilibili already in an MP4, and copying it is
// both lossless and ~50× faster than re-encoding. Nothing but the probe can
// tell that apart from an AAC in an ADTS stream (same codec, different
// bitstream) or from an mp3 that has to be encoded.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FfmpegError } from '../errors.js';
import { DEFAULT_TIMEOUTS, type DownloadTimeouts, withTimeout } from './timeouts.js';

const execFileAsync = promisify(execFile);

/** stderr is capped by `-v error`; 1MB is a backstop, not a working budget. */
const MAX_BUFFER = 1024 * 1024;

export interface FfmpegRunOptions {
  /** Cancellation from the owning task. Composed with the stage timeout. */
  signal?: AbortSignal;
  /** Test seam: shorten the deadlines. */
  timeouts?: DownloadTimeouts;
}

/**
 * Transcode anything ffmpeg can read into a 192kbps 44.1kHz MP3.
 *
 * `-vn` drops the cover art stream bilibili's audio track sometimes carries;
 * `-nostdin` stops ffmpeg from consuming the daemon's stdin if it ever decides
 * to prompt; `-y` overwrites, which is safe because the output is always a
 * task-scoped temp path.
 *
 * `-f mp3` is not optional here: the output path ends in `.tmp`, so ffmpeg
 * cannot infer the container from the extension and fails with "unable to find
 * a suitable output format" — a message that reads like a codec problem.
 */
export async function ensureMp3(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  options: FfmpegRunOptions = {},
): Promise<void> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  await run(
    ffmpegPath,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-ab',
      '192k',
      '-ar',
      '44100',
      '-f',
      'mp3',
      '-y',
      outputPath,
    ],
    withTimeout(timeouts.ffmpeg, options.signal),
    'ffmpeg',
  );
}

/**
 * Everything the conversion rules need to know about a file, and nothing that
 * identifies it: no filename, no staging path (import shows failures to a user
 * who never saw the staged copy).
 */
export interface AudioProbe {
  /** ffprobe's `format_name`, e.g. `mp3` or `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: string;
  /** Seconds. 0 when neither the container nor the stream declares one. */
  duration: number;
  /**
   * ffprobe's GLOBAL `stream.index` of the audio track to use, or -1 when the
   * file carries no audio.
   *
   * Global, and never the `-map 0:a:<n>` ordinal: those are different numbers
   * the moment a file puts cover art or video before the audio, and mixing
   * them selects the wrong stream.
   */
  selected_stream_global_index: number;
  codec: string;
  sample_rate: number;
  channels: number;
  /** Often empty — a PCM WAV declares no layout. Informational; rules read `channels`. */
  channel_layout: string;
  /** The first is selected; a caller that cares warns about the rest. */
  audio_stream_count: number;
  /**
   * Cover art — a video stream with `disposition.attached_pic`. mp3 and m4a
   * carry it routinely, so it is NOT what makes a file a video.
   */
  has_attached_pic: boolean;
  /** A video stream that is not cover art: really a video file. */
  has_real_video: boolean;
}

interface ProbeStream {
  index?: unknown;
  codec_type?: unknown;
  codec_name?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  channel_layout?: unknown;
  duration?: unknown;
  disposition?: { attached_pic?: unknown };
}

/** Container, streams and dispositions. Used by download, import and migration. */
export async function probeAudio(
  ffprobePath: string,
  filePath: string,
  options: FfmpegRunOptions = {},
): Promise<AudioProbe> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const stdout = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      // `stream_disposition` is its own section: asking for `stream=disposition`
      // returns nothing, silently, and every file then looks like cover art.
      'format=format_name,duration:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration:stream_disposition=attached_pic',
      '-of',
      'json',
      filePath,
    ],
    withTimeout(timeouts.ffprobe, options.signal),
    'ffprobe',
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new FfmpegError(`ffprobe output was not JSON for ${filePath}`, { cause: err });
  }
  const root = parsed as { format?: { duration?: unknown; format_name?: unknown } | null };
  const format = root?.format;
  if (format === undefined || format === null) {
    throw new FfmpegError(`ffprobe found no media in ${filePath}`);
  }
  const streams = Array.isArray((parsed as { streams?: unknown }).streams)
    ? ((parsed as { streams: ProbeStream[] }).streams as ProbeStream[])
    : [];

  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .sort((a, b) => number(a.index) - number(b.index));
  const video = streams.filter((s) => s.codec_type === 'video');
  const selected = audio[0];

  // Containers that declare no overall duration (ADTS, some ogg) still carry
  // one on the stream. Reporting 0 there would show the library a song of
  // unknown length for no reason.
  const declared = number(format.duration);
  const duration = declared > 0 ? declared : number(selected?.duration);

  return {
    container: typeof format.format_name === 'string' ? format.format_name : '',
    duration: duration > 0 ? duration : 0,
    selected_stream_global_index: selected === undefined ? -1 : number(selected.index),
    codec: selected === undefined ? '' : text(selected.codec_name),
    sample_rate: number(selected?.sample_rate),
    channels: number(selected?.channels),
    channel_layout: selected === undefined ? '' : text(selected.channel_layout),
    audio_stream_count: audio.length,
    has_attached_pic: video.some((s) => number(s.disposition?.attached_pic) === 1),
    has_real_video: video.some((s) => number(s.disposition?.attached_pic) !== 1),
  };
}

function number(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ─── Conversion ────────────────────────────────────────

/** Canonical audio is AAC in an MP4 (`-f ipod`), always. */
export const CANONICAL_BITRATE = '192k';
/** Above this, resample. AAC handles more; nothing in this library needs it. */
export const MAX_SAMPLE_RATE = 48_000;
/** Above this, downmix. Same reasoning. */
export const MAX_CHANNELS = 2;

export type AudioConversionMode =
  /** Already AAC in an MP4: rewrap, byte-identical audio. */
  | 'copy'
  /** AAC in an ADTS stream: rewrap, plus the bitstream filter MP4 needs. */
  | 'copy-adts'
  /** Anything else: encode. */
  | 'transcode';

export interface AudioConversionPlan {
  mode: AudioConversionMode;
  /** ffmpeg arguments between the input and the output path. */
  args: readonly string[];
}

/**
 * Every branch ends `-movflags +faststart -f ipod`.
 *
 * MP4 puts its index (`moov`) wherever the muxer finished writing it, which by
 * default is AFTER the audio. A player handed such a file over HTTP cannot
 * report so much as a duration until it has range-requested the tail — and
 * lark's audio is always served over HTTP, to a media element, sometimes over
 * a slow link. accept-gui caught this the honest way: the 30-minute fixture
 * came back `duration=undefined`, and the only request the player made was for
 * the last 0.1% of the file. `+faststart` costs one rewrite pass at the end of
 * the conversion and moves `moov` to the front, where a stream needs it.
 */
const CANONICAL_OUTPUT = ['-movflags', '+faststart', '-f', 'ipod'];

/**
 * How to turn this file into canonical audio — a pure function of the probe,
 * so every branch is testable without a codec that can produce the input.
 *
 * `-map 0:<global index>` is on every branch, and it is what excludes cover
 * art, video and second audio tracks: after an explicit -map, ffmpeg carries
 * exactly what was named.
 */
export function planAudioConversion(probe: AudioProbe): AudioConversionPlan {
  if (probe.selected_stream_global_index < 0) {
    throw new FfmpegError(`没有找到音频流（容器 ${probe.container || '未知'}）`);
  }
  const map = ['-map', `0:${probe.selected_stream_global_index}`];
  const containers = probe.container.split(',');

  if (probe.codec === 'aac' && containers.some((c) => MP4_FAMILY.has(c))) {
    return { mode: 'copy', args: [...map, '-c', 'copy', ...CANONICAL_OUTPUT] };
  }
  // A raw ADTS stream copies fine, but MP4 wants the codec configuration in
  // the sample entry rather than in every frame header — that is the filter.
  if (probe.codec === 'aac' && containers.includes('aac')) {
    return {
      mode: 'copy-adts',
      args: [...map, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', ...CANONICAL_OUTPUT],
    };
  }
  return {
    mode: 'transcode',
    args: [
      ...map,
      '-c:a',
      'aac',
      '-b:a',
      CANONICAL_BITRATE,
      ...(probe.sample_rate > MAX_SAMPLE_RATE ? ['-ar', String(MAX_SAMPLE_RATE)] : []),
      ...(probe.channels > MAX_CHANNELS ? ['-ac', String(MAX_CHANNELS)] : []),
      ...CANONICAL_OUTPUT,
    ],
  };
}

const MP4_FAMILY = new Set(['mp4', 'm4a', 'mov', '3gp', '3g2']);

/**
 * Write `outputPath` as canonical audio, copying when that is possible.
 *
 * The probe is a parameter rather than something this re-derives: the caller
 * has already paid for it (import validates with it, the migration classifies
 * with it), and two probes of the same file could disagree after a partial
 * write. `-f ipod` is not optional — output paths end in `.tmp`, so ffmpeg
 * cannot infer the container and reports it as "unable to find a suitable
 * output format", which reads like a codec problem.
 */
export async function processAudio(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  probe: AudioProbe,
  options: FfmpegRunOptions = {},
): Promise<AudioConversionMode> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const plan = planAudioConversion(probe);
  await run(
    ffmpegPath,
    ['-nostdin', '-v', 'error', '-i', inputPath, ...plan.args, '-y', outputPath],
    withTimeout(timeouts.ffmpeg, options.signal),
    'ffmpeg',
  );
  return plan.mode;
}

/**
 * Is this really an MP3?
 *
 * `format_name` is a comma-separated list of the formats the demuxer answers
 * to, so a renamed `.m4a` reports `mov,mp4,m4a,3gp,3g2,mj2` and never `mp3`.
 * Extension checks cannot see any of this.
 */
export function isMp3Format(format: string): boolean {
  return format.split(',').includes('mp3');
}

// ─── Child process ─────────────────────────────────────

async function run(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
  label: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, [...args], {
      signal,
      maxBuffer: MAX_BUFFER,
      // Never a shell: paths here come from user-supplied filenames.
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    throw new FfmpegError(describeFailure(label, binary, err), { cause: err });
  }
}

function describeFailure(label: string, binary: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  if (e?.code === 'ENOENT') {
    // Reachable even though the registry probed successfully: the binary can
    // disappear between the probe and the run (an app bundle replaced under a
    // running daemon). `noteExecutionFailure` invalidates the verdict on this.
    return `${label} not found at ${binary} — install ffmpeg (\`brew install ffmpeg\`) or set LARK_${label.toUpperCase()}_PATH`;
  }
  if (e?.name === 'AbortError' || e?.killed === true) {
    return `${label} was cancelled or timed out`;
  }
  // `-v error` means stderr is the actual reason, and it is short.
  const stderr = (e?.stderr ?? '').trim();
  return stderr !== ''
    ? `${label} failed: ${stderr.slice(0, 500)}`
    : `${label} failed: ${e?.message}`;
}
