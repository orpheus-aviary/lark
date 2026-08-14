// 0002 — sync activation.
//
// Two paths have to land on the same schema: a fresh database (0 → 2 in one
// run) and a real v0.1 library upgraded in place (1 → 2, with rows in it). The
// upgrade is the interesting one — it drops and rebuilds two objects, and a
// library that lost its songs on the way would be unrecoverable.
//
// (Every `.exec(...)` below is better-sqlite3's Database#exec — SQL text, not
// child_process.)

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchemaMismatchError } from '../../errors.js';
import { createDatabase } from '../index.js';
import { LATEST_KNOWN_VERSION, applyForwardMigrations } from '../migrate.js';
import * as m0001 from './0001-init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-0002-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, 'songs.db');

/** A v0.1 library: schema v1 plus one song, one playlist, one membership. */
function makeV1Library(path: string): { songId: string; playlistId: string } {
  const songId = randomUUID();
  const playlistId = randomUUID();
  const sqlite = new BetterSqlite3(path);
  try {
    applyForwardMigrations(sqlite, 0, 1, [m0001]);
    sqlite
      .prepare(
        `INSERT INTO songs (id, name, artist, source_provider, source_key,
           file_origin, created_at, updated_at)
         VALUES (?, '歌', '手', 'bilibili', 'BV1x:9', 'imported', 1000, 1000)`,
      )
      .run(songId);
    sqlite
      .prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, 1000, 1000)')
      .run(playlistId, '单');
    sqlite
      .prepare(
        `INSERT INTO playlist_songs (playlist_id, song_id, rank, added_at, updated_at)
         VALUES (?, ?, 1024, 1000, 1000)`,
      )
      .run(playlistId, songId);
  } finally {
    sqlite.close();
  }
  return { songId, playlistId };
}

function columns(sqlite: BetterSqlite3.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function count(sqlite: BetterSqlite3.Database, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('0002 — fresh database', () => {
  it('creates the four sync tables and seeds the backfill generations', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
      for (const table of [
        'sync_tombstones',
        'sync_file_ops',
        'sync_dead_letters',
        'sync_binding',
      ]) {
        expect(columns(sqlite, table).length).toBeGreaterThan(0);
      }

      const generations = sqlite
        .prepare(
          `SELECT key, value FROM local_metadata
           WHERE key LIKE 'sync_backfill_%' ORDER BY key`,
        )
        .all() as { key: string; value: string }[];
      // done < target is what makes the first login run the full backfill.
      expect(generations).toEqual([
        { key: 'sync_backfill_done_generation', value: '0' },
        { key: 'sync_backfill_target_generation', value: '1' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keys the cursor by (server_id, workspace_id), not by endpoint', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(columns(sqlite, 'sync_cursor')).toEqual([
        'server_id',
        'workspace_id',
        'pulled_seq',
        'pushed_seq',
        'updated_at',
      ]);
      const pk = (sqlite.pragma('table_info(sync_cursor)') as { name: string; pk: number }[])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk).toEqual(['server_id', 'workspace_id']);
    } finally {
      sqlite.close();
    }
  });

  it('gives conflict_record the full LWW key', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      const cols = columns(sqlite, 'conflict_record');
      for (const col of [
        'local_lww_counter',
        'remote_lww_counter',
        'local_device_id',
        'remote_device_id',
      ]) {
        expect(cols).toContain(col);
      }
    } finally {
      sqlite.close();
    }
  });

  it('holds the domains of the new tables closed', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sync_tombstones (entity_type, entity_id, updated_at, deleted_at)
             VALUES ('lyrics', 'x', 1, 1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sync_dead_letters (direction, reason, recorded_at)
             VALUES ('sideways', 'r', 1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sync_file_ops (kind, song_id, created_at)
             VALUES ('rm_minus_rf', 'x', 1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });

  it('refuses a second binding row', () => {
    const { sqlite } = createDatabase({ dbPath: ':memory:' });
    try {
      const insert = sqlite.prepare(
        `INSERT INTO sync_binding (id, server_id, user_id, workspace_id, schema_version, bound_at)
         VALUES (?, 's', 'u', 'w', 1, 1)`,
      );
      insert.run(1);
      // Two bindings would mean one library quietly serving two workspaces.
      expect(() => insert.run(2)).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });
});

describe('0002 — upgrading a v0.1 library in place', () => {
  it('keeps every row while rebuilding the cursor and the source-key index', () => {
    const { songId, playlistId } = makeV1Library(dbPath());

    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      expect(sqlite.pragma('user_version', { simple: true })).toBe(LATEST_KNOWN_VERSION);
      expect(count(sqlite, 'songs')).toBe(1);
      expect(count(sqlite, 'playlists')).toBe(1);
      expect(count(sqlite, 'playlist_songs')).toBe(1);
      const song = sqlite.prepare('SELECT name, file_origin FROM songs WHERE id=?').get(songId) as {
        name: string;
        file_origin: string;
      };
      expect(song).toEqual({ name: '歌', file_origin: 'imported' });
      expect(columns(sqlite, 'sync_cursor')).toContain('server_id');
      const membership = sqlite
        .prepare('SELECT rank FROM playlist_songs WHERE playlist_id=? AND song_id=?')
        .get(playlistId, songId) as { rank: number };
      expect(membership.rank).toBe(1024);

      // The UNIQUE index is gone on the upgrade path too — the drop/recreate
      // pair is the part that only runs here.
      sqlite
        .prepare(
          `INSERT INTO songs (id, name, artist, source_provider, source_key,
             file_origin, created_at, updated_at)
           VALUES (?, '同一首', '手', 'bilibili', 'BV1x:9', 'downloaded', 2000, 2000)`,
        )
        .run(randomUUID());
      expect(count(sqlite, 'songs')).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it('writes no outbox rows — the backfill is a login-time job, not a migration', () => {
    makeV1Library(dbPath());
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      // R4-1: a migration that wrote sync_changes could neither see the lyrics
      // files nor be re-run after an unbind. The generations carry that debt
      // instead.
      expect(count(sqlite, 'sync_changes')).toBe(0);
      expect(count(sqlite, 'sync_tombstones')).toBe(0);
      const done = sqlite
        .prepare("SELECT value FROM local_metadata WHERE key='sync_backfill_done_generation'")
        .get() as { value: string };
      expect(done.value).toBe('0');
    } finally {
      sqlite.close();
    }
  });
});

describe('0002 — the signature covers the new tables', () => {
  it('refuses to open a v2 database that lost a sync table', () => {
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    sqlite.close();

    const raw = new BetterSqlite3(dbPath());
    try {
      raw.exec('DROP TABLE sync_tombstones');
    } finally {
      raw.close();
    }

    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(SchemaMismatchError);
  });
});
