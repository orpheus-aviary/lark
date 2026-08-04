// core error class → HTTP envelope mapping (M2-8, class ①).
//
// These are EXPECTED outcomes of a well-formed request (the id is gone, the
// key belongs to another song), not daemon faults: they answer 4xx and must
// not produce an error-level log line, or a GUI hammering a deleted song would
// fill lark.log with noise. Single mapping point so no route invents its own
// status code for the same condition.

import {
  InvalidIdError,
  InvalidReorderError,
  InvalidSourceError,
  NotFoundError,
  SourceKeyConflictError,
} from '@lark/core';

export interface MappedError {
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

/** Map a core business error, or `null` if `err` is not one. */
export function mapCoreError(err: unknown): MappedError | null {
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
