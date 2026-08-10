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
// `probeAudio` returns the container format alongside the duration because
// import needs it: a `.mp3` that is really an AAC has to be refused, and only
// the format tells you (R22/M3-11).

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

export interface AudioInfo {
  /** Seconds. 0 when the container does not declare one. */
  duration: number;
  /** ffprobe's `format_name`, e.g. `mp3` or `mov,mp4,m4a,3gp,3g2,mj2`. */
  format: string;
}

/** Duration + container format. Used for both download and import. */
export async function probeAudio(
  ffprobePath: string,
  filePath: string,
  options: FfmpegRunOptions = {},
): Promise<AudioInfo> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const stdout = await run(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'json', filePath],
    withTimeout(timeouts.ffprobe, options.signal),
    'ffprobe',
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new FfmpegError(`ffprobe output was not JSON for ${filePath}`, { cause: err });
  }
  const format = (parsed as { format?: { duration?: unknown; format_name?: unknown } })?.format;
  if (format === undefined || format === null) {
    throw new FfmpegError(`ffprobe found no media in ${filePath}`);
  }
  const duration = Number(format.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    format: typeof format.format_name === 'string' ? format.format_name : '',
  };
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
