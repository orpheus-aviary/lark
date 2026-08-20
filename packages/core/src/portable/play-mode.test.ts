// Decision g, and the same three questions `now-playing-mode.test.ts` asks of
// its own key: where it lives, what a library without it reads as, and what a
// value this build cannot parse does NOT do to the library.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { DEFAULT_PLAY_MODE, PLAY_MODE_KEY, readPlayMode, writePlayMode } from './play-mode.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const rows = () =>
  sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').all(PLAY_MODE_KEY) as {
    value: string;
  }[];

describe('the play mode', () => {
  it('a library that has never been asked plays in order', () => {
    expect(rows()).toHaveLength(0);
    expect(readPlayMode(sqlite)).toBe('sequential');
    expect(DEFAULT_PLAY_MODE).toBe('sequential');
  });

  it('round-trips all four through one row', () => {
    for (const mode of ['shuffle', 'repeat-one', 'repeat-all', 'sequential'] as const) {
      writePlayMode(sqlite, mode);
      expect(readPlayMode(sqlite)).toBe(mode);
    }
    expect(rows()).toHaveLength(1);
  });

  it('a value this build cannot parse reads as the default and is left alone', () => {
    for (const junk of ['', 'SHUFFLE', 'repeat', 'random', '1']) {
      sqlite.prepare('DELETE FROM local_metadata WHERE key = ?').run(PLAY_MODE_KEY);
      sqlite
        .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
        .run(PLAY_MODE_KEY, junk);
      expect(readPlayMode(sqlite)).toBe(DEFAULT_PLAY_MODE);
      expect(rows()).toEqual([{ value: junk }]);
    }
  });

  it('is local, not synced: changing it emits no sync_changes row', () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    writePlayMode(sqlite, 'shuffle');
    expect(changes()).toBe(before);
  });
});
