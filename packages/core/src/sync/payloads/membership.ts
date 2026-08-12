// playlist_song payloads: the existence put and `set_rank` (§3.1, R4-2).

import type { PlaylistSongSyncPayload, SetRankSyncPayload } from '@lark/shared';
import {
  PayloadValidationError,
  asObject,
  reqFinite,
  reqLwwFields,
  reqSafeInt,
  reqUuid,
} from './common.js';

/**
 * Membership existence. Note what is NOT here: `rank`. A rank on this payload
 * would be a second channel for the same value, and LWW puts are skipped on
 * their own echo while `set_rank` is replayed — so the emitting device and its
 * peers would end up applying different orders from the same pair of changes
 * (R4-2). Every add emits this AND a `set_rank`, in that order.
 *
 * `entityId` is checked against the payload: the composite id is the primary
 * key on the other side, so a mismatch means one of the two is a lie and there
 * is no way to tell which.
 */
export function parseMembershipPayload(raw: unknown, entityId: string): PlaylistSongSyncPayload {
  const obj = asObject(raw);
  const playlist_id = reqUuid(obj, 'playlist_id');
  const song_id = reqUuid(obj, 'song_id');
  if (entityId !== `${playlist_id}:${song_id}`) {
    throw new PayloadValidationError(
      'entity_id',
      `does not match the payload pair (${playlist_id}:${song_id})`,
    );
  }
  return {
    playlist_id,
    song_id,
    added_at_ms: reqSafeInt(obj, 'added_at_ms', { min: 0 }),
    ...reqLwwFields(obj),
  };
}

/** `set_rank` — a sparse rank, so a real rather than an integer. */
export function parseSetRankPayload(raw: unknown): SetRankSyncPayload {
  return { rank: reqFinite(asObject(raw), 'rank') };
}
