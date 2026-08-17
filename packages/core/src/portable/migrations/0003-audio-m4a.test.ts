// 0003 — the audio migration's ledger, and the flag that owes it.
//
// The three library shapes this has to get right (判据 48) are all here: a
// brand new library (daemon or `--direct`, same code path) must come out
// usable immediately, and a v0.2 library must come out owing the conversion.
// The fourth case is the crash window between the two, which is asserted to
// fail in the safe direction rather than to not exist.
//
// (Every `.exec(...)` below is better-sqlite3's Database#exec — SQL text, not
// child_process.)

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/index.js';
import { SchemaMismatchError } from '../errors.js';
import { LATEST_KNOWN_VERSION, applyForwardMigrations } from '../migrate.js';
import { AUDIO_MIGRATION_PENDING_KEY, isAudioMigrationPending } from '../pending.js';
import * as m0001 from './0001-init.js';
import * as m0002 from './0002-sync-activation.js';
import * as m0003 from './0003-audio-m4a.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-0003-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, 'songs.db');

/** A v0.2 library: schema v2 with one song in it. */
function makeV2Library(path: string): string {
  const songId = randomUUID();
  const sqlite = new BetterSqlite3(path);
  try {
    applyForwardMigrations(sqlite, 0, 2, [m0001, m0002]);
    sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, source_provider, source_key,
           file_origin, created_at, updated_at)
         VALUES (?, '歌', '手', 'bilibili', 'BV1x:9', 'downloaded', 1000, 1000)`,
      )
      .run(songId);
  } finally {
    sqlite.close();
  }
  return songId;
}

function flag(sqlite: BetterSqlite3.Database): string | undefined {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(AUDIO_MIGRATION_PENDING_KEY) as { value: string } | undefined;
  return row?.value;
}

function tableExists(sqlite: BetterSqlite3.Database, table: string): boolean {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).length > 0;
}

describe('0003 — a brand new library', () => {
  // Both front-ends reach this through createDatabase: the daemon on boot and
  // a `lark --direct` write on a nest that has never been opened. Neither may
  // land in a migration state, because there is nothing to migrate.
  it('creates the ledger and clears the flag again', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
      expect(tableExists(sqlite, 'audio_migration')).toBe(true);
      expect(isAudioMigrationPending(sqlite)).toBe(false);
      // Cleared, not deleted: "we cleared this" and "this was never set" are
      // different facts about a library.
      expect(flag(sqlite)).toBe('0');
    } finally {
      sqlite.close();
    }
  });

  it('starts with an empty ledger', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      const n = sqlite.prepare('SELECT count(*) AS n FROM audio_migration').get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('reopens without setting the flag again', () => {
    const first = createDatabase({ dbPath: dbPath() });
    first.sqlite.close();
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      expect(isAudioMigrationPending(sqlite)).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe('0003 — upgrading a v0.2 library', () => {
  it('keeps the songs and comes out owing the conversion', () => {
    const songId = makeV2Library(dbPath());

    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
      expect(isAudioMigrationPending(sqlite)).toBe(true);
      const song = sqlite.prepare('SELECT name FROM songs WHERE id=?').get(songId) as {
        name: string;
      };
      expect(song.name).toBe('歌');
    } finally {
      sqlite.close();
    }
  });

  // The scan is what populates it, and the scan has not run yet. A migration
  // that pre-filled rows from the songs table would miss every object that is
  // NOT a library song — the orphan directories the scanner exists to find.
  it('leaves the ledger for the scanner to fill', () => {
    makeV2Library(dbPath());
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      const n = sqlite.prepare('SELECT count(*) AS n FROM audio_migration').get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe('0003 — the flag and the version stamp are one transaction', () => {
  // The window this rules out: v3 committed, flag not yet written, process
  // dies. Such a library would open as an ordinary current-schema library and
  // nothing would ever look at its mp3 files again.
  it('rolls back the version stamp too when the migration fails', () => {
    makeV2Library(dbPath());
    const broken = { version: 3, sql: `${m0003.sql}\nSELECT no_such_function();` };

    const sqlite = new BetterSqlite3(dbPath());
    try {
      expect(() => applyForwardMigrations(sqlite, 2, 3, [broken])).toThrow();
      expect(sqlite.pragma('user_version', { simple: true })).toBe(2);
      expect(flag(sqlite)).toBeUndefined();
      expect(tableExists(sqlite, 'audio_migration')).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  // And the window that IS left open, on purpose: a fresh library whose clear
  // never ran. It costs one scan of an empty songs/ directory — the error is
  // in the direction of migrating too often, never of skipping.
  it('leaves a fresh library pending if the clear never ran', () => {
    const raw = new BetterSqlite3(dbPath());
    try {
      applyForwardMigrations(raw, 0, LATEST_KNOWN_VERSION);
    } finally {
      raw.close();
    }

    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      // Not brand new to THIS call, so the clear does not run: the library
      // boots into the migration, scans nothing, and clears the flag itself.
      expect(isAudioMigrationPending(sqlite)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

describe('0003 — the ledger holds its domains closed', () => {
  const row = (over: Record<string, string | number | null>) => ({
    object_key: 'k',
    song_id: null,
    class: 'R',
    status: 'pending',
    error_class: null,
    at: 1,
    ...over,
  });

  function insert(sqlite: BetterSqlite3.Database, values: Record<string, string | number | null>) {
    sqlite
      .prepare(
        `INSERT INTO audio_migration (object_key, song_id, class, status, error_class, at)
         VALUES (@object_key, @song_id, @class, @status, @error_class, @at)`,
      )
      .run(values);
  }

  it.each([
    ['class', row({ class: 'maybe' })],
    ['status', row({ status: 'almost' })],
    ['error_class', row({ error_class: 'weather' })],
  ])('refuses an unknown %s', (_name, values) => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(() => insert(sqlite, values)).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });

  // song_id is NOT a foreign key on purpose: an old file-effect journal can
  // name a song that was deleted, and that object still has to be tracked.
  it('accepts a row whose song no longer exists', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(() => insert(sqlite, row({ song_id: randomUUID() }))).not.toThrow();
      expect(() =>
        insert(sqlite, row({ object_key: 'k2', song_id: null, class: 'orphan' })),
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});

describe('0003 — the signature covers the ledger', () => {
  it('refuses to open a v3 database that lost it', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();

    const raw = new BetterSqlite3(dbPath());
    try {
      raw.exec('DROP TABLE audio_migration');
    } finally {
      raw.close();
    }

    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });
});
