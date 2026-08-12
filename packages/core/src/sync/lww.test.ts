import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { emitSyncChange } from './changes.js';
import {
  cmpLww,
  isSelfReplay,
  makeLwwTriple,
  maxLww,
  readMembershipLww,
  readPlaylistLww,
  readSongLww,
} from './lww.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

describe('cmpLww', () => {
  it('orders by ms, then counter, then device id', () => {
    expect(cmpLww(makeLwwTriple(1, 9, 'z'), makeLwwTriple(2, 0, 'a'))).toBeLessThan(0);
    expect(cmpLww(makeLwwTriple(2, 0, 'z'), makeLwwTriple(2, 1, 'a'))).toBeLessThan(0);
    expect(cmpLww(makeLwwTriple(2, 1, 'a'), makeLwwTriple(2, 1, 'b'))).toBeLessThan(0);
    expect(cmpLww(makeLwwTriple(2, 1, 'b'), makeLwwTriple(2, 1, 'b'))).toBe(0);
  });

  it('reads a NULL device id as the empty string, which loses every tie', () => {
    // A row stamped before this library ever registered has no claim on a tie
    // against a device that did — and the order stays total either way.
    expect(cmpLww(makeLwwTriple(2, 1, null), makeLwwTriple(2, 1, 'dev'))).toBeLessThan(0);
    expect(cmpLww(makeLwwTriple(2, 1, null), makeLwwTriple(2, 1, null))).toBe(0);
  });

  it('maxLww keeps the incumbent on a tie', () => {
    const a = makeLwwTriple(2, 1, 'dev');
    const b = makeLwwTriple(2, 1, 'dev');
    expect(maxLww(a, b)).toBe(a);
    expect(maxLww(a, makeLwwTriple(3, 0, 'dev'))).toEqual(makeLwwTriple(3, 0, 'dev'));
  });
});

describe('reading local keys', () => {
  it('returns null for rows that are not there', () => {
    expect(readSongLww(sqlite, randomUUID())).toBeNull();
    expect(readPlaylistLww(sqlite, randomUUID())).toBeNull();
    expect(readMembershipLww(sqlite, randomUUID(), randomUUID())).toBeNull();
  });

  it('reads the triple off each of the three tables', () => {
    const songId = randomUUID();
    const playlistId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, file_origin, created_at, updated_at,
           device_id, lww_counter)
         VALUES (?, 'n', '', 'downloaded', 1, 500, 'dev-a', 3)`,
      )
      .run(songId);
    sqlite
      .prepare(
        `INSERT INTO playlists (id, name, created_at, updated_at, device_id, lww_counter)
         VALUES (?, 'p', 1, 600, NULL, 0)`,
      )
      .run(playlistId);
    sqlite
      .prepare(
        `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at,
           device_id, lww_counter)
         VALUES (?, ?, 1024, 1, 700, 'dev-b', 1)`,
      )
      .run(playlistId, songId);

    expect(readSongLww(sqlite, songId)).toEqual(makeLwwTriple(500, 3, 'dev-a'));
    expect(readPlaylistLww(sqlite, playlistId)).toEqual(makeLwwTriple(600, 0, null));
    expect(readMembershipLww(sqlite, playlistId, songId)).toEqual(makeLwwTriple(700, 1, 'dev-b'));
  });
});

describe('isSelfReplay', () => {
  it('is true only for our own changes the server has already accepted', () => {
    const cid = emitSyncChange(sqlite, {
      entityType: 'song',
      entityId: randomUUID(),
      op: 'delete',
      payload: { updated_at_ms: 1, lww_counter: 0 },
    });

    // Still pending: the server has not seen it, so an identically-numbered
    // change coming back cannot be our echo.
    expect(isSelfReplay(sqlite, cid)).toBe(false);

    sqlite.prepare('UPDATE sync_changes SET synced_at = 1 WHERE client_change_id = ?').run(cid);
    expect(isSelfReplay(sqlite, cid)).toBe(true);
    expect(isSelfReplay(sqlite, randomUUID())).toBe(false);
  });
});
