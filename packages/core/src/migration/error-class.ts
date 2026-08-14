// What kind of failure was that? (0.3.0 T2, master plan §3.2-6)
//
// The audio migration is the only code in lark that deletes a user's file as a
// NORMAL outcome: an mp3 whose content now lives in the m4a beside it, or an
// mp3 whose content the migration could not read but whose source it just
// checked is still downloadable. Both deletions hang off this classification,
// so the classification is frozen in a table (子计划 §9 附表 A) and this module
// implements that table and nothing else.
//
// Why it cannot just read the message: the ffmpeg wrapper packs every failure
// — a missing binary, a cancelled run, a corrupt file, a full disk — into one
// `FfmpegError` whose text is whatever ffmpeg printed. Classifying on that
// alone would let a wording change in a future ffmpeg turn "this disk is full"
// into "this file is broken", and the second one deletes. So the rules read
// four independent signals, strictest first:
//
//   1. the caller's AbortSignal   → abort   (nothing is touched, we resume)
//   2. an errno on the error tree → environment or file_action, by which
//   3. the step that failed          errno it is and which step raised it
//   4. ffmpeg's stderr, only for a run that really started → content
//
// and anything that matches none of them is environment — the class that stops
// the pass and touches no files. A misfiled environment error costs a retry; a
// misfiled content error costs a song.

import { MediaToolsUnavailableError } from '../errors.js';

/**
 * The four outcomes of 附表 A. `file_action` is the one the ledger records as
 * a per-song `blocked` row with its `blocked_action`; the other three are
 * pass-level (`abort`, `blocked_environment`) or per-song content verdicts.
 */
export type MigrationErrorClass = 'abort' | 'environment' | 'content' | 'file_action';

/**
 * Which half of the state machine raised it.
 *
 * `convert` = probe, transcode, verify — everything that spawns a tool.
 * `file_action` = unlink / rename / move — everything that touches the library
 * itself. The same EACCES means "install a working ffmpeg" in the first and
 * "this one song's directory is not writable" in the second, and the second
 * must not stop the whole pass.
 */
export type MigrationStep = 'convert' | 'file_action';

/**
 * errnos that are about the MACHINE, not about this file or this step.
 *
 * These stop the pass from either step: a full disk does not become a
 * per-song problem because it happened to surface during a rename.
 */
const MACHINE_ERRNOS: ReadonlySet<string> = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EIO',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'EFBIG',
]);

/**
 * Substrings that mean "the toolchain cannot do this", checked BEFORE the
 * content patterns.
 *
 * Order matters, not decoration: a run that dies on a full disk mid-transcode
 * prints the decoder's complaints too, and whichever list is consulted first
 * decides. Lowercased before matching — ffmpeg's capitalisation varies by
 * version and none of these are worth a regex.
 */
const ENVIRONMENT_PATTERNS: readonly string[] = [
  'no space left on device',
  'permission denied',
  'read-only file system',
  'input/output error',
  'too many open files',
  'cannot allocate memory',
  'disk quota exceeded',
  // Build/capability failures. A profile without the decoder it needs is a
  // broken lark, never a broken song — see the ffmpeg capability manifest.
  'unknown encoder',
  'unknown decoder',
  'unknown muxer',
  'unknown demuxer',
  'not found for input stream',
  'encoder not found',
  'unable to find a suitable output format',
  'requested output format',
  'bitstream filter',
];

/**
 * Substrings that mean "this file is not readable audio". Only ever consulted
 * for a tool that ran and exited non-zero (§附表 A rule 7).
 *
 * Every entry here was produced by the vendored build against a real damaged
 * mp3 in `error-class.test.ts` — none of it is copied out of documentation.
 */
const CONTENT_PATTERNS: readonly string[] = [
  'invalid data found when processing input',
  'failed to find two consecutive mpeg audio frames',
  'could not find codec parameters',
  'header missing',
  'error while decoding',
  'moov atom not found',
  'failed to read frame size',
  'does not contain any stream',
  'end of file',
];

interface ErrorSignals {
  errno: string | null;
  /** A numeric `code` from execFile: the tool ran and exited with it. */
  exitCode: number | null;
  mediaToolsUnavailable: boolean;
  /** Message + stderr of every link in the cause chain, lowercased. */
  text: string;
}

/**
 * Classify a failure from the migration's conversion or file-action step.
 *
 * `signal` is the caller's own cancellation — the authoritative answer to "was
 * this an abort", and the only way to tell one from a TIMEOUT. Both arrive as
 * an `AbortError` from the same wrapper, but a cancelled run resumes untouched
 * while a run that blew its 10-minute deadline is a machine that could not
 * keep up: environment, stop, change nothing.
 */
export function classifyMigrationError(
  err: unknown,
  step: MigrationStep,
  signal?: AbortSignal,
): MigrationErrorClass {
  const s = collect(err);

  // 1. Cancellation. Only the caller's signal counts.
  if (signal?.aborted === true) return 'abort';

  // 2. The toolchain is not usable at all — decided before any file is opened.
  if (s.mediaToolsUnavailable) return 'environment';

  // 3. The machine, from either step.
  if (s.errno !== null && MACHINE_ERRNOS.has(s.errno)) return 'environment';

  // 4. Anything else that failed while touching the library is this song's
  //    problem, not the pass's: EACCES on one directory, EBUSY on one file.
  if (step === 'file_action') return 'file_action';

  // 5. A spawn that never became a process: no binary, or not executable.
  if (s.errno !== null) return 'environment';

  // 6/7. The tool ran. Its own words decide, environment before content.
  if (s.text !== '') {
    if (ENVIRONMENT_PATTERNS.some((p) => s.text.includes(p))) return 'environment';
    if (s.exitCode !== null && CONTENT_PATTERNS.some((p) => s.text.includes(p))) return 'content';
  }

  // 8. Unclassifiable, including a timeout: stop and touch nothing.
  return 'environment';
}

/** Walk the `cause` chain once, collecting every signal the rules read. */
function collect(err: unknown): ErrorSignals {
  const signals: ErrorSignals = {
    errno: null,
    exitCode: null,
    mediaToolsUnavailable: false,
    text: '',
  };
  const parts: string[] = [];

  let node: unknown = err;
  // Bounded: a cause chain is 2–3 deep here, and a cycle would otherwise hang
  // the migration on the way to reporting a failure.
  for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth++) {
    if (node instanceof MediaToolsUnavailableError) signals.mediaToolsUnavailable = true;
    const e = node as Error & {
      code?: unknown;
      errno?: unknown;
      stderr?: unknown;
      cause?: unknown;
    };
    if (typeof e.code === 'string' && signals.errno === null && isErrno(e.code)) {
      signals.errno = e.code;
    }
    if (typeof e.code === 'number' && signals.exitCode === null) signals.exitCode = e.code;
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.stderr === 'string') parts.push(e.stderr);
    node = e.cause;
  }

  signals.text = parts.join('\n').toLowerCase();
  return signals;
}

/**
 * Node puts both errnos and its own `ABORT_ERR` / `ERR_*` codes in the same
 * field. Only the errno spelling counts: one leading E, then letters, no
 * underscore — which is exactly what the others have.
 */
function isErrno(code: string): boolean {
  return /^E[A-Z0-9]+$/.test(code);
}
