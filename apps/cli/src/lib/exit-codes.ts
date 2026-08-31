// Exit codes (M6-6).
//
// A `lark` invocation is something a script or an agent branches on, so the
// exit code is part of the contract — and the mapping is EXHAUSTIVE by
// construction: `EXIT_MAP` is typed over every code in the shared envelope
// registry plus every local code, so a code added on either side fails to
// compile until it has been given a meaning here.
//
// The seven values, and what a caller should do about them:
//
//   0   it worked
//   1   the operation failed for a reason that is nobody's fault to fix here
//       (not found, the download failed, the GUI errored)
//   2   the command was wrong — arguments, ids, file contents. Retrying it
//       unchanged cannot help.
//   3   the environment says no: no token, unsafe config permissions, no
//       library yet, a native module built for the other runtime.
//   4   nothing is listening. Start a daemon (or pass `--direct` for a read).
//   5   something IS listening, or holding a lock, and refuses. This is the
//       "another instance / another nest / migration needed" family.
//   130 interrupted (Ctrl-C, or a confirmation answered "no").

import { DAEMON_ENVELOPE_ERROR_CODES, type DaemonEnvelopeErrorCode } from '@lark/shared';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_NO_DAEMON = 4;
export const EXIT_REFUSED = 5;
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_FAILED
  | typeof EXIT_USAGE
  | typeof EXIT_ENVIRONMENT
  | typeof EXIT_NO_DAEMON
  | typeof EXIT_REFUSED
  | typeof EXIT_INTERRUPTED;

/**
 * Codes the CLI raises on its own — no daemon involved.
 *
 * Deliberately separate from the wire registry: these describe the CLI's own
 * decisions (a refused mode, a wait that outlived the task ring, a
 * confirmation answered "no"), and the daemon has no business emitting them.
 */
export const LOCAL_CLI_ERROR_CODES = [
  // Argument / usage layer.
  'USAGE_ERROR',
  'INTERRUPTED',

  // Reaching the daemon (or deciding not to).
  'DAEMON_UNAVAILABLE',
  'DAEMON_RUNNING_BLOCKED',
  'DAEMON_INCOMPATIBLE',
  'DAEMON_UNVERIFIED',
  'DAEMON_OTHER_NEST',
  'WRITER_BUSY',

  // Environment.
  'ABI_MISMATCH',
  'CONFIG_UNSAFE_PERMISSIONS',
  'DB_NOT_INITIALIZED',
  'NEST_NOT_WRITABLE',

  // Opening the library directly (`--direct`).
  'MIGRATION_REQUIRED',
  'MIGRATION_PENDING',
  'MIGRATION_BUSY',
  'MIGRATION_FAILED',
  'MIGRATION_RESIDUE',
  'INCOMPATIBLE_DB',
  'SCHEMA_MISMATCH',
  'WORKSPACE_SWITCHING',

  // Resolving a `<name|id>` argument (R25).
  'AMBIGUOUS_SONG',
  'AMBIGUOUS_PLAYLIST',

  // Download / wait outcomes the CLI decides (M6-11).
  'LIST_TOO_LARGE',
  'TASK_STATE_UNKNOWN',
  'TASK_FAILED',
  'TASK_CANCELLED',
  'BATCH_PARTIAL_FAILURE',

  // Transport fallbacks.
  'INVALID_RESPONSE',
  'HTTP_ERROR',
  'UNKNOWN',
] as const;

export type LocalCliErrorCode = (typeof LOCAL_CLI_ERROR_CODES)[number];

/** Everything the CLI can report, from either side. */
export type CliErrorCode = DaemonEnvelopeErrorCode | LocalCliErrorCode;

/**
 * Every code, mapped. `Record<CliErrorCode, ExitCode>` is what makes this
 * exhaustive: adding a code to either registry breaks the build here first.
 */
export const EXIT_MAP: Record<CliErrorCode, ExitCode> = {
  // ── 1: the operation failed ──────────────────────────
  NOT_FOUND: EXIT_FAILED,
  FILE_NOT_FOUND: EXIT_FAILED,
  LYRICS_NOT_FOUND: EXIT_FAILED,
  TASK_NOT_FOUND: EXIT_FAILED,
  GUI_ERROR: EXIT_FAILED,
  GUI_TIMEOUT: EXIT_FAILED,
  GUI_CAPACITY: EXIT_FAILED,
  DOWNLOAD_QUEUE_FULL: EXIT_FAILED,
  TASK_NOT_CANCELLABLE: EXIT_FAILED,
  IMPORT_SOURCE_CHANGED: EXIT_FAILED,
  UNSUPPORTED_FORMAT_VERSION: EXIT_FAILED,
  SAVE_FAILED: EXIT_FAILED,
  LIST_TOO_LARGE: EXIT_FAILED,
  TASK_STATE_UNKNOWN: EXIT_FAILED,
  TASK_FAILED: EXIT_FAILED,
  TASK_CANCELLED: EXIT_FAILED,
  BATCH_PARTIAL_FAILURE: EXIT_FAILED,
  INVALID_RESPONSE: EXIT_FAILED,
  HOST_NOT_ALLOWED: EXIT_FAILED,
  BILIBILI_FAILED: EXIT_FAILED,
  BILIBILI_RISK_CONTROL: EXIT_FAILED,
  NORMALIZE_FAILED: EXIT_FAILED,
  PREFLIGHT_TIMEOUT: EXIT_FAILED,
  SOURCE_GONE: EXIT_FAILED,
  LLM_FAILED: EXIT_FAILED,
  FFMPEG_FAILED: EXIT_FAILED,
  DOWNLOAD_COMMIT_FAILED: EXIT_FAILED,
  INTERNAL_ERROR: EXIT_FAILED,
  HTTP_ERROR: EXIT_FAILED,
  UNKNOWN: EXIT_FAILED,
  // Sync outcomes nobody can fix from the command line: the server is down,
  // or the row you named is gone.
  SYNC_UNAVAILABLE: EXIT_FAILED,
  CONFLICT_NOT_FOUND: EXIT_FAILED,
  FILE_OP_NOT_FOUND: EXIT_FAILED,

  // ── 2: the command was wrong ─────────────────────────
  USAGE_ERROR: EXIT_USAGE,
  INVALID_BODY: EXIT_USAGE,
  INVALID_QUERY: EXIT_USAGE,
  INVALID_ID: EXIT_USAGE,
  INVALID_CONFIG: EXIT_USAGE,
  INVALID_SOURCE: EXIT_USAGE,
  // 2, NOT 3: nothing is missing from this machine. The link named a video
  // with several parts and did not say which — `?p=` or `--part` answers it
  // (0.5.1). Sending it to the environment group would point at the settings
  // page, which is where the old LLM_NOT_CONFIGURED wrongly pointed.
  MULTI_PART_UNRESOLVED: EXIT_USAGE,
  INVALID_IMPORT_FILE: EXIT_USAGE,
  INVALID_REUSE: EXIT_USAGE,
  INVALID_REORDER: EXIT_USAGE,
  VIRTUAL_PLAYLIST: EXIT_USAGE,
  BAD_REQUEST: EXIT_USAGE,
  // Only a GUI can trigger this one; it is still a malformed request.
  GUI_REGISTRATION_REQUIRED: EXIT_USAGE,
  // `--clean-name` on a video that is already queued as `--no-clean-name` (or
  // the other way round). Retrying it unchanged cannot help either: the fix is
  // to wait for the queued one, or drop the flag.
  NAMING_MODE_CONFLICT: EXIT_USAGE,
  // `lark sync login http://…` without `--allow-insecure-http`: the command
  // was wrong, and retrying it unchanged cannot help.
  SYNC_INSECURE_URL: EXIT_USAGE,

  // ── 3: the environment says no ───────────────────────
  UNAUTHORIZED: EXIT_ENVIRONMENT,
  LLM_NOT_CONFIGURED: EXIT_ENVIRONMENT,
  // Same shape as LLM_NOT_CONFIGURED: the request was fine, this machine is
  // missing a dependency, and the fix is an install rather than a retry.
  MEDIA_TOOLS_UNAVAILABLE: EXIT_ENVIRONMENT,
  // Literally the "no token" case in the list above: run `lark sync login`.
  SYNC_AUTH_REQUIRED: EXIT_ENVIRONMENT,
  ABI_MISMATCH: EXIT_ENVIRONMENT,
  CONFIG_UNSAFE_PERMISSIONS: EXIT_ENVIRONMENT,
  DB_NOT_INITIALIZED: EXIT_ENVIRONMENT,
  NEST_NOT_WRITABLE: EXIT_ENVIRONMENT,

  // ── 4: nothing is listening ──────────────────────────
  DAEMON_UNAVAILABLE: EXIT_NO_DAEMON,
  GUI_OFFLINE: EXIT_NO_DAEMON,
  SHUTTING_DOWN: EXIT_NO_DAEMON,

  // ── 5: something is there, and refuses ───────────────
  DAEMON_RUNNING_BLOCKED: EXIT_REFUSED,
  WRITER_BUSY: EXIT_REFUSED,
  DAEMON_INCOMPATIBLE: EXIT_REFUSED,
  DAEMON_UNVERIFIED: EXIT_REFUSED,
  DAEMON_OTHER_NEST: EXIT_REFUSED,
  SOURCE_KEY_CONFLICT: EXIT_REFUSED,
  SONG_BUSY: EXIT_REFUSED,
  AMBIGUOUS_PLAYLIST: EXIT_REFUSED,
  AMBIGUOUS_SONG: EXIT_REFUSED,
  MIGRATION_REQUIRED: EXIT_REFUSED,
  MIGRATION_PENDING: EXIT_REFUSED,
  // The one-time mp3 → m4a conversion is still running (0.3.0). Same family:
  // something is there and refuses — and unlike the environment codes, waiting
  // is the fix.
  AUDIO_MIGRATION_PENDING: EXIT_REFUSED,
  MIGRATION_BUSY: EXIT_REFUSED,
  // Another process is moving a whole library into place (N7c). Same family as
  // the two above: something is there, it refuses, and waiting is the fix —
  // this one takes seconds.
  WORKSPACE_SWITCHING: EXIT_REFUSED,
  INCOMPATIBLE_DB: EXIT_REFUSED,
  SCHEMA_MISMATCH: EXIT_REFUSED,
  MIGRATION_RESIDUE: EXIT_REFUSED,
  MIGRATION_FAILED: EXIT_REFUSED,
  // Sync's refusals, all of the same family: something is bound, in flight, or
  // ambiguous, and answering would mean guessing on the user's behalf.
  SYNC_BINDING_MISMATCH: EXIT_REFUSED,
  SYNC_SCHEMA_VERSION_MISMATCH: EXIT_REFUSED,
  SYNC_PENDING_CHANGES: EXIT_REFUSED,
  CONFLICT_VERSION_MISMATCH: EXIT_REFUSED,
  CONFLICT_PAYLOAD_UNAVAILABLE: EXIT_REFUSED,
  FILE_OP_BUSY: EXIT_REFUSED,
  AMBIGUOUS_SOURCE_KEY: EXIT_REFUSED,

  // ── 130: interrupted ─────────────────────────────────
  INTERRUPTED: EXIT_INTERRUPTED,
};

const KNOWN: ReadonlySet<string> = new Set<string>([
  ...DAEMON_ENVELOPE_ERROR_CODES,
  ...LOCAL_CLI_ERROR_CODES,
]);

export function isCliErrorCode(code: string | undefined): code is CliErrorCode {
  return code !== undefined && KNOWN.has(code);
}

/** The exit code for a reported error. Unknown codes are a generic failure. */
export function exitCodeFor(code: string | undefined): ExitCode {
  return isCliErrorCode(code) ? EXIT_MAP[code] : EXIT_FAILED;
}
