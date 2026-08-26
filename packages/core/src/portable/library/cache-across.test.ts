// Criteria 119, 120 and 121 (N7f): one budget over several libraries.
//
// What is on trial is the ORDER (other workspaces first), the ARITHMETIC (the
// two figures a settings page shows add up to every byte on disk), and the one
// promise that makes reaching into somebody else's library safe at all — that
// nothing but a file is ever touched.

import type BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../db/index.js';
import type { FileContext, FileStat } from '../ports/fs.js';
import { type WorkspaceLibrary, cacheStatusAcross, runEvictionAcross } from './cache-across.js';
import type { CacheOptions } from './cache.js';

/** An in-memory disk: `<workspace>/<song>` → size, or gone. */
let disk: Map<string, number>;

function filesFor(workspaceId: string): FileContext {
  const key = (songId: string): string => `${workspaceId}/${songId}`;
  return {
    fs: {
      statSync: (path: string): FileStat | null => {
        const size = disk.get(path);
        return size === undefined ? null : { size };
      },
      unlinkSync: (path: string) => disk.delete(path),
      readText: () => Promise.resolve(null),
      writeTextAtomic: () => Promise.resolve(),
      unlink: (path: string) => Promise.resolve(disk.delete(path)),
    },
    paths: {
      songDir: (id) => key(id),
      songAudio: (id) => key(id),
      songLegacyAudio: (id) => key(id),
      songLyrics: (id) => `${key(id)}.lrc`,
    },
  };
}

interface Seed {
  id: string;
  size: number;
  lastUsed?: number;
  pinned?: boolean;
  origin?: 'downloaded' | 'imported';
}

/** The raw handle for each workspace, so a test can prove nothing wrote to it. */
const handles = new Map<string, BetterSqlite3.Database>();

function workspace(id: string, seeds: readonly Seed[]): WorkspaceLibrary {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  handles.set(id, sqlite);
  for (const seed of seeds) {
    sqlite
      .prepare(
        `INSERT INTO songs
           (id, name, artist, file_origin, source_provider, source_key, pinned,
            created_at, updated_at, last_accessed_at)
         VALUES (?, ?, '某人', ?, 'bilibili', ?, ?, 1, 1, ?)`,
      )
      .run(
        seed.id,
        seed.id,
        seed.origin ?? 'downloaded',
        `bv-${seed.id}:1`,
        seed.pinned === true ? 1 : 0,
        seed.lastUsed ?? 1,
      );
    disk.set(`${id}/${seed.id}`, seed.size);
  }
  return { id, files: filesFor(id), db };
}

const uuidOf = (n: number): string => `1111111${n}-2222-4333-8444-555555555555`;

const OPTS = (
  limitBytes: number,
): CacheOptions & {
  acquireFileClaim: () => { release: () => void };
  probe: () => Promise<boolean>;
} => ({
  limitBytes,
  isExcluded: () => false,
  streamCount: () => 0,
  acquireFileClaim: () => ({ release: () => {} }),
  probe: () => Promise.resolve(true),
});

beforeEach(() => {
  disk = new Map();
  handles.clear();
});

describe('what the settings page reports (119)', () => {
  it('splits this workspace from the rest, and the two add up', () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const a = workspace('a', [{ id: uuidOf(2), size: 30 }]);
    const b = workspace('b', [{ id: uuidOf(3), size: 70 }]);

    const status = cacheStatusAcross(current, [a, b], OPTS(0));

    expect(status.current.used_bytes).toBe(100);
    expect(status.other_bytes).toBe(100);
    expect(status.other_files).toBe(2);
    // Every byte of lark audio on this device, and nothing counted twice.
    expect(status.total_bytes).toBe(200);
  });

  it('judges the limit against the DEVICE, not against one library', () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [{ id: uuidOf(2), size: 100 }]);

    // Each library is inside 150 on its own; together they are not.
    expect(cacheStatusAcross(current, [other], OPTS(150)).limit_satisfied).toBe(false);
    expect(cacheStatusAcross(current, [other], OPTS(250)).limit_satisfied).toBe(true);
  });

  it('is unlimited when nobody has set a limit', () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    expect(cacheStatusAcross(current, [], OPTS(0)).limit_satisfied).toBe(true);
  });
});

describe('the order a drain frees things in (120)', () => {
  it('empties the other workspaces before touching this one', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100, lastUsed: 1 }]);
    const other = workspace('a', [{ id: uuidOf(2), size: 100, lastUsed: 999 }]);

    // 100 over. The other workspace's file is the NEWEST of the two, and it
    // still goes first — the order is by workspace, not by age across them.
    const run = await runEvictionAcross(current, { ...OPTS(100), others: [other] });

    expect(run.freed_bytes).toBe(100);
    expect(disk.has(`a/${uuidOf(2)}`)).toBe(false);
    expect(disk.has(`local/${uuidOf(1)}`)).toBe(true);
  });

  it('comes back to this one when the others were not enough', async () => {
    const current = workspace('local', [
      { id: uuidOf(1), size: 100, lastUsed: 1 },
      { id: uuidOf(2), size: 100, lastUsed: 2 },
    ]);
    const other = workspace('a', [{ id: uuidOf(3), size: 100 }]);

    const run = await runEvictionAcross(current, { ...OPTS(100), others: [other] });

    expect(run.freed_bytes).toBe(200);
    expect(disk.has(`a/${uuidOf(3)}`)).toBe(false);
    // Least recently used first, within this library.
    expect(disk.has(`local/${uuidOf(1)}`)).toBe(false);
    expect(disk.has(`local/${uuidOf(2)}`)).toBe(true);
  });

  it('takes no more of somebody else’s library than the device needs back', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [
      { id: uuidOf(2), size: 50, lastUsed: 1 },
      { id: uuidOf(3), size: 50, lastUsed: 2 },
    ]);

    // 200 used, limit 170: 30 owed, and one 50-byte file more than covers it.
    const run = await runEvictionAcross(current, { ...OPTS(170), others: [other] });

    expect(run.freed_bytes).toBe(50);
    expect(disk.has(`a/${uuidOf(2)}`)).toBe(false);
    expect(disk.has(`a/${uuidOf(3)}`)).toBe(true);
  });

  it('leaves pinned and imported files alone, in every workspace', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [
      { id: uuidOf(2), size: 100, pinned: true },
      { id: uuidOf(3), size: 100, origin: 'imported' },
    ]);

    // 300 used against a limit of 50: everything eligible goes, and the two
    // that are not eligible stay — R1 and the pin rule hold per workspace.
    const run = await runEvictionAcross(current, { ...OPTS(50), others: [other] });

    expect(disk.has(`a/${uuidOf(2)}`)).toBe(true);
    expect(disk.has(`a/${uuidOf(3)}`)).toBe(true);
    expect(disk.has(`local/${uuidOf(1)}`)).toBe(false);
    expect(run.total_bytes).toBe(200);
  });

  it('keeps a file whose source cannot be confirmed, in every workspace', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [{ id: uuidOf(2), size: 100 }]);

    // Fail-closed (R26): an unreachable network and a dead key look the same.
    const run = await runEvictionAcross(current, {
      ...OPTS(50),
      others: [other],
      probe: () => Promise.resolve(false),
    });

    expect(run.freed_bytes).toBe(0);
    expect(disk.size).toBe(2);
    expect(run.runs.flatMap((entry) => entry.run.skipped_unverified)).toHaveLength(2);
  });

  it('does nothing at all when the device is inside its limit', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [{ id: uuidOf(2), size: 100 }]);

    const run = await runEvictionAcross(current, { ...OPTS(500), others: [other] });

    expect(run.runs).toEqual([]);
    expect(disk.size).toBe(2);
  });
});

describe('what it does to another library (121)', () => {
  it('deletes files and leaves the database byte-for-byte alone', async () => {
    const current = workspace('local', [{ id: uuidOf(1), size: 100 }]);
    const other = workspace('a', [{ id: uuidOf(2), size: 100 }]);

    const raw = handles.get('a') as BetterSqlite3.Database;
    const rowsBefore = raw.prepare('SELECT * FROM songs').all();
    const metaBefore = raw.prepare('SELECT * FROM local_metadata').all();

    await runEvictionAcross(current, { ...OPTS(100), others: [other] });

    // The file is gone; the row that describes it is not. `has_file` is a disk
    // probe, so there is nothing to update — which is exactly what makes it
    // safe to point this at a library this process does not own.
    expect(disk.has(`a/${uuidOf(2)}`)).toBe(false);
    expect(raw.prepare('SELECT * FROM songs').all()).toEqual(rowsBefore);
    expect(raw.prepare('SELECT * FROM local_metadata').all()).toEqual(metaBefore);
  });

  it('never protects a song because one with the same id is busy here', async () => {
    const shared = uuidOf(1);
    const current = workspace('local', [{ id: shared, size: 100 }]);
    const other = workspace('a', [{ id: shared, size: 100 }]);

    // This process's exclusions are about THIS library. Inheriting them would
    // silently keep another workspace's file because a song with the same id
    // happens to be playing here.
    const run = await runEvictionAcross(current, {
      ...OPTS(100),
      others: [other],
      isExcluded: (id) => id === shared,
    });

    expect(disk.has(`a/${shared}`)).toBe(false);
    expect(disk.has(`local/${shared}`)).toBe(true);
    expect(run.freed_bytes).toBe(100);
  });
});
