// The daemon half of the cache model (M5-4 / M5-6): what "excluded" means
// here, how a probe is performed, and how the portable eviction scheduler is
// wired to this process's suppliers.
//
// core's `runEviction` is pure logic over injected facts, and since N4a the
// scheduler, the ensure-lease registry and the re-download probe are portable
// too (decision g) — so the phone runs the SAME loop. This file is the desktop
// wiring: it builds `EvictionRuntimeDeps` from the AppContext (the player
// mirror, the ensure leases, the download queue, the open audio streams, and
// bilibili), and re-exports the runtime so the daemon's other modules keep a
// single import site.

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIMEOUTS,
  EvictionScheduler,
  type EvictionSummary,
  MIB,
  type PipelineDeps,
  cacheStatus,
  canRedownload as coreCanRedownload,
  withTimeout,
} from '@lark/core';
import type { CacheEvictResultData, CacheStatusData } from '@lark/shared';
import type { AppContext, BaseContext } from './context.js';

// The portable cache runtime, re-exported so decision g's move does not fan out
// into every daemon module that constructs or types these.
export { ENSURE_LEASE_TTL_MS, EvictionScheduler, SongLeaseRegistry } from '@lark/core';
export type { EvictionSummary, SongLeaseOptions } from '@lark/core';

const limitBytes = (ctx: AppContext): number => ctx.config.storage.cache_limit_mb * MIB;

/**
 * The live exclusion set, evaluated per call (never snapshotted):
 * the song the GUI last reported playing, one holding an ensure lease, and any
 * song a non-terminal task is about to write a file for.
 *
 * The player report is trusted however old it is — the conservative direction
 * is "do not delete what might be playing", and a stale report can only cost
 * one song's worth of space.
 */
function isExcluded(ctx: AppContext, songId: string): boolean {
  if (ctx.player.lastReport?.current_song?.id === songId) return true;
  if (ctx.cacheLeases.has(songId)) return true;
  return ctx.downloads.pendingFileSongIds().has(songId);
}

function cacheOptions(ctx: AppContext): {
  limitBytes: number;
  isExcluded: (songId: string) => boolean;
  streamCount: (songId: string) => number;
} {
  return {
    limitBytes: limitBytes(ctx),
    isExcluded: (songId) => isExcluded(ctx, songId),
    streamCount: (songId) => ctx.audioStreams.count(songId),
  };
}

export function readCacheStatus(ctx: AppContext): CacheStatusData {
  return {
    ...cacheStatus(ctx.files, ctx.db, cacheOptions(ctx)),
    limit_mb: ctx.config.storage.cache_limit_mb,
  };
}

/**
 * Is this stored key still downloadable? The daemon's BaseContext form of the
 * portable `canRedownload` (R26): eviction and the audio migration both ask it
 * before deleting a file, and a probe never re-identifies — it confirms the
 * stored key — so the deps carry `llm: null`. Takes a `BaseContext` because the
 * migration runs before the normal runtime exists.
 */
export async function canRedownload(
  ctx: BaseContext,
  sourceKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deps: PipelineDeps = {
    store: ctx.portable,
    files: ctx.files,
    bilibili: ctx.bilibili,
    llm: null,
    timeouts: DEFAULT_TIMEOUTS,
  };
  return coreCanRedownload(deps, sourceKey, {
    signal: withTimeout(DEFAULT_TIMEOUTS.bilibiliMeta, ctx.shutdownSignal, signal),
    reportStage: () => {},
  });
}

/**
 * Build the single eviction scheduler for this daemon, wiring the portable
 * loop to this process's suppliers. Boot, a finished download and
 * `POST /cache/evict` all schedule through the one instance this returns — two
 * would defeat the single-flight and run concurrent drains over the same files.
 *
 * `defer` is `setImmediate`, which is the whole point of the deferral (M5-6): a
 * drain triggered from a download's `onSucceeded` must start after the task's
 * file claim is released a microtask later, or it finds the song busy and never
 * comes back.
 */
export function createEvictionScheduler(ctx: AppContext): EvictionScheduler {
  return new EvictionScheduler({
    files: ctx.files,
    db: ctx.db,
    cacheOptions: () => cacheOptions(ctx),
    acquireFileClaim: (songId) => {
      try {
        const token = ctx.downloads.claims.acquire(songId, 'file', `cache:${randomUUID()}`);
        return { release: () => ctx.downloads.claims.release(token) };
      } catch {
        return null; // SongBusyError: someone else is writing this song
      }
    },
    probe: (sourceKey) => canRedownload(ctx, sourceKey),
    onEvicted: ({ song_id }) => ctx.eventsBus.emit({ type: 'cache:evicted', song_id }),
    onDeleteFailed: (song_id, message) =>
      ctx.logger.warn({ song_id, err: message }, 'could not delete a cached file'),
    signal: ctx.shutdownSignal,
    defer: (fn) => {
      setImmediate(fn);
    },
    onBackgroundError: (err) =>
      ctx.logger.error({ err, reason: 'late-trigger' }, 'cache eviction failed'),
  });
}

/** Fire-and-observe: for the triggers that are not an HTTP request (M5-6). */
export function scheduleEvictionInBackground(ctx: AppContext, reason: string): void {
  void ctx.cacheScheduler.schedule().catch((err: unknown) => {
    ctx.logger.error({ err, reason }, 'cache eviction failed');
  });
}

export function evictResult(ctx: AppContext, summary: EvictionSummary): CacheEvictResultData {
  return { ...readCacheStatus(ctx), ...summary };
}
