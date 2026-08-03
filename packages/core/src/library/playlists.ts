// Playlists CRUD + membership + reorder (T4). core does not know 'all' — the
// virtual all-songs view is an API-layer literal (R3); M2 maps it to
// listSongs and rejects writes. Membership changes never bump the OWNING
// playlist row's LWW (cross-entity decoupling, M1-5).

import { randomUUID } from 'node:crypto';
import type { PlaylistData, SongData } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { and, count, eq } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { nextLwwStamp } from '../db/lww.js';
import {
  type PlaylistRow,
  type PlaylistSongRow,
  playlist_songs,
  playlists,
  songs,
} from '../db/schema.js';
import { InvalidReorderError, NotFoundError } from '../errors.js';
import { RANK_STEP, midpointRank, normalizeRanksInTx } from './rank.js';

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

function getPlaylistRow(db: LarkDatabase, id: string): PlaylistRow {
  const row = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (!row) throw new NotFoundError('playlist', id);
  return row;
}

export function createPlaylist(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  name: string,
): PlaylistData {
  const now = Date.now();
  const row: PlaylistRow = {
    id: randomUUID(),
    name,
    created_at: now,
    updated_at: now,
    device_id: null,
    lww_counter: 0,
  };
  db.insert(playlists).values(row).run();
  return toPlaylistData(row, 0);
}

export function renamePlaylistInTx(db: LarkDatabase, id: string, name: string): PlaylistData {
  const prev = getPlaylistRow(db, id);
  const stamp = nextLwwStamp(prev);
  db.update(playlists)
    .set({ name, updated_at: stamp.updated_at, lww_counter: stamp.lww_counter })
    .where(eq(playlists.id, id))
    .run();
  return toPlaylistData({ ...prev, name, ...stamp });
}

export function renamePlaylist(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  id: string,
  name: string,
): PlaylistData {
  return sqlite.transaction(() => renamePlaylistInTx(db, id, name)).immediate();
}

export function deletePlaylistInTx(db: LarkDatabase, id: string): void {
  getPlaylistRow(db, id);
  // FK ON DELETE CASCADE prunes playlist_songs.
  db.delete(playlists).where(eq(playlists.id, id)).run();
}

export function deletePlaylist(db: LarkDatabase, sqlite: BetterSqlite3.Database, id: string): void {
  sqlite.transaction(() => deletePlaylistInTx(db, id)).immediate();
}

/** All playlists with their member counts, ordered by (created_at, id). */
export function listPlaylists(db: LarkDatabase, _sqlite: BetterSqlite3.Database): PlaylistData[] {
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
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
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
  db: LarkDatabase,
  playlistId: string,
  songIds: readonly string[],
): number {
  getPlaylistRow(db, playlistId);
  const now = Date.now();

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
    db.insert(playlist_songs)
      .values({
        playlist_id: playlistId,
        song_id: songId,
        rank: tail,
        added_at: now,
        updated_at: now,
        device_id: null,
        lww_counter: 0,
      })
      .run();
    existing.add(songId);
    added++;
  }
  return added;
}

export function addSongsToPlaylist(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  playlistId: string,
  songIds: readonly string[],
): number {
  return sqlite.transaction(() => addSongsToPlaylistInTx(db, playlistId, songIds)).immediate();
}

export function removeSongFromPlaylist(
  db: LarkDatabase,
  _sqlite: BetterSqlite3.Database,
  playlistId: string,
  songId: string,
): void {
  const res = db
    .delete(playlist_songs)
    .where(and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, songId)))
    .run();
  if (res.changes === 0) throw new NotFoundError('playlist_song', songId);
}

function orderedMembers(db: LarkDatabase, playlistId: string): PlaylistSongRow[] {
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
  db: LarkDatabase,
  playlistId: string,
  songId: string,
  anchors: ReorderAnchors,
): void {
  getPlaylistRow(db, playlistId);
  const { before_song_id, after_song_id } = anchors;
  if (before_song_id === undefined && after_song_id === undefined) {
    throw new InvalidReorderError('reorder needs before_song_id and/or after_song_id');
  }

  const locate = (): {
    movedRank: { updated_at: number; lww_counter: number };
    target: number | null;
  } => {
    const members = orderedMembers(db, playlistId);
    const moved = members.find((m) => m.song_id === songId);
    if (!moved) throw new NotFoundError('playlist_song', songId);
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
    return { movedRank: moved, target };
  };

  let { movedRank, target } = locate();
  if (target === null) {
    // Float gap exhausted: renormalize (bumps changed rows), then recompute —
    // adjacent ranks are RANK_STEP apart now, the midpoint cannot collide.
    normalizeRanksInTx(db, playlistId);
    ({ movedRank, target } = locate());
    if (target === null) {
      throw new InvalidReorderError('rank collision persisted after normalization');
    }
  }

  const stamp = nextLwwStamp(movedRank);
  db.update(playlist_songs)
    .set({ rank: target, updated_at: stamp.updated_at, lww_counter: stamp.lww_counter })
    .where(and(eq(playlist_songs.playlist_id, playlistId), eq(playlist_songs.song_id, songId)))
    .run();
}

export function reorderSong(
  db: LarkDatabase,
  sqlite: BetterSqlite3.Database,
  playlistId: string,
  songId: string,
  anchors: ReorderAnchors,
): void {
  sqlite.transaction(() => reorderSongInTx(db, playlistId, songId, anchors)).immediate();
}
