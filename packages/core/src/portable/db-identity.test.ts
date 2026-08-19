// Criterion 8 (N2b gate). The desktop half — `db/index.test.ts`'s four cases —
// checks that moving this function changed no behaviour; these check the three
// library states the MOBILE boot sequence will hand it, and the one that
// proves the guarantee is load bearing rather than decorative.
//
// It runs against better-sqlite3 through `SqliteLike`, which is the point: the
// function under test names no host, so the case a phone will hit is the case
// a desktop test runner can execute.

import { isUuidV4 } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { ensureDeviceUuid } from './db-identity.js';
import type { PortableDb } from './db.js';
import { createPlaylist } from './library/playlists.js';

let sqlite: BetterSqlite3.Database;
let portable: PortableDb;

beforeEach(() => {
  ({ sqlite, portable } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const stored = () =>
  (
    sqlite.prepare("SELECT value FROM local_metadata WHERE key='device_uuid'").get() as
      | { value: string }
      | undefined
  )?.value;

/** What D16's converge does to a restored library (§2.2.2, decision j). */
const converge = () => {
  sqlite.prepare("DELETE FROM local_metadata WHERE key='device_uuid'").run();
};

describe('ensureDeviceUuid on the three library states', () => {
  it('a fresh library already carries one, and asking again is idempotent', () => {
    // `createDatabase` is the fresh-library path: the row exists before this
    // test asks for it, which is exactly the guarantee mobile has to reproduce.
    const first = stored();
    expect(first).toBeDefined();
    expect(isUuidV4(first as string)).toBe(true);
    expect(ensureDeviceUuid(sqlite)).toBe(first);
    expect(ensureDeviceUuid(sqlite)).toBe(first);
  });

  it('an existing v3 library keeps the value it came with', () => {
    const before = stored();
    // Reopening is what a second app launch does. Same handle here, but the
    // assertion is the same one: nothing about a valid value gets rewritten.
    expect(ensureDeviceUuid(sqlite)).toBe(before);
    expect(stored()).toBe(before);
  });

  it('a converged library gets a NEW identity, not the old one back', () => {
    const before = stored();
    converge();
    expect(stored()).toBeUndefined();

    const after = ensureDeviceUuid(sqlite);
    expect(isUuidV4(after)).toBe(true);
    // Persisted, not just returned: a mint-without-write passes every other
    // assertion here and then dies on the next launch (MEASURED — an earlier
    // draft of this file let exactly that mutant through).
    expect(stored()).toBe(after);
    // The whole reason converge deletes the row: two installs must not claim
    // one local identity, because sync's tombstone and echo rules are decided
    // by this value.
    expect(after).not.toBe(before);
  });

  it('warns and regenerates when the stored value is corrupt', () => {
    const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (fields: Record<string, unknown>, msg: string) => warnings.push({ fields, msg }),
      error: () => {},
    };
    sqlite.prepare("UPDATE local_metadata SET value='not-a-uuid' WHERE key='device_uuid'").run();

    const regenerated = ensureDeviceUuid(sqlite, logger);

    expect(isUuidV4(regenerated)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields.stored).toBe('not-a-uuid');
  });
});

describe('what happens when a bootstrap skips it', () => {
  // The counter-test criterion 8 asks for. A mobile boot sequence that opens
  // the database and goes straight to the services looks completely healthy —
  // the library reads fine — and then dies on the first WRITE, with an error
  // about a database that "was not opened by us". This is that failure, so
  // that the step being missing is a red test rather than a field report.
  it('the first business write throws about the missing identity', () => {
    converge();

    expect(() => createPlaylist(portable, 'anything')).toThrow(/device_uuid is missing/);
  });

  it('and succeeds as soon as the step runs', () => {
    converge();
    ensureDeviceUuid(sqlite);

    expect(() => createPlaylist(portable, 'anything')).not.toThrow();
  });
});
