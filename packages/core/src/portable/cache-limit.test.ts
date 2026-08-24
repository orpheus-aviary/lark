// Criterion 50 (N4g-1). The cache behaviour itself is on trial elsewhere
// (`library/cache.test.ts` owns eviction, and the phone owns whether a limit
// somebody typed reaches it) — what is on trial HERE is the storage shape the
// three siblings share: where the number lives, what a library that has never
// been asked reads as, and what a value this build cannot use does NOT do.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import {
  CACHE_LIMIT_KEY,
  DEFAULT_CACHE_LIMIT_MB,
  readCacheLimitMb,
  writeCacheLimitMb,
} from './cache-limit.js';
import type { StructuredLogger } from './logger.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const rows = () =>
  sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').all(CACHE_LIMIT_KEY) as {
    value: string;
  }[];

const put = (value: string) =>
  sqlite
    .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
    .run(CACHE_LIMIT_KEY, value);

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

describe('reading the limit', () => {
  it('a library that has never been asked is unlimited', () => {
    expect(rows()).toHaveLength(0);
    expect(readCacheLimitMb(sqlite)).toBe(DEFAULT_CACHE_LIMIT_MB);
    // 0 is not a decoration: `runEviction` returns before it scans anything.
    expect(DEFAULT_CACHE_LIMIT_MB).toBe(0);
  });

  it('round-trips a number through one row', () => {
    writeCacheLimitMb(sqlite, 2048);
    expect(readCacheLimitMb(sqlite)).toBe(2048);

    writeCacheLimitMb(sqlite, 512);
    expect(readCacheLimitMb(sqlite)).toBe(512);
    // Upsert, not append: a setting with two values is a setting with none.
    expect(rows()).toHaveLength(1);
  });

  it('takes 0 back as a real choice — "unlimited" is a setting, not a gap', () => {
    writeCacheLimitMb(sqlite, 100);
    writeCacheLimitMb(sqlite, 0);
    expect(readCacheLimitMb(sqlite)).toBe(0);
    expect(rows()).toEqual([{ value: '0' }]);
  });
});

describe('a value this build cannot use', () => {
  // `12.5` and `1e3` are in here deliberately: both are numbers a careless
  // writer could have produced, and neither is a value this one ever writes.
  for (const junk of ['', ' 100', '100 ', '12.5', '-1', '1e3', 'lots', '99999999999999999999']) {
    it(`reads \`${junk}\` as unlimited and leaves the row alone`, () => {
      put(junk);
      expect(readCacheLimitMb(sqlite, recorder)).toBe(DEFAULT_CACHE_LIMIT_MB);
      // The point of the case: the read path is a read path.
      expect(rows()).toEqual([{ value: junk }]);
    });
  }

  it('says so, with the value it could not use', () => {
    put('12.5');
    readCacheLimitMb(sqlite, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: CACHE_LIMIT_KEY, stored: '12.5' });
  });

  it('stays quiet on the paths that are not surprising', () => {
    readCacheLimitMb(sqlite, recorder);
    writeCacheLimitMb(sqlite, 1);
    readCacheLimitMb(sqlite, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    put('nonsense');
    expect(readCacheLimitMb(sqlite)).toBe(DEFAULT_CACHE_LIMIT_MB);
  });
});

describe('writing', () => {
  it('refuses what a settings form should never have sent', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => writeCacheLimitMb(sqlite, bad)).toThrow(RangeError);
    }
    // Refused means refused: nothing was stored on the way to the throw.
    expect(rows()).toHaveLength(0);
  });
});

describe('the identity domain it belongs to', () => {
  it('is local, not synced: changing it emits no sync_changes row', () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    writeCacheLimitMb(sqlite, 4096);
    expect(changes()).toBe(before);
  });
});
