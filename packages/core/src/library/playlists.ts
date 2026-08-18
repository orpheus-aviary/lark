// Playlists CRUD + membership + reorder (T4). core does not know 'all' — the
// virtual all-songs view is an API-layer literal (R3); M2 maps it to
// listSongs and rejects writes. Membership changes never bump the OWNING
// playlist row's LWW (cross-entity decoupling, M1-5).

import { type PlaylistData, type SongData, membershipEntityId } from '@lark/shared';
import { and, count, eq } from 'drizzle-orm';
import { InvalidReorderError, NotFoundError } from '../errors.js';
import type { PortableDb, PortableDrizzle } from '../portable/db.js';
import { uuid } from '../portable/runtime/random.js';
import {
  type PlaylistRow,
  type PlaylistSongRow,
  playlist_songs,
  playlists,
  songs,
} from '../portable/schema.js';
import type { SqliteLike } from '../portable/sqlite.js';
import { emitSyncChange } from '../sync/changes.js';
import { readSkybridgeDeviceId } from '../sync/device.js';
import { nextSyncStamp } from '../sync/hlc.js';
import { makeLwwTriple } from '../sync/lww.js';
import { writeTombstone } from '../sync/tombstones.js';
import { RANK_STEP, midpointRank, normalizeRanksInTx, setRankInTx } from './rank.js';

export interface ReorderAnchors {
  /** The moved song lands immediately BEFORE this member. */
  before_song_id?: string;
  /** The moved song lands immediately AFTER this member. */
  after_song_id?: string;
}

function toPlaylistData(row: PlaylistRow, song_count?: number): PlaylistData {
  const data: PlaylistData = {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (song_count !== undefined) data.song_count = song_count;
  return data;
}

function getPlaylistRow(db: PortableDrizzle, id: string): PlaylistRow {
  const row = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!row) throw new NotFoundError('playlist', id);
  return row;
}

export function createPlaylistInTx(store: PortableDb, name: string): PlaylistData {
  const { drizzle: db, sqlite } = store;
  const stamp = nextSyncStamp(sqlite);
  const row: PlaylistRow = {
    id: uuid(),
    name,
    created_at: stamp.updated_at,
    updated_at: stamp.updated_at,
    device_id: readSkybridgeDeviceId(sqlite),
    lww_counter: stamp.lww_counter,
  };
  db.insert(playlists).values(row).run();
  emitSyncChange(sqlite, {
    entityType: 'playlist',
    entityId: row.id,
    op: 'create',
    payload: {
      name: row.name,
      created_at_ms: row.created_at,
      updated_at_ms: row.updated_at,
      lww_counter: row.lww_counter,
    },
  });
  return toPlaylistData(row, 0);
}

export function createPlaylist(store: PortableDb, name: string): PlaylistData {
  // Transactional since v0.2 — the row and its change row are one write now.
  return store.sqlite.transaction(() => createPlaylistInTx(store, name)).immediate();
}

export function renamePlaylistInTx(store: PortableDb, id: string, name: string): PlaylistData {
  const { drizzle: db, sqlite } = store;
  const prev = getPlaylistRow(db, id);
  const stamp = nextSyncStamp(sqlite);
  const deviceId = readSkybridgeDeviceId(sqlite);
  db.update(playlists)
    .set({
      name,
      updated_at: stamp.updated_at,
      lww_counter: stamp.lww_counter,
      device_id: deviceId,
    })
    .where(eq(playlists.id, id))
    .run();
  emitSyncChange(sqlite, {
    entityType: 'playlist',
    entityId: id,
    op: 'update',
    payload: {
      name,
      created_at_ms: prev.created_at,
      updated_at_ms: stamp.updated_at,
      lww_counter: stamp.lww_counter,
    },
  });
  return toPlaylistData({ ...prev, name, ...stamp, device_id: deviceId });
}

export function renamePlaylist(store: PortableDb, id: string, name: string): PlaylistData {
  return store.sqlite.transaction(() => renamePlaylistInTx(store, id, name)).immediate();
}

export function deletePlaylistInTx(store: PortableDb, id: string): void {
  const { drizzle: db, sqlite } = store;
  getPlaylistRow(db, id);
  const stamp = nextSyncStamp(sqlite);
  const deviceId = readSkybridgeDeviceId(sqlite);

  // FK ON DELETE CASCADE prunes playlist_songs. Those memberships get no
  // tombstones and emit nothing: a peer applying the playlist's delete
  // cascades its own copies, and a per-member delete would then be a change
  // about an entity whose parent is already gone (§3.2).
  db.delete(playlists).where(eq(playlists.id, id)).run();

  writeTombstone(
    sqlite,
    'playlist',
    id,
    makeLwwTriple(stamp.updated_at, stamp.lww_counter, deviceId),
    stamp.updated_at,
  );
  emitSyncChange(sqlite, {
    entityType: 'playlist',
    entityId: id,
    op: 'delete',
    payload: { updated_at_ms: stamp.updated_at, lww_counter: stamp.lww_counter },
  });
}

export function deletePlaylist(store: PortableDb, id: string): void {
  store.sqlite.transaction(() => deletePlaylistInTx(store, id)).immediate();
}

/** One playlist with its member count. Throws NotFoundError when absent. */
export function getPlaylist(db: PortableDrizzle, _sqlite: SqliteLike, id: string): PlaylistData {
  const row = getPlaylistRow(db, id);
  const counted = db
    .select({ song_count: count(playlist_songs.song_id) })
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, id))
    .get();
  return toPlaylistData(row, counted?.song_count ?? 0);
}

/** All playlists with their member counts, ordered by (created_at, id). */
export function listPlaylists(db: PortableDrizzle, _sqlite: SqliteLike): PlaylistData[] {
  const rows = db
    .select({
      playlist: playlists,
      song_count: count(playlist_songs.song_id),
    })
    .from(playlists)
    .leftJoin(playlist_songs, eq(playlists.id, playlist_songs.playlist_id))
    .groupBy(playlists.id)
    .orderBy(playlists.created_at, playlists.id)
    .all();
  return rows.map((r) => toPlaylistData(r.playlist, r.song_count));
}

/** Member songs in playlist order — ORDER BY rank, song_id (R23). */
export function getPlaylistSongs(
  db: PortableDrizzle,
  _sqlite: SqliteLike,
  playlistId: string,
): SongData[] {
  getPlaylistRow(db, playlistId);
  const rows = db
    .select({ song: songs })
    .from(playlist_songs)
    .innerJoin(songs, eq(playlist_songs.song_id, songs.id))
    .where(eq(playlist_songs.playlist_id, playlistId))
    .orderBy(playlist_songs.rank, playlist_songs.song_id)
    .all();
  return rows.map((r) => ({
    id: r.song.id,
    name: r.song.name,
    artist: r.song.artist,
    source_url: r.song.source_url,
    source_provider: r.song.source_provider,
    source_key: r.song.source_key,
    file_origin: r.song.file_origin,
    lyrics_offset: r.song.lyrics_offset,
    duration: r.song.duration,
    pinned: r.song.pinned,
    created_at: r.song.created_at,
    updated_at: r.song.updated_at,
  }));
}

/**
 * Append songs at the playlist tail in the given order. Existing members are
 * silently skipped (Go semantics / R27 import-append). Returns the number of
 * memberships actually added.
 */
export function addSongsToPlaylistInTx(
  store: PortableDb,
  playlistId: string,
  songIds: readonly string[],
): number {
  const { drizzle: db, sqlite } = store;
  getPlaylistRow(db, playlistId);

  const members = db
    .select({ song_id: playlist_songs.song_id, rank: playlist_songs.rank })
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, playlistId))
    .all();
  const existing = new Set(members.map((m) => m.song_id));
  let tail = members.reduce((max, m) => Math.max(max, m.rank), 0);

  let added = 0;
  for (const songId of songIds) {
    const song = db.select({ id: songs.id }).from(songs).where(eq(songs.id, songId)).get();
    if (!song) throw new NotFoundError('song', songId);
    if (existing.has(songId)) continue;
    tail += RANK_STEP;
    const stamp = nextSyncStamp(sqlite);
    db.insert(playlist_songs)
      .values({
        playlist_id: playlistId,
        song_id: songId,
        rank: tail,
        added_at: stamp.updated_at,
        updated_at: stamp.updated_at,
        device_id: readSkybridgeDeviceId(sqlite),
        lww_counter: stamp.lww_counter,
      })
      .run();
    // A PAIR, in this order, with consecutive local_seq (R4-2): `create` says
    // the membership exists and carries no rank at all, `set_rank` decides
    // where it sits. One change carrying both would put rank in the LWW
    // channel, which the emitting device never replays — so its peers would
    // adopt the rank in the payload and it would not, and the two orders drift
    // apart from a single add.
    emitSyncChange(sqlite, {
      entityType: 'playlist_song',
      entityId: membershipEntityId(playlistId, songId),
      op: 'create',
      payload: {
        playlist_id: playlistId,
        song_id: songId,
        added_at_ms: stamp.updated_at,
        updated_at_ms: stamp.updated_at,
        lww_counter: stamp.lww_counter,
      },
    });
    emitSyncChange(sqlite, {
      entityType: 'playlist_song',
      entityId: membershipEntityId(playlistId, songId),
      op: 'set_rank',
      payload: { rank: tail },
    });
    existing.add(songId);
    added++;
  }
  return added;
}

export function addSongsToPlaylist(
  store: PortableDb,
  playlistId: string,
  songIds: readonly string[],
): number {
  return store.sqlite
    .transaction(() => addSongsToPlaylistInTx(store, playlistId, songIds))
    .immediate();
}

export function removeSongFromPlaylistInTx(
  store: PortableDb,
  playlistId: string,
  songId: string,
): void {
  const { drizzle: db, sqlite } = store;
  const res = db
    .delete(playlist_songs)
    .where(and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, songId)))
    .run();
  if (res.changes === 0) throw new NotFoundError('playlist_song', songId);

  const stamp = nextSyncStamp(sqlite);
  const entityId = membershipEntityId(playlistId, songId);
  // Unlike a cascade, this membership gets a tombstone: re-adding the song
  // later is an ordinary thing to do, and the tombstone is what an incoming
  // older `create` has to beat before it may revive the row (§3.2).
  writeTombstone(
    sqlite,
    'playlist_song',
    entityId,
    makeLwwTriple(stamp.updated_at, stamp.lww_counter, readSkybridgeDeviceId(sqlite)),
    stamp.updated_at,
  );
  emitSyncChange(sqlite, {
    entityType: 'playlist_song',
    entityId,
    op: 'delete',
    payload: { updated_at_ms: stamp.updated_at, lww_counter: stamp.lww_counter },
  });
}

export function removeSongFromPlaylist(
  store: PortableDb,
  playlistId: string,
  songId: string,
): void {
  // Transactional since v0.2 — row, tombstone and change commit together.
  store.sqlite.transaction(() => removeSongFromPlaylistInTx(store, playlistId, songId)).immediate();
}

function orderedMembers(db: PortableDrizzle, playlistId: string): PlaylistSongRow[] {
  return db
    .select()
    .from(playlist_songs)
    .where(eq(playlist_songs.playlist_id, playlistId))
    .orderBy(playlist_songs.rank, playlist_songs.song_id)
    .all();
}

/**
 * Reorder contract (T4, final): anchors are located AFTER excluding the moved
 * row from the sequence.
 *
 *   - both anchors     → both must exist in this playlist and be adjacent
 *                        (after immediately preceding before); take midpoint
 *   - only before      → land before it (head → its rank − RANK_STEP)
 *   - only after       → land after it (tail → its rank + RANK_STEP)
 *   - neither          → InvalidReorderError (meaningless)
 *   - missing / cross-playlist anchor → NotFoundError; non-adjacent →
 *     InvalidReorderError. Never guess intent.
 *
 * Midpoint exhaustion renormalizes the playlist in the same transaction and
 * recomputes. LWW: the midpoint path bumps only the moved row; normalization
 * bumps every row whose rank actually changed (M1-5).
 */
export function reorderSongInTx(
  store: PortableDb,
  playlistId: string,
  songId: string,
  anchors: ReorderAnchors,
): void {
  const { drizzle: db } = store;
  getPlaylistRow(db, playlistId);
  const { before_song_id, after_song_id } = anchors;
  if (before_song_id === undefined && after_song_id === undefined) {
    throw new InvalidReorderError('reorder needs before_song_id and/or after_song_id');
  }

  // The moved row's own LWW stamp is no longer part of the answer — rank is a
  // metadata op now — so this only computes where the song lands.
  const locate = (): { target: number | null } => {
    const members = orderedMembers(db, playlistId);
    if (!members.some((m) => m.song_id === songId)) {
      throw new NotFoundError('playlist_song', songId);
    }
    const rest = members.filter((m) => m.song_id !== songId);

    let lower: PlaylistSongRow | null;
    let upper: PlaylistSongRow | null;
    if (before_song_id !== undefined && after_song_id !== undefined) {
      const beforeIdx = rest.findIndex((m) => m.song_id === before_song_id);
      if (beforeIdx === -1) throw new NotFoundError('playlist_song', before_song_id);
      const afterIdx = rest.findIndex((m) => m.song_id === after_song_id);
      if (afterIdx === -1) throw new NotFoundError('playlist_song', after_song_id);
      if (afterIdx + 1 !== beforeIdx) {
        throw new InvalidReorderError(
          'after_song_id must sit immediately before before_song_id (excluding the moved song)',
        );
      }
      lower = rest[afterIdx];
      upper = rest[beforeIdx];
    } else if (before_song_id !== undefined) {
      const beforeIdx = rest.findIndex((m) => m.song_id === before_song_id);
      if (beforeIdx === -1) throw new NotFoundError('playlist_song', before_song_id);
      upper = rest[beforeIdx];
      lower = beforeIdx > 0 ? rest[beforeIdx - 1] : null;
    } else {
      const afterIdx = rest.findIndex((m) => m.song_id === after_song_id);
      if (afterIdx === -1) throw new NotFoundError('playlist_song', after_song_id as string);
      lower = rest[afterIdx];
      upper = afterIdx + 1 < rest.length ? rest[afterIdx + 1] : null;
    }

    if (lower === null && upper === null) {
      // rest empty means the anchor lookups above already threw
      throw new InvalidReorderError('nothing to reorder against');
    }
    let target: number | null;
    if (lower === null) {
      target = (upper as PlaylistSongRow).rank - RANK_STEP;
    } else if (upper === null) {
      target = lower.rank + RANK_STEP;
    } else {
      target = midpointRank(lower.rank, upper.rank);
    }
    return { target };
  };

  let { target } = locate();
  if (target === null) {
    // Float gap exhausted: renormalize (which publishes its own reorder), then
    // recompute — adjacent ranks are RANK_STEP apart now, the midpoint cannot
    // collide.
    normalizeRanksInTx(store, playlistId);
    ({ target } = locate());
    if (target === null) {
      throw new InvalidReorderError('rank collision persisted after normalization');
    }
  }

  // Rank-only: dragging a song does not touch the membership's LWW triple,
  // because rank is decided by server order alone now (§3.5).
  setRankInTx(store, playlistId, songId, target);
}

export function reorderSong(
  store: PortableDb,
  playlistId: string,
  songId: string,
  anchors: ReorderAnchors,
): void {
  store.sqlite.transaction(() => reorderSongInTx(store, playlistId, songId, anchors)).immediate();
}
