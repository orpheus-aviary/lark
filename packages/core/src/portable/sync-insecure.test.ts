// Criterion 69's storage half (N5b). Whether a login actually refuses is
// `sync/server-url.test.ts`'s job; what is on trial HERE is the switch itself:
// where it lives, what a library that has never been asked reads as, and —
// the part that matters more than anywhere else in this directory — which way
// it falls when it cannot read what it finds.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import type { StructuredLogger } from './logger.js';
import {
  DEFAULT_SYNC_ALLOW_INSECURE,
  SYNC_ALLOW_INSECURE_KEY,
  readSyncAllowInsecure,
  writeSyncAllowInsecure,
} from './sync-insecure.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const rows = () =>
  sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').all(SYNC_ALLOW_INSECURE_KEY) as {
    value: string;
  }[];

const put = (value: string) =>
  sqlite
    .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
    .run(SYNC_ALLOW_INSECURE_KEY, value);

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

describe('reading the switch', () => {
  it('a library that has never been asked refuses plaintext', () => {
    expect(rows()).toHaveLength(0);
    expect(readSyncAllowInsecure(sqlite)).toBe(false);
    // Not a decoration: this default is the whole reason the read path is safe
    // to call before anyone has opened the settings page.
    expect(DEFAULT_SYNC_ALLOW_INSECURE).toBe(false);
  });

  it('round-trips both answers through one row', () => {
    writeSyncAllowInsecure(sqlite, true);
    expect(readSyncAllowInsecure(sqlite)).toBe(true);
    expect(rows()).toEqual([{ value: '1' }]);

    writeSyncAllowInsecure(sqlite, false);
    expect(readSyncAllowInsecure(sqlite)).toBe(false);
    // Kept at '0' rather than deleted — "somebody turned this off" outlives
    // the absence of a row that cannot tell off from never-asked.
    expect(rows()).toEqual([{ value: '0' }]);
  });
});

describe('a value this build did not write', () => {
  // Every one of these is something a future build, a hand-edited row or a
  // half-finished migration could plausibly leave behind. None of them is '1'.
  for (const stored of ['true', 'TRUE', 'yes', '', ' 1', '1 ', '2', '-1', 'on']) {
    it(`refuses plaintext for ${JSON.stringify(stored)}`, () => {
      put(stored);
      expect(readSyncAllowInsecure(sqlite, recorder)).toBe(false);
    });
  }

  it('says so rather than swallowing it', () => {
    put('true');
    readSyncAllowInsecure(sqlite, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ key: SYNC_ALLOW_INSECURE_KEY, stored: 'true' });
  });

  it('does not warn about the two values it does understand', () => {
    put('0');
    readSyncAllowInsecure(sqlite, recorder);
    sqlite
      .prepare('UPDATE local_metadata SET value = ? WHERE key = ?')
      .run('1', SYNC_ALLOW_INSECURE_KEY);
    expect(readSyncAllowInsecure(sqlite, recorder)).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('never repairs what it cannot read', () => {
    put('true');
    readSyncAllowInsecure(sqlite, recorder);
    // A read that "fixed" this would be a downgrade eating a setting — and in
    // this particular case, a downgrade silently deciding a security question.
    expect(rows()).toEqual([{ value: 'true' }]);
  });
});
