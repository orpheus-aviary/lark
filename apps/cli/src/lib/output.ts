// stdout / stderr discipline (M6-6).
//
// The frozen contract, for `--json` on a business command:
//
//   exit 0  ⇔  stdout holds EXACTLY ONE success envelope, and stderr is empty
//   exit ≠0 ⇔  stdout holds NOTHING, and stderr holds one error envelope
//
// which is what lets a script (or an agent) do `lark … --json && jq …` without
// a second thought. Human mode prints domain text — no stability promised —
// and errors go to stderr as one line. `--help` / `--version` are metacommands
// and print plain text at exit 0; they are the documented exception.
//
// Streams are injected rather than reached for, so a test asserts on the two
// buffers instead of spying on the process.

import type { ApiResponse } from '@lark/shared';
import type { CliError } from './errors.js';

export interface Streams {
  out(line: string): void;
  err(line: string): void;
  /**
   * Replace the stderr line in place, with NO newline — a progress line that
   * is about to be replaced again (0.3.0 §3.5). `''` clears it, which is how a
   * caller ends one without leaving a stale percentage on screen.
   *
   * On stderr like `err`, and for the same reason: stdout carries the one
   * envelope, and a `--json` run must not find a progress line in it.
   */
  errLine(text: string): void;
  /** Is stderr a terminal? Only there does overwriting a line mean anything. */
  tty: boolean;
}

export const processStreams: Streams = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  // `\r` to column 0 and `\x1b[K` to wipe what was there: without the erase, a
  // shorter line leaves the tail of the longer one behind it.
  errLine: (text) => process.stderr.write(`\r\x1b[K${text}`),
  tty: process.stderr.isTTY === true,
};

export interface CapturedStreams extends Streams {
  stdout: string[];
  stderr: string[];
  /** Every `errLine` write, in order — the overwriting is not simulated. */
  stderrLive: string[];
}

/** Collects both streams; the shape every command test asserts on. */
export function captureStreams(options: { tty?: boolean } = {}): CapturedStreams {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stderrLive: string[] = [];
  return {
    stdout,
    stderr,
    stderrLive,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    errLine: (text) => stderrLive.push(text),
    tty: options.tty === true,
  };
}

export interface OutputOptions {
  json: boolean;
}

/**
 * Print a success envelope in `--json` mode.
 *
 * HTTP results are printed VERBATIM (structure preserved, including `message`
 * and `total`), so `--json` reports what the daemon said rather than a
 * re-serialisation of it; direct and local results arrive already shaped like
 * an envelope from their command.
 */
export function emitEnvelope<T>(streams: Streams, envelope: ApiResponse<T>): void {
  streams.out(JSON.stringify(envelope));
}

/** Compose a success envelope for a result the CLI produced itself. */
export function successEnvelope<T>(
  data: T,
  extra: { message?: string; total?: number } = {},
): ApiResponse<T> {
  const envelope: ApiResponse<T> = { success: true, data };
  // An absent message stays absent: `"message": undefined` would serialise
  // away anyway, but an empty string would not, and a consumer branching on
  // its presence should see the truth.
  if (extra.message !== undefined) envelope.message = extra.message;
  if (extra.total !== undefined) envelope.total = extra.total;
  return envelope;
}

/** Render a failure: an envelope on stderr under `--json`, one line otherwise. */
export function emitError(streams: Streams, err: CliError, opts: OutputOptions): void {
  if (opts.json) {
    const envelope: ApiResponse<never> = {
      success: false,
      error_code: err.code,
      message: err.message,
    };
    if (err.details !== undefined) envelope.details = err.details;
    streams.err(JSON.stringify(envelope));
    return;
  }
  streams.err(`lark: ${err.message} (${err.code})`);
}
