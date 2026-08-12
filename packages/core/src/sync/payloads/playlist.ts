// playlist payloads: the LWW put and the `reorder` metadata op (§3.1).

import { PLAYLIST_NAME_MAX, type PlaylistSyncPayload, type ReorderSyncPayload } from '@lark/shared';
import {
  PayloadValidationError,
  asObject,
  isUuid,
  reqLwwFields,
  reqSafeInt,
  reqString,
} from './common.js';

export function parsePlaylistPayload(raw: unknown): PlaylistSyncPayload {
  const obj = asObject(raw);
  return {
    name: reqString(obj, 'name', { maxLength: PLAYLIST_NAME_MAX }),
    created_at_ms: reqSafeInt(obj, 'created_at_ms', { min: 0 }),
    ...reqLwwFields(obj),
  };
}

/**
 * `reorder` — the full membership order after a normalization.
 *
 * No length cap here beyond what the transport already enforces: the emitting
 * side degrades to per-row `set_rank` past REORDER_SYNC_MAX, so a list longer
 * than that came from a peer with different limits, and rejecting it would
 * leave that playlist permanently out of order on this device. Duplicate and
 * unknown ids are handled at apply (first occurrence wins, unknown ignored),
 * because both are legitimate mid-sync states rather than corruption.
 */
export function parseReorderPayload(raw: unknown): ReorderSyncPayload {
  const obj = asObject(raw);
  const ids = obj.song_ids;
  if (!Array.isArray(ids)) throw new PayloadValidationError('song_ids', 'must be an array');
  for (const [index, id] of ids.entries()) {
    if (!isUuid(id)) throw new PayloadValidationError(`song_ids[${index}]`, 'must be a UUIDv4');
  }
  return { song_ids: ids as string[] };
}
