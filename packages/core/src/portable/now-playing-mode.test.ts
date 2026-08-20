// Criterion 21 (N2g). The Bluetooth behaviour itself is not testable here —
// there is no player and no receiver — so what is on trial is exactly the part
// that can be: where the setting lives, what a library without it reads as,
// and what a value this build does not understand does NOT do to the library.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import type { StructuredLogger } from './logger.js';
import {
  DEFAULT_NOW_PLAYING_MODE,
  NOW_PLAYING_MODE_KEY,
  readNowPlayingMode,
  writeNowPlayingMode,
} from './now-playing-mode.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const rows = () =>
  sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').all(NOW_PLAYING_MODE_KEY) as {
    value: string;
  }[];

const put = (value: string) =>
  sqlite
    .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
    .run(NOW_PLAYING_MODE_KEY, value);

const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
const recorder: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: (fields, msg) => {
    warnings.push({ fields, msg });
  },
  error: () => {},
};

beforeEach(() => {
  warnings.length = 0;
});

describe('reading the mode', () => {
  it('a library that has never been asked reads as the default', () => {
    expect(rows()).toHaveLength(0);
    expect(readNowPlayingMode(sqlite)).toBe(DEFAULT_NOW_PLAYING_MODE);
    expect(DEFAULT_NOW_PLAYING_MODE).toBe('title');
  });

  it('round-trips both modes through one row', () => {
    writeNowPlayingMode(sqlite, 'lyrics');
    expect(readNowPlayingMode(sqlite)).toBe('lyrics');

    writeNowPlayingMode(sqlite, 'title');
    expect(readNowPlayingMode(sqlite)).toBe('title');
    // Upsert, not append: a setting with two values is a setting with none.
    expect(rows()).toHaveLength(1);
  });

  it('survives a reopen — this is the library, not process state', () => {
    writeNowPlayingMode(sqlite, 'lyrics');
    const snapshot = sqlite
      .prepare('SELECT value FROM local_metadata WHERE key = ?')
      .get(NOW_PLAYING_MODE_KEY);
    expect(snapshot).toEqual({ value: 'lyrics' });
  });
});

describe('a value this build does not understand', () => {
  // The empty string is in here deliberately: it is what a half-written
  // setting looks like, and `''` is falsy in every language a reader might be
  // thinking in when they reach for a shortcut.
  for (const junk of ['', ' lyrics', 'LYRICS', 'lyric', 'true', '1']) {
    it(`reads \`${junk}\` as the default and leaves the row alone`, () => {
      put(junk);
      expect(readNowPlayingMode(sqlite, recorder)).toBe(DEFAULT_NOW_PLAYING_MODE);
      // The point of the case: the read path is a read path.
      expect(rows()).toEqual([{ value: junk }]);
    });
  }

  it('says so once, with the value it could not use', () => {
    put('lyric');
    readNowPlayingMode(sqlite, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: NOW_PLAYING_MODE_KEY, stored: 'lyric' });
  });

  it('stays quiet on the paths that are not surprising', () => {
    readNowPlayingMode(sqlite, recorder);
    writeNowPlayingMode(sqlite, 'lyrics');
    readNowPlayingMode(sqlite, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    put('nonsense');
    expect(readNowPlayingMode(sqlite)).toBe(DEFAULT_NOW_PLAYING_MODE);
  });
});

describe('the identity domain it belongs to', () => {
  it('is local, not synced: changing it emits no sync_changes row', () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    writeNowPlayingMode(sqlite, 'lyrics');
    expect(changes()).toBe(before);
  });
});
