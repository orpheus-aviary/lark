// core error class → HTTP envelope mapping (M2-8, class ①).
//
// These are EXPECTED outcomes of a well-formed request (the id is gone, the
// key belongs to another song), not daemon faults: they answer 4xx and must
// not produce an error-level log line, or a GUI hammering a deleted song would
// fill lark.log with noise. Single mapping point so no route invents its own
// status code for the same condition.

import {
  CodedError,
  InvalidIdError,
  InvalidReorderError,
  InvalidSourceError,
  NotFoundError,
  SongBusyError,
  SourceKeyConflictError,
} from '@lark/core';
import { type DaemonEnvelopeErrorCode, isDaemonEnvelopeErrorCode } from '@lark/shared';

export interface MappedError {
  status: number;
  code: DaemonEnvelopeErrorCode;
  details?: Record<string, unknown>;
}

/**
 * The canonical HTTP status of every envelope error code (M3-11, extended by
 * M5-13 and typed against the registry in M6-6).
 *
 * The CODE lives on the core error class and the STATUS lives here, because
 * core has no business knowing about HTTP — and because the same code has to
 * mean the same thing whether it arrives as a response or as a task's
 * `error_code`.
 *
 * `Record<DaemonEnvelopeErrorCode, number>` makes the table EXHAUSTIVE: a code
 * added to the shared registry does not compile until it has a status here and
 * an exit code in the CLI. Routes that call `fail()` with an explicit status
 * pass their own literal — this table is what the mapper below uses, and the
 * documented answer for every code besides.
 */
const STATUS_BY_CODE: Record<DaemonEnvelopeErrorCode, number> = {
  // Gate and global handlers.
  BAD_REQUEST: 400,
  HOST_NOT_ALLOWED: 403,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,

  // Request contract (M2-16) — all "the request you sent is wrong".
  INVALID_BODY: 400,
  INVALID_CONFIG: 400,
  INVALID_ID: 400,
  INVALID_QUERY: 400,
  INVALID_REORDER: 400,
  INVALID_SOURCE: 400,
  VIRTUAL_PLAYLIST: 400,

  // Library, media and config persistence.
  FILE_NOT_FOUND: 404,
  LYRICS_NOT_FOUND: 404,
  SAVE_FAILED: 500,
  SONG_BUSY: 409,
  SOURCE_KEY_CONFLICT: 409,

  // The one-time mp3 → m4a conversion (0.3.0). 503 like SHUTTING_DOWN and for
  // the same reason: the request is fine and this route will exist again in a
  // moment — nothing about it is the caller's to fix.
  AUDIO_MIGRATION_PENDING: 503,

  // Playlist transfer (M5-13): every one of these is "the file or the request
  // you sent cannot be imported", which is the caller's to fix.
  IMPORT_SOURCE_CHANGED: 409,
  INVALID_IMPORT_FILE: 400,
  INVALID_REUSE: 400,
  UNSUPPORTED_FORMAT_VERSION: 400,

  // GUI channel and player commands (M2-11).
  GUI_CAPACITY: 409,
  GUI_ERROR: 502,
  GUI_OFFLINE: 409,
  GUI_REGISTRATION_REQUIRED: 400,
  GUI_TIMEOUT: 504,
  SHUTTING_DOWN: 503,

  // Download pipeline (M3-11).
  BILIBILI_FAILED: 502,
  BILIBILI_RISK_CONTROL: 502,
  DOWNLOAD_COMMIT_FAILED: 500,
  DOWNLOAD_QUEUE_FULL: 429,
  FFMPEG_FAILED: 500,
  LLM_FAILED: 502,
  LLM_NOT_CONFIGURED: 400,
  // 409: the request is well-formed and would be fine on its own — something
  // else is already in the queue under the other naming mode (§3.6-1).
  NAMING_MODE_CONFLICT: 409,
  // 503, not 500: the request was fine and the daemon is fine — a dependency
  // this machine needs is absent, and the caller can retry after installing it.
  MEDIA_TOOLS_UNAVAILABLE: 503,
  NORMALIZE_FAILED: 502,
  PREFLIGHT_TIMEOUT: 504,
  SOURCE_GONE: 410,
  TASK_NOT_CANCELLABLE: 409,
  TASK_NOT_FOUND: 404,

  // skybridge sync (v0.2).
  //
  // 503 for SYNC_AUTH_REQUIRED for the same reason MEDIA_TOOLS_UNAVAILABLE has
  // it: the request was fine, the daemon is fine, and something this install
  // needs is absent until the user acts. It must NOT be 401 — that status is
  // spoken for by the daemon's own bearer token, and every client already
  // reads it as "your daemon token is wrong".
  SYNC_AUTH_REQUIRED: 503,
  // The library is bound elsewhere / the workspace speaks another schema
  // version / there are unsynced changes: state that exists and refuses.
  SYNC_BINDING_MISMATCH: 409,
  SYNC_SCHEMA_VERSION_MISMATCH: 409,
  SYNC_PENDING_CHANGES: 409,
  // The URL you asked us to trust is not https and you did not flip the
  // breaker — the caller's to fix.
  SYNC_INSECURE_URL: 400,
  // Upstream is unreachable or answered 5xx, same shape as the other
  // outbound-dependency failures.
  SYNC_UNAVAILABLE: 502,
  CONFLICT_NOT_FOUND: 404,
  CONFLICT_VERSION_MISMATCH: 409,
  FILE_OP_NOT_FOUND: 404,
  FILE_OP_BUSY: 409,
  AMBIGUOUS_SOURCE_KEY: 409,
};

/** The canonical status for a registered code. */
export function statusForCode(code: DaemonEnvelopeErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** Map a core business error, or `null` if `err` is not one. */
export function mapCoreError(err: unknown): MappedError | null {
  // M3's classes carry their own code, so this branch needs no per-class list
  // — only the status table above.
  if (err instanceof CodedError) {
    // A code outside the registry means a CodedError shipped without being
    // registered: answer 500 with a generic code rather than handing a client
    // a code nothing maps. The registry test enumerates the classes, so this
    // is a backstop, not a path.
    if (!isDaemonEnvelopeErrorCode(err.code)) {
      return { status: 500, code: 'INTERNAL_ERROR' };
    }
    const mapped: MappedError = {
      status: STATUS_BY_CODE[err.code],
      code: err.code,
    };
    if (err instanceof SongBusyError) mapped.details = { song_id: err.songId };
    return mapped;
  }

  if (err instanceof NotFoundError) return { status: 404, code: 'NOT_FOUND' };
  if (err instanceof InvalidIdError) return { status: 400, code: 'INVALID_ID' };
  if (err instanceof InvalidSourceError) return { status: 400, code: 'INVALID_SOURCE' };
  if (err instanceof SourceKeyConflictError) {
    return {
      status: 409,
      code: 'SOURCE_KEY_CONFLICT',
      details: { conflicting_song_id: err.conflictingSongId },
    };
  }
  if (err instanceof InvalidReorderError) return { status: 400, code: 'INVALID_REORDER' };
  return null;
}
