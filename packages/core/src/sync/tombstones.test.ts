import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { makeLwwTriple } from './lww.js';
import {
  clearTombstone,
  effectiveKey,
  parentGateOpen,
  readTombstone,
  writeTombstone,
} from './tombstones.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

function insertSong(id: string): void {
  sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at)
       VALUES (?, 'n', '', 'downloaded', 1, 1)`,
    )
    .run(id);
}

function insertPlaylist(id: string): void {
  sqlite
    .prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
    .run(id, 'p');
}

describe('writeTombstone', () => {
  it('keeps the later key whichever order the two deletes arrive in', () => {
    const older = makeLwwTriple(1_000, 0, 'dev-a');
    const newer = makeLwwTriple(2_000, 0, 'dev-b');

    const id1 = randomUUID();
    writeTombstone(sqlite, 'song', id1, older, 1);
    writeTombstone(sqlite, 'song', id1, newer, 2);

    const id2 = randomUUID();
    writeTombstone(sqlite, 'song', id2, newer, 2);
    writeTombstone(sqlite, 'song', id2, older, 1);

    // Order-independent by construction — two devices deleting the same song
    // converge no matter who is heard first.
    expect(readTombstone(sqlite, 'song', id1)?.key).toEqual(newer);
    expect(readTombstone(sqlite, 'song', id2)?.key).toEqual(newer);
  });

  it('stores a NULL device id rather than an empty string', () => {
    const id = randomUUID();
    writeTombstone(sqlite, 'song', id, makeLwwTriple(1, 0, null), 1);
    const raw = sqlite
      .prepare('SELECT device_id FROM sync_tombstones WHERE entity_id = ?')
      .get(id) as { device_id: string | null };
    // The column matches the entity tables' nullability; `''` is a comparison
    // artifact and must not leak into storage.
    expect(raw.device_id).toBeNull();
    expect(readTombstone(sqlite, 'song', id)?.key.deviceId).toBe('');
  });

  it('clears on a revival', () => {
    const id = `${randomUUID()}:${randomUUID()}`;
    writeTombstone(sqlite, 'playlist_song', id, makeLwwTriple(1, 0, 'dev'), 1);
    clearTombstone(sqlite, 'playlist_song', id);
    expect(readTombstone(sqlite, 'playlist_song', id)).toBeNull();
  });
});

describe('effectiveKey', () => {
  it('is the later of the row and the tombstone', () => {
    const row = makeLwwTriple(1_000, 0, 'a');
    const grave = makeLwwTriple(2_000, 0, 'b');
    expect(effectiveKey(row, grave)).toEqual(grave);
    expect(effectiveKey(grave, row)).toEqual(grave);
    expect(effectiveKey(row, null)).toEqual(row);
    expect(effectiveKey(null, grave)).toEqual(grave);
    expect(effectiveKey(null, null)).toBeNull();
  });
});

describe('parentGateOpen', () => {
  it('is closed for an entity this device has never seen', () => {
    expect(parentGateOpen(sqlite, 'song', randomUUID())).toBe(false);
    expect(parentGateOpen(sqlite, 'playlist', randomUUID())).toBe(false);
  });

  it('is open for a live row and closed once it is tombstoned', () => {
    const songId = randomUUID();
    insertSong(songId);
    expect(parentGateOpen(sqlite, 'song', songId)).toBe(true);

    writeTombstone(sqlite, 'song', songId, makeLwwTriple(5, 0, 'dev'), 5);
    // A tombstone shuts the gate even while the row is still there: the delete
    // is committed in the same transaction, and a lyrics op racing it must not
    // slip in between.
    expect(parentGateOpen(sqlite, 'song', songId)).toBe(false);

    const playlistId = randomUUID();
    insertPlaylist(playlistId);
    expect(parentGateOpen(sqlite, 'playlist', playlistId)).toBe(true);
  });
});
