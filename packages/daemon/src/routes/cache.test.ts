// The cache routes and the scheduler behind them (M5-4 / M5-6).
//
// The probe is real: the bilibili client points at the fake upstream, so
// "still downloadable" means the same thing it means in production — a
// pagelist entry for the stored `bvid:cid`. A key the upstream does not know
// is exactly what a dead source looks like.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  createSong,
  setFileOrigin,
  setPinned,
  songAudioPath,
  songDirPath,
  songLyricsPath,
  touchLastAccessed,
} from '@lark/core';
import { type FakeUpstream, startFakeUpstream, toneWav } from '@lark/core/testing';
import {
  API_PATHS,
  type ApiResponse,
  type CacheEvictResultData,
  type CacheStatusData,
  type LarkConfig,
  type LarkEvent,
  type SongData,
} from '@lark/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleEvictionInBackground } from '../cache.js';
import {
  type TestApp,
  type TestContext,
  buildTestServer,
  closeTestContext,
  createTestContext,
} from '../testing/build-test-server.js';

// The fake upstream serves one video; the test gives it several parts so each
// seeded song can hold its own live `bvid:cid` (the pair is unique per song).
const BVID = 'BV1Ki4y1y7HC';
const DEAD_KEY = 'BV1Ki4y1y7HD:550103819';
const OTHER_DEAD_KEY = 'BV1Ki4y1y7HE:550103819';
const MIB = 1024 * 1024;
const PART_COUNT = 8;

let liveKeys: string[];
let nextKey = 0;

let audioFixture: Buffer;
let ctx: TestContext;
let app: TestApp;
let nest: string;
let upstream: FakeUpstream;
let events: LarkEvent[];

function config(cacheLimitMb: number): LarkConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  base.storage.cache_limit_mb = cacheLimitMb;
  return base;
}

/** A live key nobody else has taken yet. */
function takeLiveKey(): string {
  const key = liveKeys[nextKey];
  nextKey += 1;
  if (key === undefined) throw new Error('the fake upstream ran out of parts');
  return key;
}

function boot(cacheLimitMb: number, options: { leaseTtlMs?: number } = {}): void {
  ctx = createTestContext({
    config: config(cacheLimitMb),
    bilibiliBase: upstream.baseUrl,
    ...(options.leaseTtlMs === undefined ? {} : { cacheLeases: { ttlMs: options.leaseTtlMs } }),
  });
  app = buildTestServer(ctx);
  events = [];
  ctx.eventsBus.subscribe((e) => events.push(e));
}

interface SeedOptions {
  mib?: number;
  key?: string | null;
  origin?: 'downloaded' | 'imported';
  pinned?: boolean;
  lastAccessed?: number;
  file?: boolean;
}

function seed(name: string, options: SeedOptions = {}): SongData {
  const { mib = 1, key = takeLiveKey(), origin = 'downloaded', file = true } = options;
  const song = createSong(ctx.db, ctx.sqlite, {
    name,
    ...(key === null ? {} : { source_provider: 'bilibili', source_key: key }),
  });
  if (origin === 'imported') setFileOrigin(ctx.db, ctx.sqlite, song.id, 'imported');
  if (options.pinned === true) setPinned(ctx.db, ctx.sqlite, song.id, true);
  if (options.lastAccessed !== undefined) {
    touchLastAccessed(ctx.db, ctx.sqlite, song.id, options.lastAccessed);
  }
  if (file) writeAudio(song.id, mib);
  return song;
}

function writeAudio(songId: string, mib: number): void {
  mkdirSync(songDirPath(songId), { recursive: true });
  writeFileSync(songAudioPath(songId), Buffer.alloc(mib * MIB));
  writeFileSync(songLyricsPath(songId), '[00:01.00]lyric');
}

const hasAudio = (song: SongData | string): boolean =>
  existsSync(songAudioPath(typeof song === 'string' ? song : song.id));

const status = async (): Promise<CacheStatusData> => {
  const res = await app.inject({ method: 'GET', url: API_PATHS.cacheStatus });
  expect(res.statusCode).toBe(200);
  return res.json<ApiResponse<CacheStatusData>>().data as CacheStatusData;
};

const evict = async (): Promise<CacheEvictResultData> => {
  const res = await app.inject({ method: 'POST', url: API_PATHS.cacheEvict });
  expect(res.statusCode).toBe(200);
  return res.json<ApiResponse<CacheEvictResultData>>().data as CacheEvictResultData;
};

beforeAll(() => {
  // Real audio for the one test that runs an actual download end to end.
  // Written by hand, not synthesised: the vendored ffmpeg has no lavfi
  // demuxer and no AAC encoder (M7 T0).
  audioFixture = toneWav(1);
});

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-cache-route-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  upstream = await startFakeUpstream();
  const video = upstream.state.videos.get(BVID);
  if (video === undefined) throw new Error('fixture video missing');
  video.pages = Array.from({ length: PART_COUNT }, (_, i) => ({
    page: i + 1,
    part: `P${i + 1}`,
    duration: 223,
    cid: 550103819 + i,
  }));
  liveKeys = video.pages.map((page) => `${BVID}:${page.cid}`);
  upstream.state.audio = audioFixture;
  nextKey = 0;
  boot(0);
});

afterEach(async () => {
  await app.close();
  await closeTestContext(ctx);
  await upstream.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

describe('GET /cache/status', () => {
  it('reports usage, what is reclaimable, and the limit', async () => {
    boot(2);
    seed('downloaded', { mib: 1 });
    seed('imported', { mib: 2, origin: 'imported' });

    expect(await status()).toEqual({
      used_bytes: 3 * MIB,
      file_count: 2,
      limit_mb: 2,
      eligible_bytes: 1 * MIB,
      unreclaimable_bytes: 2 * MIB,
      limit_satisfied: false,
    });
  });

  it('is always satisfied at limit 0 (unlimited)', async () => {
    seed('big', { mib: 3 });
    const data = await status();
    expect(data.limit_mb).toBe(0);
    expect(data.limit_satisfied).toBe(true);
  });
});

describe('POST /cache/evict', () => {
  it('frees least-recently-used files, emits an event, and answers the new status', async () => {
    boot(2);
    const old = seed('old', { lastAccessed: 1 });
    const recent = seed('recent', { lastAccessed: 2 });
    const newest = seed('newest', { lastAccessed: 3 });

    const result = await evict();

    expect(result.evicted_count).toBe(1);
    expect(result.freed_bytes).toBe(MIB);
    expect(result.used_bytes).toBe(2 * MIB); // recomputed after the drain
    expect(result.limit_satisfied).toBe(true);
    expect(hasAudio(old)).toBe(false);
    expect(hasAudio(recent)).toBe(true);
    expect(hasAudio(newest)).toBe(true);
    expect(events).toContainEqual({ type: 'cache:evicted', song_id: old.id });
    // The song is still a song: only its audio was reclaimable.
    expect(existsSync(songLyricsPath(old.id))).toBe(true);
    const row = await app.inject({ method: 'GET', url: `/songs/${old.id}` });
    expect(row.statusCode).toBe(200);
  });

  it('keeps a file whose source no longer resolves and reports it as unverified', async () => {
    boot(1);
    const dead = seed('dead', { key: DEAD_KEY, lastAccessed: 1 });
    const alive = seed('alive', { lastAccessed: 2 });

    const result = await evict();

    expect(result.skipped_unverified_count).toBe(1);
    expect(result.skipped_unverified_bytes).toBe(MIB);
    expect(hasAudio(dead)).toBe(true);
    expect(hasAudio(alive)).toBe(false);
  });

  it('does nothing at limit 0', async () => {
    const song = seed('kept', { mib: 3 });
    const result = await evict();
    expect(result.evicted_count).toBe(0);
    expect(hasAudio(song)).toBe(true);
  });
});

describe('what eviction is not allowed to touch', () => {
  it('spares the song the GUI reported playing', async () => {
    boot(1);
    const playing = seed('playing', { lastAccessed: 1 });
    const other = seed('other', { lastAccessed: 2 });
    ctx.player.lastReport = {
      current_song: { id: playing.id, name: playing.name, artist: '' },
      is_playing: true,
      current_time: 0,
      duration: 1,
      play_mode: 'sequential',
      playlist_id: 'all',
    };

    await evict();

    expect(hasAudio(playing)).toBe(true);
    expect(hasAudio(other)).toBe(false);
  });

  it('spares a song whose audio is being streamed right now', async () => {
    boot(1);
    const streaming = seed('streaming', { mib: 2, lastAccessed: 1 });
    const other = seed('other', { lastAccessed: 2 });
    const release = ctx.audioStreams.register(streaming.id);

    await evict();
    expect(hasAudio(streaming)).toBe(true);
    expect(hasAudio(other)).toBe(false);

    // …and it becomes reclaimable again once the stream is gone.
    release();
    await evict();
    expect(hasAudio(streaming)).toBe(false);
  });

  it('spares a freshly ensured file for the length of its lease', async () => {
    boot(1, { leaseTtlMs: 60_000 });
    const ensured = seed('ensured', { mib: 2, lastAccessed: 1 });
    const other = seed('other', { lastAccessed: 2 });
    ctx.cacheLeases.grant(ensured.id);

    // The manual route honours the lease too — "play it when it finishes"
    // beats "reclaim it immediately" (M5-6).
    await evict();
    expect(hasAudio(ensured)).toBe(true);
    expect(hasAudio(other)).toBe(false);

    ctx.cacheLeases.clear(ensured.id);
    await evict();
    expect(hasAudio(ensured)).toBe(false);
  });

  it('lets an unclaimed lease expire instead of protecting the file forever', async () => {
    boot(1, { leaseTtlMs: 1 });
    const ensured = seed('ensured', { mib: 3 });
    ctx.cacheLeases.grant(ensured.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await evict();
    expect(hasAudio(ensured)).toBe(false);
  });

  it('spares a song a queued download is about to write', async () => {
    boot(1);
    const pending = seed('pending', { lastAccessed: 1 });
    const other = seed('other', { lastAccessed: 2 });
    ctx.downloads.enqueueRedownload(pending.id);

    await evict();

    expect(hasAudio(pending)).toBe(true);
    expect(hasAudio(other)).toBe(false);
  });
});

describe('the eviction scheduler', () => {
  it('runs after the trigger settles, so a just-finished download is evictable', async () => {
    // What the engine looks like at `onSucceeded`: the task still holds the
    // song's file claim and releases it in a microtask. A drain that ran
    // immediately would find the song busy and never come back (M5-6).
    boot(1);
    const fresh = seed('fresh', { mib: 3 });
    const token = ctx.downloads.claims.acquire(fresh.id, 'file', 'download-task');
    const drain = ctx.cacheScheduler.schedule();
    void Promise.resolve().then(() => ctx.downloads.claims.release(token));

    const summary = await drain;

    expect(summary.evicted_count).toBe(1);
    expect(hasAudio(fresh)).toBe(false);
  });

  it('goes round again for a trigger that arrived mid-drain', async () => {
    boot(1);
    upstream.state.delayMs = 60; // hold round one inside its probe
    const first = seed('first', { mib: 2, lastAccessed: 1 });
    const late = seed('late', { mib: 2, lastAccessed: 2, file: false });

    const drain = ctx.cacheScheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Appears AFTER round one scanned, so only a second round can see it.
    writeAudio(late.id, 2);
    ctx.cacheScheduler.schedule();

    const summary = await drain;

    expect(summary.evicted_count).toBe(2);
    expect(hasAudio(first)).toBe(false);
    expect(hasAudio(late.id)).toBe(false);
  });

  it('counts an unverified song once across rounds, and drops it once it goes', async () => {
    boot(1);
    upstream.state.delayMs = 40;
    const stubborn = seed('stubborn', { mib: 2, key: DEAD_KEY, lastAccessed: 1 });
    const fixable = seed('fixable', { mib: 2, key: OTHER_DEAD_KEY, lastAccessed: 2 });

    const drain = ctx.cacheScheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 15));
    // The second song's link is repaired mid-drain, so round two can free it.
    ctx.sqlite.prepare('UPDATE songs SET source_key = ? WHERE id = ?').run(liveKeys[0], fixable.id);
    ctx.cacheScheduler.schedule();

    const summary = await drain;

    expect(summary.evicted_count).toBe(1);
    // `stubborn` failed its probe in both rounds and is reported once;
    // `fixable` failed in round one but was evicted in round two, so it is not
    // reported at all (M5-6).
    expect(summary.skipped_unverified_count).toBe(1);
    expect(summary.skipped_unverified_bytes).toBe(2 * MIB);
    expect(hasAudio(stubborn)).toBe(true);
    expect(hasAudio(fixable)).toBe(false);
  });

  it('shares one drain between concurrent callers', async () => {
    boot(1);
    seed('a', { mib: 3 });
    const [first, second] = await Promise.all([
      ctx.cacheScheduler.schedule(),
      ctx.cacheScheduler.schedule(),
    ]);
    expect(first).toEqual(second);
    expect(first.evicted_count).toBe(1);
  });

  it('becomes a no-op once it is closing', async () => {
    boot(1);
    const song = seed('kept', { mib: 3 });
    await ctx.cacheScheduler.close();

    expect(await ctx.cacheScheduler.schedule()).toEqual({
      evicted_count: 0,
      freed_bytes: 0,
      skipped_unverified_count: 0,
      skipped_unverified_bytes: 0,
    });
    expect(hasAudio(song)).toBe(true);
  });

  // The cross-feature regression (M5-6): the drain that the ensure itself
  // triggered is long finished, the GUI has not opened /audio yet, and ANOTHER
  // trigger comes along. Without the lease, the file that was fetched to be
  // played is the first thing the next drain deletes.
  it('protects an ensured file across later drains, until a stream opens', async () => {
    boot(1, { leaseTtlMs: 60_000 });
    const ensured = seed('ensured', { mib: 2 });

    // A song that already has its file: ensure-file succeeds with no network
    // at all, which is exactly the path that grants the lease.
    const task = ctx.downloads.enqueueEnsureFile(ensured.id);
    await vi.waitFor(() => expect(ctx.downloads.get(task.id).state).toBe('succeeded'));
    await ctx.cacheScheduler.schedule(); // the drain that success triggered

    expect(hasAudio(ensured)).toBe(true);
    expect(ctx.cacheLeases.has(ensured.id)).toBe(true);

    // A second, unrelated drain — a different download finishing, or the user
    // pressing "clean up now". Still protected.
    await evict();
    expect(hasAudio(ensured)).toBe(true);

    // The stream the lease was standing in for opens: protection hands over.
    ctx.cacheLeases.clear(ensured.id);
    await evict();
    expect(hasAudio(ensured)).toBe(false);
  });

  // The regression the deferral exists for, through the real path: the engine
  // callback that boot and the test harness both translate (M5-6).
  it('evicts the song a download just finished, in the same drain', async () => {
    boot(0.001); // ~1 KiB: anything at all is over the limit
    const task = ctx.downloads.enqueueDownload({
      target: { kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' },
    });

    await vi.waitFor(() => expect(ctx.downloads.get(task.id).state).toBe('succeeded'), {
      timeout: 30_000,
    });
    const songId = ctx.downloads.get(task.id).result?.song_id as string;
    expect(songId).toBeDefined();

    // Nothing else runs: the automatic trigger fired from `onSucceeded`, and
    // it had to wait for the task's own file claim to go away first.
    await vi.waitFor(() => expect(hasAudio(songId)).toBe(false), { timeout: 30_000 });
    expect(events).toContainEqual({ type: 'cache:evicted', song_id: songId });
  }, 60_000);

  it('never lets a failure reach the caller — a finished download must stay finished', async () => {
    boot(1);
    seed('a', { mib: 3 });
    ctx.downloads.pendingFileSongIds = () => {
      throw new Error('boom');
    };

    // This is what `onSucceeded` calls, past the point of no return.
    expect(() => scheduleEvictionInBackground(ctx, 'download-succeeded')).not.toThrow();
    await vi.waitFor(() => expect(ctx.logger.errors()).toHaveLength(1));
    expect(ctx.logger.errors()[0]?.msg).toBe('cache eviction failed');
  });
});
