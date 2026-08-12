// song payloads: the LWW put, the tombstone, and the two lyrics ops (§3.1).

import {
  SONG_ARTIST_MAX,
  SONG_NAME_MAX,
  SONG_SOURCE_KEY_MAX,
  SONG_SOURCE_PROVIDER_MAX,
  SONG_SOURCE_URL_MAX,
  SYNC_FILE_OP_INLINE_MAX,
  type SetLyricsSyncPayload,
  type SongSyncPayload,
  type TombstoneSyncPayload,
} from '@lark/shared';
import { InvalidSourceError } from '../../errors.js';
import { normalizeSource } from '../../library/source.js';
import {
  PayloadValidationError,
  asObject,
  reqFinite,
  reqLwwFields,
  reqNullableString,
  reqSafeInt,
  reqString,
} from './common.js';

/**
 * A full song state from a peer.
 *
 * The source triple goes through the SAME `normalizeSource` the local API
 * uses — provider whitelist, key syntax, the paired-or-neither invariant. A
 * peer cannot write a shape this build would refuse from its own user, which
 * is the entire reason those bounds moved into @lark/shared.
 */
export function parseSongPayload(raw: unknown): SongSyncPayload {
  const obj = asObject(raw);
  const source = parseSource(obj);
  const lww = reqLwwFields(obj);
  return {
    name: reqString(obj, 'name', { maxLength: SONG_NAME_MAX }),
    artist: reqString(obj, 'artist', { maxLength: SONG_ARTIST_MAX, allowEmpty: true }),
    ...source,
    lyrics_offset: reqFinite(obj, 'lyrics_offset'),
    duration: reqFinite(obj, 'duration', { min: 0 }),
    created_at_ms: reqSafeInt(obj, 'created_at_ms', { min: 0 }),
    ...lww,
  };
}

function parseSource(obj: Record<string, unknown>): {
  source_url: string | null;
  source_provider: string | null;
  source_key: string | null;
} {
  const raw = {
    source_url: reqNullableString(obj, 'source_url', {
      maxLength: SONG_SOURCE_URL_MAX,
      allowEmpty: true,
    }),
    source_provider: reqNullableString(obj, 'source_provider', {
      maxLength: SONG_SOURCE_PROVIDER_MAX,
    }),
    source_key: reqNullableString(obj, 'source_key', { maxLength: SONG_SOURCE_KEY_MAX }),
  };
  try {
    return normalizeSource(raw);
  } catch (err) {
    if (err instanceof InvalidSourceError) {
      throw new PayloadValidationError('source', err.message);
    }
    throw err;
  }
}

/** A delete: just the key that has to beat the local state. */
export function parseTombstonePayload(raw: unknown): TombstoneSyncPayload {
  return reqLwwFields(asObject(raw));
}

/**
 * `set_lyrics`. The body is bounded by the journal's inline limit rather than
 * by the emit guard: anything that arrived inside a legal change already fits,
 * and this is the number that decides whether it can be written down at all.
 */
export function parseSetLyricsPayload(raw: unknown): SetLyricsSyncPayload {
  const obj = asObject(raw);
  return {
    lrc: reqString(obj, 'lrc', { maxLength: SYNC_FILE_OP_INLINE_MAX, allowEmpty: true }),
  };
}
