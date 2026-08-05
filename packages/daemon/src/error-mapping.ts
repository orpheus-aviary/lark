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

export interface MappedError {
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

/**
 * HTTP status per M3 error code (M3-11).
 *
 * The CODE lives on the core error class and the STATUS lives here, because
 * core has no business knowing about HTTP — and because the same code has to
 * mean the same thing whether it arrives as a response or as a task's
 * `error_code`. A code with no entry here answers 500, which is the safe
 * direction: a new failure mode shows up as a server error rather than
 * silently claiming to be the client's fault.
 */
const M3_STATUS_BY_CODE: Record<string, number> = {
  LLM_NOT_CONFIGURED: 400,
  LLM_FAILED: 502,
  BILIBILI_FAILED: 502,
  BILIBILI_RISK_CONTROL: 502,
  SOURCE_GONE: 410,
  NORMALIZE_FAILED: 502,
  PREFLIGHT_TIMEOUT: 504,
  FFMPEG_FAILED: 500,
  DOWNLOAD_COMMIT_FAILED: 500,
  TASK_NOT_FOUND: 404,
  TASK_NOT_CANCELLABLE: 409,
  SONG_BUSY: 409,
  DOWNLOAD_QUEUE_FULL: 429,
};

/** Map a core business error, or `null` if `err` is not one. */
export function mapCoreError(err: unknown): MappedError | null {
  // M3's classes carry their own code, so this branch needs no per-class list
  // — only the status table above.
  if (err instanceof CodedError) {
    const mapped: MappedError = {
      status: M3_STATUS_BY_CODE[err.code] ?? 500,
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
