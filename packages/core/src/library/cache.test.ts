// Eviction is the one feature that DELETES a user's data, so the tests are
// written around the two ways it could do that wrongly: reclaiming something
// it must never touch (an import, a pin, a file being read), and reclaiming
// something whose state changed while the probe was in flight.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseHandles, createDatabase } from '../db/index.js';
import { songs } from '../db/schema.js';
import { ClaimRegistry } from '../download/claims.js';
import { type ClaimHandle, type EvictionOptions, cacheStatus, runEviction } from './cache.js';
import { songAudioPath, songDirPath, songLyricsPath } from './lyrics.js';
import { createSong, setFileOrigin, setPinned, touchLastAccessed } from './songs.js';

const DEAD_KEY = 'BV1dead0000:1';
const ALIVE_KEY = 'BV1alive000:1';

let seq = 0;
let nest: string;
let handles: DatabaseHandles;
let claims: ClaimRegistry;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-cache-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  handles = createDatabase({ dbPath: ':memory:' });
  claims = new ClaimRegistry();
});

afterEach(() => {
  handles.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

const db = () => handles.db;

interface SeedOptions {
  bytes?: number;
  origin?: 'downloaded' | 'imported';
  key?: string | null;
  pinned?: boolean;
  lastAccessed?: number | null;
  file?: boolean;
}

/** A song with a file on disk, plus its lyrics — which eviction must keep. */
function seed(name: string, options: SeedOptions = {}): string {
  seq += 1;
  const { bytes = 1000, origin = 'downloaded', key = `BV1seed${seq}:1`, file = true } = options;
  const song = createSong(db(), handles.sqlite, {
    name,
    ...(key === null ? {} : { source_provider: 'bilibili', source_key: key }),
  });
  if (origin === 'imported') setFileOrigin(db(), handles.sqlite, song.id, 'imported');
  if (options.pinned === true) setPinned(db(), handles.sqlite, song.id, true);
  if (options.lastAccessed != null) {
    touchLastAccessed(db(), handles.sqlite, song.id, options.lastAccessed);
  }
  if (file) {
    mkdirSync(songDirPath(song.id), { recursive: true });
    writeFileSync(songAudioPath(song.id), Buffer.alloc(bytes));
    writeFileSync(songLyricsPath(song.id), '[00:01.00]lyric');
  }
  return song.id;
}

const hasAudio = (id: string): boolean => existsSync(songAudioPath(id));

/** Everything injected, with permissive defaults each test narrows. */
function options(overrides: Partial<EvictionOptions> = {}): EvictionOptions {
  return {
    limitBytes: 1500,
    isExcluded: () => false,
    streamCount: () => 0,
    acquireFileClaim: (songId): ClaimHandle | null => {
      try {
        const token = claims.acquire(songId, 'file', 'cache-test');
        return { release: () => claims.release(token) };
      } catch {
        return null;
      }
    },
    probe: () => Promise.resolve(true),
    ...overrides,
  };
}

describe('cacheStatus', () => {
  it('counts files on disk and separates what is reclaimable', () => {
    seed('downloaded', { bytes: 1000 });
    seed('imported', { bytes: 2000, origin: 'imported' });
    seed('rowOnly', { file: false });

    const status = cacheStatus(db(), {
      limitBytes: 0,
      isExcluded: () => false,
      streamCount: () => 0,
    });

    expect(status.used_bytes).toBe(3000);
    expect(status.file_count).toBe(2); // the file-less row is not a cached file
    expect(status.eligible_bytes).toBe(1000);
    expect(status.unreclaimable_bytes).toBe(2000);
    expect(status.limit_satisfied).toBe(true); // 0 = unlimited
  });

  it.each([
    ['an imported file (R1)', { origin: 'imported' as const }],
    ['a pinned song', { pinned: true }],
    ['a song with no source key', { key: null }],
  ])('never counts %s as eligible', (_label, seedOptions) => {
    seed('song', { bytes: 500, ...seedOptions });
    const status = cacheStatus(db(), {
      limitBytes: 100,
      isExcluded: () => false,
      streamCount: () => 0,
    });
    expect(status.eligible_bytes).toBe(0);
    expect(status.unreclaimable_bytes).toBe(500);
    expect(status.limit_satisfied).toBe(false);
  });

  it('drops the excluded and the currently-streamed from eligible', () => {
    const excluded = seed('excluded', { bytes: 100 });
    const streaming = seed('streaming', { bytes: 200 });
    seed('free', { bytes: 400 });

    const status = cacheStatus(db(), {
      limitBytes: 1,
      isExcluded: (id) => id === excluded,
      streamCount: (id) => (id === streaming ? 1 : 0),
    });
    expect(status.eligible_bytes).toBe(400);
  });
});

describe('runEviction', () => {
  it('deletes least-recently-used first and stops at the limit', async () => {
    const oldest = seed('oldest', { bytes: 1000, lastAccessed: 100 });
    const middle = seed('middle', { bytes: 1000, lastAccessed: 200 });
    const newest = seed('newest', { bytes: 1000, lastAccessed: 300 });

    const run = await runEviction(db(), options({ limitBytes: 1500 }));

    expect(run.evicted.map((e) => e.song_id)).toEqual([oldest, middle]);
    expect(run.evicted.every((e) => e.freed_bytes === 1000)).toBe(true);
    expect(hasAudio(newest)).toBe(true);
  });

  it('sorts a never-played song by its creation time', async () => {
    const untouched = seed('untouched', { bytes: 1000 });
    const played = seed('played', { bytes: 1000, lastAccessed: Date.now() + 10_000 });

    const run = await runEviction(db(), options({ limitBytes: 1000 }));

    expect(run.evicted.map((e) => e.song_id)).toEqual([untouched]);
    expect(hasAudio(played)).toBe(true);
  });

  it('keeps the row and the lyrics of an evicted song', async () => {
    const id = seed('gone', { bytes: 4000 });

    await runEviction(db(), options({ limitBytes: 1 }));

    expect(hasAudio(id)).toBe(false);
    expect(existsSync(songLyricsPath(id))).toBe(true);
    expect(db().select().from(songs).where(eq(songs.id, id)).get()).toBeDefined();
  });

  it('is a no-op when the limit is unlimited or already met', async () => {
    const id = seed('kept', { bytes: 4000 });

    expect((await runEviction(db(), options({ limitBytes: 0 }))).evicted).toEqual([]);
    expect((await runEviction(db(), options({ limitBytes: 8000 }))).evicted).toEqual([]);
    expect(hasAudio(id)).toBe(true);
  });

  it('never touches imported or pinned files, even when nothing else can free space', async () => {
    const imported = seed('imported', { bytes: 5000, origin: 'imported' });
    const pinned = seed('pinned', { bytes: 5000, pinned: true });

    const run = await runEviction(db(), options({ limitBytes: 1 }));

    expect(run.evicted).toEqual([]);
    expect(hasAudio(imported)).toBe(true);
    expect(hasAudio(pinned)).toBe(true);
  });

  it('keeps a file whose source cannot be confirmed (fail-closed, R26)', async () => {
    const dead = seed('dead', { bytes: 2000, key: DEAD_KEY, lastAccessed: 1 });
    const alive = seed('alive', { bytes: 2000, key: ALIVE_KEY, lastAccessed: 2 });

    const run = await runEviction(
      db(),
      options({ limitBytes: 2000, probe: (key) => Promise.resolve(key === ALIVE_KEY) }),
    );

    expect(run.skipped_unverified).toEqual([{ song_id: dead, bytes: 2000 }]);
    expect(hasAudio(dead)).toBe(true);
    expect(run.evicted.map((e) => e.song_id)).toEqual([alive]);
  });

  it('skips a song whose file claim is held by a writer', async () => {
    const busy = seed('busy', { bytes: 4000 });
    claims.acquire(busy, 'file', 'download-task');

    const run = await runEviction(db(), options({ limitBytes: 1 }));

    expect(run.evicted).toEqual([]);
    expect(hasAudio(busy)).toBe(true);
  });

  it('reports and survives a deletion that fails, without leaking the claim', async () => {
    // A directory where song.mp3 should be: it stats fine and unlink refuses.
    const id = seed('undeletable', { file: false });
    mkdirSync(songAudioPath(id), { recursive: true });
    writeFileSync(join(songAudioPath(id), 'filler'), Buffer.alloc(4000));

    const run = await runEviction(db(), options({ limitBytes: 1 }));

    expect(run.evicted).toEqual([]);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0]?.song_id).toBe(id);
    // try/finally, not a trailing release: the claim must be free afterwards.
    expect(() => claims.acquire(id, 'file', 'someone-else')).not.toThrow();
  });

  it('stops when the shutdown signal fires', async () => {
    seed('a', { bytes: 1000, lastAccessed: 1 });
    seed('b', { bytes: 1000, lastAccessed: 2 });
    const controller = new AbortController();

    const run = await runEviction(
      db(),
      options({
        limitBytes: 1,
        signal: controller.signal,
        probe: () => {
          controller.abort();
          return Promise.resolve(true);
        },
      }),
    );

    expect(run.evicted).toHaveLength(1); // the first candidate, then it stops
  });

  it('emits one event per deleted file', async () => {
    seed('a', { bytes: 1000, lastAccessed: 1 });
    seed('b', { bytes: 1000, lastAccessed: 2 });
    const seen: string[] = [];

    await runEviction(db(), options({ limitBytes: 1, onEvicted: (e) => seen.push(e.song_id) }));

    expect(seen).toHaveLength(2);
  });
});

// Everything below happens DURING the probe's await — the window the M5-5
// critical section exists to close. `probe` is the injection point because it
// is the only asynchronous step in the loop.
describe('runEviction re-checks after the probe', () => {
  const evictOne = async (mutate: (songId: string) => void): Promise<string> => {
    const id = seed('victim', { bytes: 4000 });
    await runEviction(
      db(),
      options({
        limitBytes: 1,
        probe: () => {
          mutate(id);
          return Promise.resolve(true);
        },
      }),
    );
    return id;
  };

  it('skips a song pinned while the probe ran', async () => {
    const id = await evictOne((songId) => setPinned(db(), handles.sqlite, songId, true));
    expect(hasAudio(id)).toBe(true);
  });

  it('skips a song re-keyed while the probe ran — the probe proved nothing', async () => {
    const id = await evictOne((songId) => {
      db().update(songs).set({ source_key: 'BV1other9x:9' }).where(eq(songs.id, songId)).run();
    });
    expect(hasAudio(id)).toBe(true);
  });

  it('skips a song that started playing (excluded) while the probe ran', async () => {
    const id = seed('victim', { bytes: 4000 });
    let playing = false;
    await runEviction(
      db(),
      options({
        limitBytes: 1,
        isExcluded: (songId) => playing && songId === id,
        probe: () => {
          playing = true;
          return Promise.resolve(true);
        },
      }),
    );
    expect(hasAudio(id)).toBe(true);
  });

  it('skips a song whose audio started streaming while the probe ran', async () => {
    const id = seed('victim', { bytes: 4000 });
    let streams = 0;
    await runEviction(
      db(),
      options({
        limitBytes: 1,
        streamCount: () => streams,
        probe: () => {
          streams = 1;
          return Promise.resolve(true);
        },
      }),
    );
    expect(hasAudio(id)).toBe(true);
  });

  it('frees the size the file has at deletion time, not the one it was picked with', async () => {
    const id = seed('replaced', { bytes: 4000 });
    const run = await runEviction(
      db(),
      options({
        limitBytes: 1,
        probe: () => {
          writeFileSync(songAudioPath(id), Buffer.alloc(9000)); // re-downloaded
          return Promise.resolve(true);
        },
      }),
    );
    expect(run.evicted).toEqual([{ song_id: id, freed_bytes: 9000 }]);
  });

  it('skips a song deleted while the probe ran', async () => {
    const id = seed('deleted', { bytes: 4000 });
    const run = await runEviction(
      db(),
      options({
        limitBytes: 1,
        probe: () => {
          db().delete(songs).where(eq(songs.id, id)).run();
          return Promise.resolve(true);
        },
      }),
    );
    expect(run.evicted).toEqual([]);
    expect(statSync(songAudioPath(id)).size).toBe(4000);
  });
});
