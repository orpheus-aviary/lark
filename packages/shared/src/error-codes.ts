// The frozen error-code registries (M6-6).
//
// Two closed sets, deliberately allowed to intersect:
//
//   DAEMON_ENVELOPE_ERROR_CODES — every `error_code` that can appear on an
//     `ApiResponse`. The daemon types its emission sites against it and the
//     CLI maps every member to an exit code, both EXHAUSTIVELY: a new code
//     cannot ship without an HTTP status on one side and an exit code on the
//     other.
//   TASK_ERROR_CODES — every code that can land on a download task's
//     `error_code`. Those live INSIDE a task object, never on the envelope, so
//     they never map to an exit code; a failed task is rendered from the task
//     snapshot instead.
//
// The intersection is real, not an accident: `FFMPEG_FAILED` is what a queued
// download reports when the transcode dies AND what `POST /songs/import`
// answers when ffprobe rejects the file. Modelling them as one set would make
// the CLI's exit map claim codes it can never receive on an envelope; modelling
// them as disjoint would force a lie about one of the two channels.
//
// Why a hand-kept registry rather than scanning the source: an uppercase-string
// scan sweeps in signal names, env vars and SQL keywords, and walking the
// `CodedError` subclasses mixes task-only codes into the envelope set. The
// registry fails just as loudly — at compile time, on both consumers — without
// either failure mode.

/**
 * Every `error_code` the daemon can put on a response envelope.
 *
 * Grouped by where it comes from, alphabetical inside a group. Adding one here
 * turns the daemon's status table and the CLI's exit map red until both are
 * extended, which is the entire point.
 */
export const DAEMON_ENVELOPE_ERROR_CODES = [
  // Gate and global handlers.
  'BAD_REQUEST',
  'HOST_NOT_ALLOWED',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',

  // Request contract (M2-16).
  'INVALID_BODY',
  'INVALID_CONFIG',
  'INVALID_ID',
  'INVALID_QUERY',
  'INVALID_REORDER',
  'INVALID_SOURCE',
  'VIRTUAL_PLAYLIST',

  // Library, media and config persistence.
  'FILE_NOT_FOUND',
  'LYRICS_NOT_FOUND',
  'SAVE_FAILED',
  'SONG_BUSY',
  'SOURCE_KEY_CONFLICT',

  // Playlist transfer (M5-13).
  'IMPORT_SOURCE_CHANGED',
  'INVALID_IMPORT_FILE',
  'INVALID_REUSE',
  'UNSUPPORTED_FORMAT_VERSION',

  // GUI channel and player commands (M2-11).
  'GUI_CAPACITY',
  'GUI_ERROR',
  'GUI_OFFLINE',
  'GUI_REGISTRATION_REQUIRED',
  'GUI_TIMEOUT',
  'SHUTTING_DOWN',

  // Download pipeline (M3-11). Every one of these is also reachable
  // synchronously — a route that normalises a URL or probes an imported file
  // fails the same way a task does.
  'BILIBILI_FAILED',
  'BILIBILI_RISK_CONTROL',
  'DOWNLOAD_COMMIT_FAILED',
  'DOWNLOAD_QUEUE_FULL',
  'FFMPEG_FAILED',
  'LLM_FAILED',
  'LLM_NOT_CONFIGURED',
  // Not a download-only failure despite living in this group: import raises it
  // too. It says "this machine has no usable ffmpeg", which is never a property
  // of the song or the file (M7-18).
  'MEDIA_TOOLS_UNAVAILABLE',
  'NORMALIZE_FAILED',
  'PREFLIGHT_TIMEOUT',
  'SOURCE_GONE',
  'TASK_NOT_CANCELLABLE',
  'TASK_NOT_FOUND',

  // skybridge sync (v0.2). Session and binding first, then the two surfaces a
  // caller can act on directly — conflicts and the file-effect journal.
  'SYNC_AUTH_REQUIRED',
  'SYNC_BINDING_MISMATCH',
  'SYNC_INSECURE_URL',
  'SYNC_PENDING_CHANGES',
  'SYNC_SCHEMA_VERSION_MISMATCH',
  'SYNC_UNAVAILABLE',
  'CONFLICT_NOT_FOUND',
  'CONFLICT_VERSION_MISMATCH',
  'FILE_OP_BUSY',
  'FILE_OP_NOT_FOUND',
  // Not a sync-only code despite arriving with sync: once the same
  // (provider, key) can exist on two songs (D8), every by-key lookup either
  // names the ambiguity or picks a song at random. It names it.
  'AMBIGUOUS_SOURCE_KEY',
] as const;

export type DaemonEnvelopeErrorCode = (typeof DAEMON_ENVELOPE_ERROR_CODES)[number];

/**
 * Every code that can appear on a download task's `error_code` — the closed
 * output domain of core's `describeTaskError`.
 *
 * These never reach `EXIT_MAP`: a failed task arrives inside a successful HTTP
 * response, and the CLI reports it through the task snapshot (`TASK_FAILED`)
 * rather than by translating this code.
 */
export const TASK_ERROR_CODES = [
  // Reachable from a download that reuses a song by key, once a duplicate key
  // can exist at all (D8).
  'AMBIGUOUS_SOURCE_KEY',
  'BILIBILI_FAILED',
  'BILIBILI_RISK_CONTROL',
  // Raised when a conflict resolve loses its race, which no task calls today.
  'CONFLICT_VERSION_MISMATCH',
  'DOWNLOAD_COMMIT_FAILED',
  'DOWNLOAD_QUEUE_FULL',
  'FFMPEG_FAILED',
  // Raised by the sync file-effect runtime, which no task calls today. They
  // are here because `describeTaskError` passes ANY CodedError through
  // verbatim — the registry closes over the classes, not over today's callers.
  'FILE_OP_BUSY',
  'FILE_OP_NOT_FOUND',
  'INTERNAL_ERROR',
  'INVALID_IMPORT_FILE',
  'INVALID_REUSE',
  'INVALID_SOURCE',
  'LLM_FAILED',
  'LLM_NOT_CONFIGURED',
  'MEDIA_TOOLS_UNAVAILABLE',
  'NORMALIZE_FAILED',
  'NOT_FOUND',
  'PREFLIGHT_TIMEOUT',
  'SONG_BUSY',
  'SOURCE_GONE',
  'SOURCE_KEY_CONFLICT',
  'TASK_NOT_CANCELLABLE',
  'TASK_NOT_FOUND',
  'UNSUPPORTED_FORMAT_VERSION',
] as const;

export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

const ENVELOPE_SET: ReadonlySet<string> = new Set(DAEMON_ENVELOPE_ERROR_CODES);
const TASK_SET: ReadonlySet<string> = new Set(TASK_ERROR_CODES);

/**
 * Narrow an arbitrary string to a registered envelope code.
 *
 * The daemon runs everything it is about to send through this, so a code from
 * outside the registry (a Fastify internal like `FST_ERR_CTP_INVALID_MEDIA_TYPE`,
 * or a class added without registering it) degrades to a generic code instead
 * of reaching a client that has no mapping for it.
 */
export function isDaemonEnvelopeErrorCode(
  code: string | undefined,
): code is DaemonEnvelopeErrorCode {
  return code !== undefined && ENVELOPE_SET.has(code);
}

export function isTaskErrorCode(code: string | undefined): code is TaskErrorCode {
  return code !== undefined && TASK_SET.has(code);
}
