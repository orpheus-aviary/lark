// The zero-write read path (M6-20). Two things are being asserted: the full
// version dispatch, and that NOTHING is written — the second is what makes a
// `--direct` read safe next to a running daemon or a nest backup.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process.)

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseNotInitializedError,
  GoMigrationRequiredError,
  IncompatibleDbError,
  MigrationPendingError,
  SchemaMismatchError,
} from '../errors.js';
import { seedGoLegacyDb } from './fixture-go-db.js';
import { createDatabase } from './index.js';
import { LATEST_KNOWN_VERSION } from './migrate.js';
import { openDatabaseReadonly } from './readonly.js';

let dir: string;
const dbPath = (): string => join(dir, 'songs.db');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-readonly-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A current (v1) library with a probe row in it. */
function seedCurrent(): void {
  const { sqlite } = createDatabase({ dbPath: dbPath() });
  sqlite.prepare('INSERT INTO local_metadata (key, value) VALUES (?, ?)').run('probe', 'value');
  sqlite.close();
}

describe('openDatabaseReadonly — dispatch', () => {
  it('opens a current library', () => {
    seedCurrent();
    const { sqlite } = openDatabaseReadonly({ dbPath: dbPath() });
    try {
      const row = sqlite.prepare("SELECT value FROM local_metadata WHERE key='probe'").get() as {
        value: string;
      };
      expect(row.value).toBe('value');
    } finally {
      sqlite.close();
    }
  });

  it('refuses to write through the handle it hands back', () => {
    seedCurrent();
    const { sqlite } = openDatabaseReadonly({ dbPath: dbPath() });
    try {
      // `readonly` alone would already refuse; `query_only` is the second belt.
      expect(() => sqlite.prepare('DELETE FROM songs').run()).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it('reports a missing file as "not initialised", and creates nothing', () => {
    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(DatabaseNotInitializedError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports an empty v0 file as "not initialised"', () => {
    new BetterSqlite3(dbPath()).close(); // materialises an empty database
    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(DatabaseNotInitializedError);
  });

  it('reports a Go-era library as needing migration', () => {
    seedGoLegacyDb(dbPath());
    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(GoMigrationRequiredError);
  });

  it('refuses an unrecognised v0 schema', () => {
    const sqlite = new BetterSqlite3(dbPath());
    sqlite.exec('CREATE TABLE mystery (id TEXT PRIMARY KEY)');
    sqlite.close();

    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(IncompatibleDbError);
  });

  it('refuses a library from a newer build', () => {
    seedCurrent();
    const sqlite = new BetterSqlite3(dbPath());
    sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION + 1}`);
    sqlite.close();

    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(IncompatibleDbError);
  });

  it('does not trust the version number alone at the current version', () => {
    const sqlite = new BetterSqlite3(dbPath());
    sqlite.exec('CREATE TABLE songs (id TEXT PRIMARY KEY)'); // nothing like v1
    sqlite.pragma(`user_version = ${LATEST_KNOWN_VERSION}`);
    sqlite.close();

    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });

  it('propagates a permission error instead of calling the library missing', () => {
    // `existsSync` answers false for EACCES too, which is why the probe is a
    // `statSync` that maps ENOENT and nothing else (fifth review ②).
    seedCurrent();
    chmodSync(dir, 0o000);
    let caught: unknown;
    try {
      openDatabaseReadonly({ dbPath: dbPath() });
    } catch (err) {
      caught = err;
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DatabaseNotInitializedError);
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('has an answer for a version this build could migrate but may not', () => {
    // `0 < v < LATEST` is unreachable while LATEST_KNOWN_VERSION is 1, so the
    // class is asserted directly: the day a v2 lands, a read path must report
    // the pending upgrade rather than perform it.
    const err = new MigrationPendingError(dbPath(), 1, 2);
    expect(err.dbVersion).toBe(1);
    expect(err.message).toContain('lark daemon');
  });
});

describe('openDatabaseReadonly — zero writes', () => {
  it('leaves the database file byte-identical', () => {
    seedCurrent();
    // Checkpoint first, so the comparison is about this function and not about
    // WAL state left behind by the seeding connection.
    const prep = new BetterSqlite3(dbPath());
    prep.pragma('wal_checkpoint(TRUNCATE)');
    prep.close();

    const before = readFileSync(dbPath());
    const beforeMtime = statSync(dbPath()).mtimeMs;

    const { sqlite } = openDatabaseReadonly({ dbPath: dbPath() });
    sqlite.prepare('SELECT count(*) FROM songs').get();
    sqlite.close();

    expect(readFileSync(dbPath()).equals(before)).toBe(true);
    expect(statSync(dbPath()).mtimeMs).toBe(beforeMtime);
  });

  it('writes nothing when it refuses', () => {
    seedGoLegacyDb(dbPath());
    const before = readFileSync(dbPath());

    expect(() => openDatabaseReadonly({ dbPath: dbPath() })).toThrow(GoMigrationRequiredError);

    expect(readFileSync(dbPath()).equals(before)).toBe(true);
  });
});
