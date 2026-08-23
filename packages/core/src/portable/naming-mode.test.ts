// Criterion 24 (N4d), the half that does not need a phone: where the choice
// lives, what an install that has never chosen opens on, and what a value this
// build does not understand does NOT do to the library.
//
// The other half — that it survives a cold start — is the device's, because
// what it is really testing there is that the library on disk is the same one
// the next process opens.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import type { StructuredLogger } from './logger.js';
import {
  NAMING_MODE_KEY,
  readNamingMode,
  resolveNamingMode,
  writeNamingMode,
} from './naming-mode.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const rows = () =>
  sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').all(NAMING_MODE_KEY) as {
    value: string;
  }[];

const put = (value: string) =>
  sqlite
    .prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)')
    .run(NAMING_MODE_KEY, value);

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

describe('remembering the choice', () => {
  it('an install that has never chosen says so, rather than guessing', () => {
    expect(rows()).toHaveLength(0);
    expect(readNamingMode(sqlite)).toBeNull();
  });

  it('round-trips both modes through one row', () => {
    writeNamingMode(sqlite, 'clean');
    expect(readNamingMode(sqlite)).toBe('clean');

    writeNamingMode(sqlite, 'original');
    expect(readNamingMode(sqlite)).toBe('original');
    // Upsert, not append: a setting with two values is a setting with none.
    expect(rows()).toHaveLength(1);
  });

  it('is in the library, not in process state — a reopen finds it', () => {
    writeNamingMode(sqlite, 'clean');
    expect(
      sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(NAMING_MODE_KEY),
    ).toEqual({ value: 'clean' });
  });
});

describe('a value this build does not understand', () => {
  for (const junk of ['', ' clean', 'CLEAN', 'cleaned', 'true', '1']) {
    it(`reads \`${junk}\` as "never chosen" and leaves the row alone`, () => {
      put(junk);
      expect(readNamingMode(sqlite, recorder)).toBeNull();
      // The point of the case: the read path is a read path.
      expect(rows()).toEqual([{ value: junk }]);
    });
  }

  it('says so once, with the value it could not use', () => {
    put('cleaned');
    readNamingMode(sqlite, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: NAMING_MODE_KEY, stored: 'cleaned' });
  });

  it('stays quiet on the paths that are not surprising', () => {
    readNamingMode(sqlite, recorder);
    writeNamingMode(sqlite, 'clean');
    readNamingMode(sqlite, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    put('nonsense');
    expect(readNamingMode(sqlite)).toBeNull();
  });
});

describe('resolveNamingMode (decision f)', () => {
  it('opens on `original` where there is no model to run `clean`', () => {
    expect(resolveNamingMode({ remembered: null, hasLlm: false })).toBe('original');
  });

  it('opens on `clean` where there is one — the desktop default, earned', () => {
    expect(resolveNamingMode({ remembered: null, hasLlm: true })).toBe('clean');
  });

  it('lets a remembered choice win over both', () => {
    expect(resolveNamingMode({ remembered: 'original', hasLlm: true })).toBe('original');
    expect(resolveNamingMode({ remembered: 'clean', hasLlm: false })).toBe('clean');
  });

  it('does not quietly move a remembered `clean` when the model goes away', () => {
    // The form disables the chip and says why; moving the choice on the user's
    // behalf would hide that the model, not the preference, is what changed.
    expect(resolveNamingMode({ remembered: 'clean', hasLlm: false })).not.toBe('original');
  });
});

describe('the identity domain it belongs to', () => {
  it('is local, not synced: changing it emits no sync_changes row', () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    writeNamingMode(sqlite, 'clean');
    expect(changes()).toBe(before);
  });
});
