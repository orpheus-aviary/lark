// The one entry point apply uses: `(entity_type, op, payload)` in, a typed
// discriminated change out, or a typed refusal (§3.1 / §3.8).
//
// Two refusals, deliberately different: a payload that failed validation
// (`PayloadValidationError`) and a change this build has no concept of
// (`UnknownChangeError` — a newer peer, or a corrupted row). Both become
// inbound dead letters and both let the cursor advance, but only the second
// one means "upgrade this device".

import type {
  ClearLyricsSyncPayload,
  PlaylistSongSyncPayload,
  PlaylistSyncPayload,
  ReorderSyncPayload,
  SetLyricsSyncPayload,
  SetRankSyncPayload,
  SongSyncPayload,
  TombstoneSyncPayload,
} from '@lark/shared';
import { asObject, isUuid } from './common.js';
import { parseMembershipPayload, parseSetRankPayload } from './membership.js';
import { parsePlaylistPayload, parseReorderPayload } from './playlist.js';
import { parseSetLyricsPayload, parseSongPayload, parseTombstonePayload } from './song.js';

export * from './common.js';
export * from './membership.js';
export * from './playlist.js';
export * from './song.js';

/** The change names an entity type or op this build does not implement. */
export class UnknownChangeError extends Error {
  readonly entityType: string;
  readonly op: string;
  constructor(entityType: string, op: string) {
    super(`unknown change: ${entityType}.${op}`);
    this.name = 'UnknownChangeError';
    this.entityType = entityType;
    this.op = op;
  }
}

export type ParsedChange =
  | { entityType: 'song'; op: 'create' | 'update'; payload: SongSyncPayload }
  | { entityType: 'song'; op: 'delete'; payload: TombstoneSyncPayload }
  | { entityType: 'song'; op: 'set_lyrics'; payload: SetLyricsSyncPayload }
  | { entityType: 'song'; op: 'clear_lyrics'; payload: ClearLyricsSyncPayload }
  | { entityType: 'playlist'; op: 'create' | 'update'; payload: PlaylistSyncPayload }
  | { entityType: 'playlist'; op: 'delete'; payload: TombstoneSyncPayload }
  | { entityType: 'playlist'; op: 'reorder'; payload: ReorderSyncPayload }
  | { entityType: 'playlist_song'; op: 'create'; payload: PlaylistSongSyncPayload }
  | { entityType: 'playlist_song'; op: 'delete'; payload: TombstoneSyncPayload }
  | { entityType: 'playlist_song'; op: 'set_rank'; payload: SetRankSyncPayload };

export interface RawChange {
  entity_type: string;
  entity_id: string;
  op: string;
  payload: unknown;
}

/** Validate one inbound change. Throws PayloadValidationError / UnknownChangeError. */
export function parseChange(change: RawChange): ParsedChange {
  const { entity_type: type, entity_id: id, op, payload } = change;

  if (type === 'song' || type === 'playlist') {
    if (!isUuid(id)) throw new UnknownChangeError(type, op);
    return type === 'song' ? parseSongChange(op, payload) : parsePlaylistChange(op, payload);
  }
  if (type === 'playlist_song') return parseMembershipChange(id, op, payload);
  throw new UnknownChangeError(type, op);
}

function parseSongChange(op: string, payload: unknown): ParsedChange {
  switch (op) {
    case 'create':
    case 'update':
      return { entityType: 'song', op, payload: parseSongPayload(payload) };
    case 'delete':
      return { entityType: 'song', op, payload: parseTombstonePayload(payload) };
    case 'set_lyrics':
      return { entityType: 'song', op, payload: parseSetLyricsPayload(payload) };
    case 'clear_lyrics':
      // Carries no fields; it still has to BE an object, so a peer sending a
      // string here is a bug worth archiving rather than ignoring.
      asObject(payload);
      return { entityType: 'song', op, payload: {} };
    default:
      throw new UnknownChangeError('song', op);
  }
}

function parsePlaylistChange(op: string, payload: unknown): ParsedChange {
  switch (op) {
    case 'create':
    case 'update':
      return { entityType: 'playlist', op, payload: parsePlaylistPayload(payload) };
    case 'delete':
      return { entityType: 'playlist', op, payload: parseTombstonePayload(payload) };
    case 'reorder':
      return { entityType: 'playlist', op, payload: parseReorderPayload(payload) };
    default:
      throw new UnknownChangeError('playlist', op);
  }
}

function parseMembershipChange(id: string, op: string, payload: unknown): ParsedChange {
  // The composite id is the only thing `delete` and `set_rank` carry about
  // WHICH membership they mean — their payloads name neither parent.
  const [playlistId, songId, ...rest] = id.split(':');
  if (rest.length > 0 || !isUuid(playlistId) || !isUuid(songId)) {
    throw new UnknownChangeError('playlist_song', op);
  }

  switch (op) {
    case 'create':
      return { entityType: 'playlist_song', op, payload: parseMembershipPayload(payload, id) };
    case 'delete':
      return { entityType: 'playlist_song', op, payload: parseTombstonePayload(payload) };
    case 'set_rank':
      return { entityType: 'playlist_song', op, payload: parseSetRankPayload(payload) };
    default:
      throw new UnknownChangeError('playlist_song', op);
  }
}
