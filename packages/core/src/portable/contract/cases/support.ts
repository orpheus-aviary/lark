// Shared fixtures for the contract cases.
//
// Cases get an EMPTY database and build what they need, so the schema they run
// against is the real migration chain rather than a toy table that agrees with
// nothing. Where a case is about a SQLite feature the product schema does not
// happen to exercise, it creates a scratch table and says so.

import { LATEST_KNOWN_VERSION, applyForwardMigrations } from '../../migrate.js';
import type { SqliteLike } from '../../sqlite.js';

/** Fixed timestamps: nothing here should depend on a clock. */
export const T0 = 1_800_000_000_000;

/** Run the real chain and hand back the handle. */
export function migrate(sqlite: SqliteLike): SqliteLike {
  applyForwardMigrations(sqlite, 0, LATEST_KNOWN_VERSION);
  return sqlite;
}

export interface SeedSongOptions {
  id?: string;
  name?: string;
  artist?: string;
  provider?: string | null;
  key?: string | null;
  createdAt?: number;
}

/** Insert a song with positional binding and return its id. */
export function seedSong(sqlite: SqliteLike, options: SeedSongOptions = {}): string {
  const id = options.id ?? 'song-1';
  sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_provider, source_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      options.name ?? 'a name',
      options.artist ?? 'an artist',
      options.provider ?? null,
      options.key ?? null,
      options.createdAt ?? T0,
      options.createdAt ?? T0,
    );
  return id;
}

/** Insert a playlist and return its id. */
export function seedPlaylist(sqlite: SqliteLike, id = 'playlist-1'): string {
  sqlite
    .prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, 'a playlist', T0, T0);
  return id;
}

export function addToPlaylist(
  sqlite: SqliteLike,
  playlistId: string,
  songId: string,
  rank = 1,
): void {
  sqlite
    .prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(playlistId, songId, rank, T0, T0);
}

/** Append an outbox row; `payload` is stored verbatim. */
export function seedChange(
  sqlite: SqliteLike,
  entityId: string,
  payload: string,
  options: { op?: string; clientChangeId?: string | null; syncedAt?: number | null } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at, client_change_id, synced_at)
       VALUES (?, 'song', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'device-1',
      entityId,
      options.op ?? 'create',
      payload,
      T0,
      options.clientChangeId ?? null,
      options.syncedAt ?? null,
    );
}

/** `.get()` narrowed to a row, or `undefined` on a miss. */
export function getRow(sqlite: SqliteLike, sql: string, ...params: unknown[]): unknown {
  return sqlite.prepare(sql).get(...params);
}

/** A single scalar column out of a one-row query. */
export function scalar(sqlite: SqliteLike, sql: string, ...params: unknown[]): unknown {
  const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  const values = Object.values(row);
  return values.length > 0 ? values[0] : undefined;
}

export function count(sqlite: SqliteLike, sql: string, ...params: unknown[]): number {
  return Number(scalar(sqlite, sql, ...params));
}
