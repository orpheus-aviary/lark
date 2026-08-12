// Go migration protocol tests (T5, owl-style numbered scenarios). Every run
// works in a mkdtemp dir — the path-derivation discipline in migrate-go.ts
// means nothing here can reach the real nest. httpProbe is off throughout:
// the 47020 probe is machine-global, and the REAL Go daemon may well be
// running while these tests execute.
//
// (`.exec` below is better-sqlite3's Database#exec — SQL, not child_process;
// subprocesses are spawned via spawn() with argument arrays, no shell.)

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoMigrationRequiredError,
  MigrationBusyError,
  SchemaMismatchError,
  SourceDbCorruptionError,
} from '../errors.js';
import { REAL_SAMPLE_TIMESTAMP, defaultGoSeed, seedGoLegacyDb } from './fixture-go-db.js';
import { createDatabase } from './index.js';
import { type GoMigrateOptions, migrateFromGoDb, parseRfc3339 } from './migrate-go.js';
import { acquireMigrateLock, migrateLockPath } from './migrate-lock.js';
import { migratingPath, oldSwapPath } from './recovery.js';

const OPTS: GoMigrateOptions = { httpProbe: false };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lark-migrate-go-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, 'songs.db');

function rawOpen(path: string): BetterSqlite3.Database {
  return new BetterSqlite3(path, { readonly: true, fileMustExist: true });
}

function countsOf(path: string): { v: number; songs: number; playlists: number; members: number } {
  const sqlite = rawOpen(path);
  try {
    const n = (t: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      v: sqlite.pragma('user_version', { simple: true }) as number,
      songs: n('songs'),
      playlists: n('playlists'),
      members: n('playlist_songs'),
    };
  } finally {
    sqlite.close();
  }
}

/** Child source: open the lock db, BEGIN EXCLUSIVE, signal, stay alive. */
const HOLD_LOCK_SRC = `
const D = require('better-sqlite3');
const db = new D(process.argv[1]);
db.pragma('busy_timeout = 0');
db.exec('BEGIN EXCLUSIVE');
console.log('locked');
setInterval(() => {}, 1 << 30);
`;

function waitForOutput(stream: Readable, needle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += String(chunk);
      if (buf.includes(needle)) resolve();
    });
    stream.on('end', () => reject(new Error(`stream ended without '${needle}': ${buf}`)));
  });
}

async function spawnLockHolder(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', HOLD_LOCK_SRC, migrateLockPath(path)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(child.stdout as Readable, 'locked');
  return child;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

describe('parseRfc3339', () => {
  it('respects the +08:00 offset (never read as UTC)', () => {
    expect(parseRfc3339(REAL_SAMPLE_TIMESTAMP)).toBe(Date.UTC(2026, 1, 22, 19, 53, 29));
    expect(parseRfc3339('2026-02-23T03:53:29Z')).toBe(Date.UTC(2026, 1, 23, 3, 53, 29));
  });

  it('rejects non-RFC3339 shapes', () => {
    expect(parseRfc3339('2026-02-23 03:53:29')).toBeNull();
    expect(parseRfc3339('')).toBeNull();
    expect(parseRfc3339(null)).toBeNull();
    expect(parseRfc3339(1234)).toBeNull();
  });
});

describe('T5.1 happy path reconciliation', () => {
  it('migrates 20/3/24 into 20/2/4 with exact field mapping', async () => {
    const seed = seedGoLegacyDb(dbPath());
    const result = await migrateFromGoDb(dbPath(), OPTS);
    expect(result.songs).toBe(20);
    expect(result.playlists).toBe(2);
    expect(result.memberships).toBe(4);
    expect(result.already_migrated).toBeUndefined();
    expect(result.backup_path).toContain('songs.db.bak-go-');

    // backup: openable, source-shaped, user_version 0
    expect(countsOf(result.backup_path)).toEqual({ v: 0, songs: 20, playlists: 3, members: 24 });

    // no residue
    expect(existsSync(migratingPath(dbPath()))).toBe(false);
    expect(existsSync(oldSwapPath(dbPath()))).toBe(false);

    // opens as a valid v1 db (createDatabase runs assertSchemaV2)
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      // field mapping on the real-sample song
      const s0 = sqlite.prepare('SELECT * FROM songs WHERE id=?').get(seed.songs[0].id) as Record<
        string,
        unknown
      >;
      expect(s0.created_at).toBe(Date.UTC(2026, 1, 22, 19, 53, 29)); // +08:00 conversion
      expect(s0.updated_at).toBe(s0.created_at);
      expect(s0.last_accessed_at).toBe(s0.created_at);
      expect(s0.file_origin).toBe('imported');
      expect(s0.device_id).toBeNull();
      expect(s0.lww_counter).toBe(0);
      expect(s0.source_provider).toBeNull();
      expect(s0.artist).toBe(''); // empty artist survives as ''

      const s1 = sqlite.prepare('SELECT * FROM songs WHERE id=?').get(seed.songs[1].id) as Record<
        string,
        unknown
      >;
      expect(s1.lyrics_offset).toBe(-26.5); // negative offset is legal

      // the is_system 'all' playlist and its members were dropped
      const allRow = sqlite
        .prepare('SELECT count(*) AS n FROM playlists WHERE id=?')
        .get(seed.playlists[0].id) as { n: number };
      expect(allRow.n).toBe(0);

      // rank = (position+1)*1024 for the 收藏 playlist (positions 2, 5)
      const ranks = sqlite
        .prepare('SELECT rank FROM playlist_songs WHERE playlist_id=? ORDER BY rank')
        .all(seed.playlists[1].id) as { rank: number }[];
      expect(ranks.map((r) => r.rank)).toEqual([3 * 1024, 6 * 1024]);
    } finally {
      sqlite.close();
    }
  });
});

describe('T5.2 idempotent re-run', () => {
  it('short-circuits as already-migrated', async () => {
    seedGoLegacyDb(dbPath());
    await migrateFromGoDb(dbPath(), OPTS);
    const second = await migrateFromGoDb(dbPath(), OPTS);
    expect(second.already_migrated).toBe(true);
    expect(second.songs).toBe(20);
    expect(second.playlists).toBe(2);
    expect(second.memberships).toBe(4);
    expect(second.backup_path).toBe('');
  });
});

describe('T5.3 migration lock collision', () => {
  it('reports busy while another holder has the lock', async () => {
    seedGoLegacyDb(dbPath());
    const lock = acquireMigrateLock(dbPath());
    try {
      await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toMatchObject({
        name: 'MigrationBusyError',
        reason: 'migrate_lock_busy',
      });
    } finally {
      lock.release();
    }
    await expect(migrateFromGoDb(dbPath(), OPTS)).resolves.toMatchObject({ songs: 20 });
  });
});

describe('T5.4 lock survives nothing — kill -9 releases it', () => {
  it('an immediate retry after SIGKILL succeeds (kernel fcntl release)', async () => {
    seedGoLegacyDb(dbPath());
    const child = await spawnLockHolder(dbPath());
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toMatchObject({
      reason: 'migrate_lock_busy',
    });
    await killAndWait(child);
    await expect(migrateFromGoDb(dbPath(), OPTS)).resolves.toMatchObject({ songs: 20 });
  });
});

describe('T5.5 old daemon probe', () => {
  it('refuses while daemon.pid points at a live process', async () => {
    seedGoLegacyDb(dbPath());
    writeFileSync(join(dir, 'daemon.pid'), String(process.pid));
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toMatchObject({
      reason: 'daemon_alive',
    });
  });

  it('cleans a stale daemon.pid and proceeds', async () => {
    seedGoLegacyDb(dbPath());
    writeFileSync(join(dir, 'daemon.pid'), '999999'); // beyond macOS pid space
    await expect(migrateFromGoDb(dbPath(), OPTS)).resolves.toMatchObject({ songs: 20 });
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
  });
});

describe('T5.6 external write transaction blocks the exclusive lock', () => {
  it('reports exclusive_lock_busy against a BEGIN IMMEDIATE holder', async () => {
    seedGoLegacyDb(dbPath());
    const ext = new BetterSqlite3(dbPath());
    try {
      ext.exec('BEGIN IMMEDIATE');
      ext
        .prepare("INSERT INTO playlists (id, list_name, is_system) VALUES ('tmp', 'tmp', 0)")
        .run();
      await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toMatchObject({
        reason: 'exclusive_lock_busy',
      });
      ext.exec('ROLLBACK');
    } finally {
      ext.close();
    }
    await expect(migrateFromGoDb(dbPath(), OPTS)).resolves.toMatchObject({ songs: 20 });
  });
});

describe('T5.7 source shape tolerance and aborts', () => {
  it('tolerates a missing duration column (pre-ALTER library): all durations 0', async () => {
    const seed = seedGoLegacyDb(dbPath(), defaultGoSeed(), { withoutDuration: true });
    await migrateFromGoDb(dbPath(), OPTS);
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      const row = sqlite.prepare('SELECT duration FROM songs WHERE id=?').get(seed.songs[5].id) as {
        duration: number;
      };
      expect(row.duration).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('aborts on a missing name column', async () => {
    seedGoLegacyDb(dbPath());
    const sqlite = new BetterSqlite3(dbPath());
    sqlite.exec('ALTER TABLE songs DROP COLUMN name');
    sqlite.close();
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toThrow(SchemaMismatchError);
    expect(countsOf(dbPath()).v).toBe(0); // source untouched
  });

  it('falls back to migration time on an unparseable created_at, with a log', async () => {
    const seed = defaultGoSeed();
    seed.songs[2].created_at = 'not-a-timestamp';
    seedGoLegacyDb(dbPath(), seed);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const before = Date.now();
    await migrateFromGoDb(dbPath(), { ...OPTS, logger });
    const { sqlite } = createDatabase({ dbPath: dbPath() });
    try {
      const row = sqlite
        .prepare('SELECT created_at FROM songs WHERE id=?')
        .get(seed.songs[2].id) as { created_at: number };
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(Date.now());
    } finally {
      sqlite.close();
    }
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ song: seed.songs[2].id }),
      expect.stringContaining('created_at'),
    );
  });

  it('aborts on a non-UUID song id, naming it', async () => {
    const seed = defaultGoSeed();
    const originalId = seed.songs[0].id;
    seed.songs[0].id = 'not-a-uuid';
    seed.members = seed.members.map((m) =>
      m.song_id === originalId ? { ...m, song_id: 'not-a-uuid' } : m,
    );
    seedGoLegacyDb(dbPath(), seed);
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toThrow(/not-a-uuid/);
    expect(countsOf(dbPath()).v).toBe(0);
    expect(existsSync(migratingPath(dbPath()))).toBe(false); // temp cleaned
  });

  it('aborts on a NULL name, naming the song id', async () => {
    const seed = defaultGoSeed();
    seed.songs[1].name = null;
    seedGoLegacyDb(dbPath(), seed, { nullableName: true });
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toThrow(seed.songs[1].id);
    expect(countsOf(dbPath()).v).toBe(0);
  });

  it('aborts on duplicate positions (ranks not strictly increasing)', async () => {
    const seed = defaultGoSeed();
    // 收藏 playlist: both members at position 2
    const p1 = seed.playlists[1].id;
    for (const m of seed.members) {
      if (m.playlist_id === p1) m.position = 2;
    }
    seedGoLegacyDb(dbPath(), seed);
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toThrow(SourceDbCorruptionError);
    expect(countsOf(dbPath())).toEqual({ v: 0, songs: 20, playlists: 3, members: 24 });
  });
});

describe('T5.8 swap failure handling', () => {
  it('first rename blocked: source untouched, temp cleaned', async () => {
    seedGoLegacyDb(dbPath());
    // a non-empty directory at the old-swap path blocks rename #1 (owl T6)
    mkdirSync(oldSwapPath(dbPath()));
    writeFileSync(join(oldSwapPath(dbPath()), 'occupied'), 'x');
    await expect(migrateFromGoDb(dbPath(), OPTS)).rejects.toThrow();
    expect(countsOf(dbPath())).toEqual({ v: 0, songs: 20, playlists: 3, members: 24 });
    expect(existsSync(migratingPath(dbPath()))).toBe(false);
  });

  it('second rename failure: old-swap restored in place, library intact', async () => {
    seedGoLegacyDb(dbPath());
    const { renameSync: realRename } = await import('node:fs');
    const failingRename = ((from: string, to: string) => {
      if (from === migratingPath(dbPath()) && to === dbPath()) {
        throw new Error('injected rename failure');
      }
      realRename(from, to);
    }) as typeof realRename;
    await expect(
      migrateFromGoDb(dbPath(), { ...OPTS, fsOps: { renameSync: failingRename } }),
    ).rejects.toThrow('injected rename failure');
    // the original came back; nothing else remains
    expect(countsOf(dbPath())).toEqual({ v: 0, songs: 20, playlists: 3, members: 24 });
    expect(existsSync(oldSwapPath(dbPath()))).toBe(false);
    expect(existsSync(migratingPath(dbPath()))).toBe(false);
  });
});

describe('T5.9 migration-in-flight × createDatabase (deterministic barrier)', () => {
  it('createDatabase reports busy and leaves residue untouched while the lock is held', async () => {
    seedGoLegacyDb(dbPath());
    writeFileSync(migratingPath(dbPath()), 'in-flight temp db');
    const child = await spawnLockHolder(dbPath());
    try {
      expect(() => createDatabase({ dbPath: dbPath() })).toThrow(MigrationBusyError);
      expect(existsSync(migratingPath(dbPath()))).toBe(true); // untouched
    } finally {
      await killAndWait(child);
    }
    // lock gone: recovery clears the orphan, then the Go db is refused as usual
    expect(() => createDatabase({ dbPath: dbPath() })).toThrow(GoMigrationRequiredError);
    expect(existsSync(migratingPath(dbPath()))).toBe(false);
  });
});
