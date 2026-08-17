// (Every `.exec(...)` below is better-sqlite3's Database#exec — SQL text, not
// child_process.)

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUuidV4 } from '@lark/shared';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DestructiveForwardMigrationError,
  ForwardMigrationError,
  GoMigrationRequiredError,
  IncompatibleDbError,
  MigrationBusyError,
  MigrationResidueError,
  SchemaMismatchError,
} from '../errors.js';
import { LATEST_KNOWN_VERSION, applyForwardMigrations } from '../portable/migrate.js';
import * as m0001 from '../portable/migrations/0001-init.js';
import { createDatabase, ensureDeviceUuid } from './index.js';
import { acquireMigrateLock } from './migrate-lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-db-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, 'songs.db');

/** Build a valid db at the current schema version at `path` and close it. */
function makeCurrentDb(path: string): void {
  const { sqlite } = createDatabase({ dbPath: path });
  sqlite.close();
}

/** Run `mutate` on a raw connection to `path`, then close. */
function mutateRaw(path: string, mutate: (sqlite: BetterSqlite3.Database) => void): void {
  const sqlite = new BetterSqlite3(path);
  try {
    mutate(sqlite);
  } finally {
    sqlite.close();
  }
}

/** Minimal Go-era library fingerprint (the real fixture lands in T5). */
function makeGoLegacyDb(path: string): void {
  mutateRaw(path, (sqlite) => {
    sqlite.exec(`
      CREATE TABLE songs (id TEXT PRIMARY KEY, name TEXT, artist TEXT DEFAULT '',
        created_at TEXT, lyrics_offset REAL, duration REAL);
      CREATE TABLE playlists (id TEXT PRIMARY KEY, list_name TEXT, is_system INTEGER);
      CREATE TABLE playlist_songs (playlist_id TEXT, song_id TEXT, position INTEGER,
        PRIMARY KEY (playlist_id, song_id));
    `);
  });
}

function insertSong(sqlite: BetterSqlite3.Database, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    name: 'song',
    artist: '',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'downloaded',
    pinned: 0,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO songs (id, name, artist, source_url, source_provider, source_key,
         file_origin, pinned, created_at, updated_at)
       VALUES (@id, @name, @artist, @source_url, @source_provider, @source_key,
         @file_origin, @pinned, @created_at, @updated_at)`,
    )
    .run(row);
}

describe('createDatabase — fresh databases', () => {
  it('brings a new file db to the latest user_version, WAL, with a valid device_uuid', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
      expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      const uuid = sqlite
        .prepare("SELECT value FROM local_metadata WHERE key='device_uuid'")
        .get() as { value: string };
      expect(isUuidV4(uuid.value)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('supports :memory: (skips the file recovery step)', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
    } finally {
      sqlite.close();
    }
  });

  it('reopening an existing db keeps the same device_uuid', () => {
    const first = createDatabase({ dbPath: dbPath() });
    const uuid1 = ensureDeviceUuid(first.sqlite);
    first.sqlite.close();
    const second = createDatabase({ dbPath: dbPath() });
    try {
      expect(ensureDeviceUuid(second.sqlite)).toBe(uuid1);
    } finally {
      second.sqlite.close();
    }
  });
});

describe('schema v2 constraints', () => {
  it('enforces the file_origin, pinned, and source pair CHECKs', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(() => insertSong(sqlite, { file_origin: 'bogus' })).toThrow(/CHECK/);
      expect(() => insertSong(sqlite, { pinned: 2 })).toThrow(/CHECK/);
      expect(() => insertSong(sqlite, { source_provider: 'bilibili', source_key: null })).toThrow(
        /CHECK/,
      );
      expect(() => insertSong(sqlite, { source_provider: null, source_key: 'BV1:2' })).toThrow(
        /CHECK/,
      );
    } finally {
      sqlite.close();
    }
  });

  it('no longer refuses a duplicate (source_provider, source_key) at the db level (D8)', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      // v2 dropped the UNIQUE index: two offline devices can each download the
      // same video, and the merge has no order-independent answer, so the
      // duplicate is allowed to land and is surfaced instead. The local write
      // paths still refuse one — only sync can produce it.
      insertSong(sqlite, { source_provider: 'bilibili', source_key: 'BVx:1' });
      insertSong(sqlite, { source_provider: 'bilibili', source_key: 'BVx:1' });
      const n = sqlite
        .prepare("SELECT count(*) AS n FROM songs WHERE source_key='BVx:1'")
        .get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});

describe('createDatabase — refusal paths write nothing', () => {
  function expectZeroWrite(setup: (path: string) => void, expectedError: unknown): void {
    const path = dbPath();
    setup(path);
    const before = readFileSync(path);
    expect(() => createDatabase({ dbPath: path })).toThrow(expectedError as never);
    expect(readFileSync(path).equals(before)).toBe(true); // includes the journal-mode header bytes
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  }

  it('refuses a future db (user_version > LATEST) byte-identically', () => {
    expectZeroWrite((p) => {
      mutateRaw(p, (sqlite) => {
        sqlite.exec('CREATE TABLE t (x)');
        sqlite.pragma('user_version = 99');
      });
    }, IncompatibleDbError);
  });

  it('refuses the Go legacy library byte-identically', () => {
    expectZeroWrite((p) => makeGoLegacyDb(p), GoMigrationRequiredError);
  });

  it('refuses an unknown v0 non-empty db byte-identically', () => {
    expectZeroWrite((p) => {
      mutateRaw(p, (sqlite) => {
        sqlite.exec('CREATE TABLE mystery (x)');
      });
    }, IncompatibleDbError);
  });
});

describe('forward migration runner', () => {
  it('a failing migration rolls back atomically with its version stamp', () => {
    const sqlite = new BetterSqlite3(':memory:');
    try {
      const bad = { version: 2, sql: 'CREATE TABLE will_rollback (x);\nTHIS IS NOT SQL;' };
      expect(() => applyForwardMigrations(sqlite, 0, 2, [m0001, bad])).toThrow(
        ForwardMigrationError,
      );
      // v1 committed, v2 rolled back as a unit — no half schema at the old number
      expect(sqlite.pragma('user_version', { simple: true })).toBe(1);
      const leftover = sqlite
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='will_rollback'")
        .get() as { n: number };
      expect(leftover.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('refuses a migration carrying the destructive marker', () => {
    const sqlite = new BetterSqlite3(':memory:');
    try {
      const destructive = {
        version: 2,
        sql: '-- requires_confirmation: true\nCREATE TABLE x (y);',
      };
      expect(() => applyForwardMigrations(sqlite, 0, 2, [m0001, destructive])).toThrow(
        DestructiveForwardMigrationError,
      );
      expect(sqlite.pragma('user_version', { simple: true })).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('throws on a hole in the registry', () => {
    const sqlite = new BetterSqlite3(':memory:');
    try {
      expect(() => applyForwardMigrations(sqlite, 0, 2, [m0001])).toThrow(/registry/);
    } finally {
      sqlite.close();
    }
  });
});

describe('assertCurrentSchema via the ==LATEST open path', () => {
  it('rejects a same-name UNIQUE index smuggled in for the plain one', () => {
    // The inverse of the v1 check, and it matters more: a UNIQUE index here
    // would make an inbound duplicate impossible to apply, which is a stuck
    // sync rather than a visible duplicate (D8).
    makeCurrentDb(dbPath());
    mutateRaw(dbPath(), (sqlite) => {
      sqlite.exec(`
        DROP INDEX idx_songs_source_key;
        CREATE UNIQUE INDEX idx_songs_source_key ON songs(source_provider, source_key)
          WHERE source_provider IS NOT NULL;
      `);
    });
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });

  it('rejects a missing index', () => {
    makeCurrentDb(dbPath());
    mutateRaw(dbPath(), (sqlite) => {
      sqlite.exec('DROP INDEX idx_sync_changes_pending');
    });
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });

  it('rejects a dropped sync table — v1 is all 7 tables, not 4', () => {
    makeCurrentDb(dbPath());
    mutateRaw(dbPath(), (sqlite) => {
      sqlite.exec('DROP TABLE sync_cursor');
    });
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });
});

describe('crash recovery state machine (M1-10)', () => {
  const migrating = () => `${dbPath()}.migrating`;
  const oldSwap = () => `${dbPath()}.old-swap`;

  it('main + migrating: drops the orphan .migrating (source untouched)', () => {
    makeCurrentDb(dbPath());
    writeFileSync(migrating(), 'junk');
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();
    expect(existsSync(migrating())).toBe(false);
  });

  it('valid main + old-swap: archives old-swap as a recovery backup, never deletes', () => {
    makeCurrentDb(dbPath());
    writeFileSync(oldSwap(), 'the old library bytes');
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();
    expect(existsSync(oldSwap())).toBe(false);
    const archives = readdirSync(dir).filter((f) => f.startsWith('songs.db.old-swap.bak-'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(dir, archives[0]), 'utf-8')).toBe('the old library bytes');
  });

  it('invalid main + old-swap: fail-closed, both files kept', () => {
    // main at v0-empty fails the read-only validation (wrong user_version)
    mutateRaw(dbPath(), (sqlite) => {
      sqlite.exec('CREATE TABLE t (x)');
    });
    writeFileSync(oldSwap(), 'old library');
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(MigrationResidueError);
    expect(existsSync(dbPath())).toBe(true);
    expect(existsSync(oldSwap())).toBe(true);
  });

  it('old-swap only: restores it as main', () => {
    makeCurrentDb(dbPath());
    const bytes = readFileSync(dbPath());
    rmSync(dbPath());
    writeFileSync(oldSwap(), bytes);
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();
    expect(existsSync(oldSwap())).toBe(false);
    expect(existsSync(dbPath())).toBe(true);
  });

  it('old-swap + migrating: restores old-swap, drops migrating', () => {
    makeCurrentDb(dbPath());
    const bytes = readFileSync(dbPath());
    rmSync(dbPath());
    writeFileSync(oldSwap(), bytes);
    writeFileSync(migrating(), 'half-built temp db');
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();
    expect(existsSync(oldSwap())).toBe(false);
    expect(existsSync(migrating())).toBe(false);
  });

  it('migrating only: fail-closed — never deleted, no empty main created', () => {
    writeFileSync(migrating(), 'possibly the only copy of the library');
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(MigrationResidueError);
    expect(existsSync(migrating())).toBe(true);
    expect(existsSync(dbPath())).toBe(false);
  });

  it('all three present: fail-closed, nothing touched', () => {
    makeCurrentDb(dbPath());
    writeFileSync(migrating(), 'a');
    writeFileSync(oldSwap(), 'b');
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(MigrationResidueError);
    expect(existsSync(migrating())).toBe(true);
    expect(existsSync(oldSwap())).toBe(true);
  });

  it('refuses to touch residue while the migration lock is held', () => {
    makeCurrentDb(dbPath());
    writeFileSync(migrating(), 'in-flight migration temp');
    const lock = acquireMigrateLock(dbPath());
    try {
      expect(() => createDatabase({ dbPath: dbPath() })).toThrow(MigrationBusyError);
      expect(existsSync(migrating())).toBe(true);
    } finally {
      lock.release();
    }
    // lock released: recovery proceeds normally
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();
    expect(existsSync(migrating())).toBe(false);
  });
});

describe('ensureDeviceUuid', () => {
  it('keeps a valid stored value', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      const first = ensureDeviceUuid(sqlite);
      expect(ensureDeviceUuid(sqlite)).toBe(first);
    } finally {
      sqlite.close();
    }
  });

  it('regenerates an invalid stored value', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      sqlite.prepare("UPDATE local_metadata SET value='not-a-uuid' WHERE key='device_uuid'").run();
      const regenerated = ensureDeviceUuid(sqlite);
      expect(isUuidV4(regenerated)).toBe(true);
      expect(regenerated).not.toBe('not-a-uuid');
    } finally {
      sqlite.close();
    }
  });

  it('regenerates an empty stored value', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      sqlite.prepare("UPDATE local_metadata SET value='' WHERE key='device_uuid'").run();
      expect(isUuidV4(ensureDeviceUuid(sqlite))).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
