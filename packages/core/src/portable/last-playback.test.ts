// Criterion 23: the whole invalidity surface, and the one thing every case
// has in common — the row is never rewritten.
//
// This is where those cases belong rather than on the phone. Each of them is
// "the library changed under a remembered position", which is a database
// state, and the device adds nothing to a database state except a build.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import {
  LAST_PLAYBACK_KEY,
  type LastPlayback,
  readLastPlayback,
  writeLastPlayback,
} from './last-playback.js';

let sqlite: BetterSqlite3.Database;

/** Every song has a file unless a case says otherwise. */
let missing: string | null = null;
const checks = { hasFile: (songId: string) => songId !== missing };

const SONG = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
const LIST = 'b1b2c3d4-0000-4000-8000-000000000001';

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
  missing = null;
  song(SONG, 200);
  song(OTHER, 0); // a library that never recorded a duration
  sqlite
    .prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)')
    .run(LIST, 'a list');
  sqlite
    .prepare(
      'INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at) VALUES (?, ?, 1, 0, 0)',
    )
    .run(LIST, SONG);
});

afterEach(() => {
  sqlite.close();
});

function song(id: string, duration: number): void {
  sqlite
    .prepare(
      'INSERT INTO songs (id, name, duration, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    )
    .run(id, id, duration);
}

/** The raw stored string, so a test can assert the read path left it alone. */
const stored = (): string | undefined =>
  (
    sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(LAST_PLAYBACK_KEY) as
      | { value: string }
      | undefined
  )?.value;

function put(value: string): void {
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(LAST_PLAYBACK_KEY, value);
}

const read = () => readLastPlayback(sqlite, checks);

describe('the remembered position', () => {
  it('a library that has never played anything remembers nothing', () => {
    expect(read()).toBeNull();
    expect(stored()).toBeUndefined();
  });

  it('round-trips through one row', () => {
    const value: LastPlayback = {
      songId: SONG,
      positionSeconds: 123.4,
      queue: { kind: 'playlist', id: LIST },
    };
    writeLastPlayback(sqlite, value);
    expect(read()).toEqual(value);

    writeLastPlayback(sqlite, { ...value, positionSeconds: 5, queue: { kind: 'all' } });
    expect(read()).toEqual({ songId: SONG, positionSeconds: 5, queue: { kind: 'all' } });
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM local_metadata WHERE key = ?')
        .get(LAST_PLAYBACK_KEY),
    ).toEqual({ n: 1 });
  });

  it('keeps a position of exactly zero, which is a position', () => {
    writeLastPlayback(sqlite, { songId: SONG, positionSeconds: 0, queue: { kind: 'all' } });
    expect(read()?.positionSeconds).toBe(0);
  });

  it('does not use a duration of 0 as an upper bound', () => {
    // `OTHER` has no recorded duration. Rejecting every position for it would
    // forget the whole of an imported library.
    writeLastPlayback(sqlite, { songId: OTHER, positionSeconds: 9999, queue: { kind: 'all' } });
    expect(read()?.positionSeconds).toBe(9999);
  });
});

describe('what will not be restored', () => {
  const cases: [name: string, value: string][] = [
    [
      'the song is not in the library any more',
      JSON.stringify({ song_id: 'gone', position_seconds: 5, queue: { kind: 'all' } }),
    ],
    [
      'position_seconds is negative',
      JSON.stringify({ song_id: SONG, position_seconds: -1, queue: { kind: 'all' } }),
    ],
    [
      'position_seconds is not a number',
      JSON.stringify({ song_id: SONG, position_seconds: '5', queue: { kind: 'all' } }),
    ],
    [
      'position_seconds is not finite',
      `{"song_id":"${SONG}","position_seconds":1e999,"queue":{"kind":"all"}}`,
    ],
    [
      'the position is exactly the end of the song',
      JSON.stringify({ song_id: SONG, position_seconds: 200, queue: { kind: 'all' } }),
    ],
    [
      'the position is past the end of the song',
      JSON.stringify({ song_id: SONG, position_seconds: 201, queue: { kind: 'all' } }),
    ],
    ['song_id is missing', JSON.stringify({ position_seconds: 5, queue: { kind: 'all' } })],
    [
      'song_id is empty',
      JSON.stringify({ song_id: '', position_seconds: 5, queue: { kind: 'all' } }),
    ],
    [
      'the queue kind is unknown',
      JSON.stringify({ song_id: SONG, position_seconds: 5, queue: { kind: 'album', id: 'x' } }),
    ],
    [
      'the queue is a playlist with no id',
      JSON.stringify({ song_id: SONG, position_seconds: 5, queue: { kind: 'playlist' } }),
    ],
    ['the queue is missing', JSON.stringify({ song_id: SONG, position_seconds: 5 })],
    ['it is not JSON', '{ this is not'],
    ['it is the empty string', ''],
    ['it is a JSON value but not an object', '"a string"'],
  ];

  for (const [name, value] of cases) {
    it(`${name} — and the row is left exactly as it was`, () => {
      put(value);
      expect(read()).toBeNull();
      expect(stored()).toBe(value);
    });
  }

  it('the song has no audio file', () => {
    const value = JSON.stringify({
      song_id: SONG,
      position_seconds: 5,
      queue: { kind: 'all' },
    });
    put(value);
    missing = SONG;
    expect(read()).toBeNull();
    expect(stored()).toBe(value);
  });
});

describe('a playlist that is gone', () => {
  it('widens the queue and keeps the song — a deleted list is not a lost place', () => {
    writeLastPlayback(sqlite, {
      songId: SONG,
      positionSeconds: 42,
      queue: { kind: 'playlist', id: 'never-existed' },
    });
    expect(read()).toEqual({ songId: SONG, positionSeconds: 42, queue: { kind: 'all' } });
  });

  it('so does one that still exists but has been emptied', () => {
    const value: LastPlayback = {
      songId: SONG,
      positionSeconds: 42,
      queue: { kind: 'playlist', id: LIST },
    };
    writeLastPlayback(sqlite, value);
    expect(read()).toEqual(value);

    sqlite.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').run(LIST);
    expect(read()).toEqual({ songId: SONG, positionSeconds: 42, queue: { kind: 'all' } });
  });

  it('and the row still is not rewritten', () => {
    writeLastPlayback(sqlite, {
      songId: SONG,
      positionSeconds: 42,
      queue: { kind: 'playlist', id: LIST },
    });
    const before = stored();
    sqlite.prepare('DELETE FROM playlists WHERE id = ?').run(LIST);
    expect(read()?.queue).toEqual({ kind: 'all' });
    expect(stored()).toBe(before);
  });
});
