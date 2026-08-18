// The daemon half of the cache model (M5-4 / M5-6): what "excluded" means
// here, how a probe is performed, and when an eviction actually runs.
//
// core's `runEviction` is pure logic over injected facts. This is where those
// facts come from — the player mirror, the ensure leases, the download queue,
// the open audio streams, and bilibili.

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIMEOUTS,
  MIB,
  type PipelineDeps,
  cacheStatus,
  probeSourceKey,
  runEviction,
  withTimeout,
} from '@lark/core';
import type { CacheEvictResultData, CacheStatusData } from '@lark/shared';
import type { AppContext, BaseContext } from './context.js';

/**
 * How long a freshly ensured file is protected from eviction (M5-6).
 *
 * The window it covers: `POST /songs/:id/ensure-file` finished, the GUI has
 * not received the completion event yet, and no `GET /audio` has arrived — so
 * the song is in nobody's exclusion set and the very next eviction would
 * delete the file that was just fetched to play. The lease is dropped as soon
 * as a stream opens; the TTL only exists so a GUI that never comes back cannot
 * pin a file forever.
 */
export const ENSURE_LEASE_TTL_MS = 60_000;

export interface SongLeaseOptions {
  ttlMs?: number;
  /** Clock seam — tests advance it instead of waiting a minute. */
  now?: () => number;
}

/** Short-lived per-song eviction immunity. */
export class SongLeaseRegistry {
  readonly #until = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SongLeaseOptions = {}) {
    this.#ttlMs = options.ttlMs ?? ENSURE_LEASE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Start (or restart) the lease for a song. */
  grant(songId: string): void {
    this.#until.set(songId, this.#now() + this.#ttlMs);
  }

  /** Drop it — the audio stream that the lease was protecting has opened. */
  clear(songId: string): void {
    this.#until.delete(songId);
  }

  has(songId: string): boolean {
    const until = this.#until.get(songId);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#until.delete(songId); // expired: collect it on the way past
    return false;
  }
}

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
    ...cacheStatus(ctx.db, cacheOptions(ctx)),
    limit_mb: ctx.config.storage.cache_limit_mb,
  };
}

/**
 * Is this stored key still downloadable? Anything but a clean yes is a no.
 *
 * Exported because the audio migration asks the same question before it
 * discards an mp3 it could not read (§4-h / R26): there is ONE answer to "can
 * we get this back", and a second implementation would eventually disagree with
 * this one about a file that is about to be deleted. Takes a `BaseContext` for
 * the same reason — the migration runs before the normal runtime exists.
 */
export async function canRedownload(
  ctx: BaseContext,
  sourceKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deps: PipelineDeps = {
    store: ctx.portable,
    bilibili: ctx.bilibili,
    llm: null, // a probe never re-identifies; it only confirms the stored key
    // Carried for the type, never exercised: `probeSourceKey` asks bilibili
    // whether a key still resolves and touches no media.
    mediaTools: ctx.mediaTools,
    timeouts: DEFAULT_TIMEOUTS,
  };
  const resolved = await probeSourceKey(deps, sourceKey, {
    signal: withTimeout(DEFAULT_TIMEOUTS.bilibiliMeta, ctx.shutdownSignal, signal),
    reportStage: () => {},
  });
  return resolved !== null;
}

export interface EvictionSummary {
  evicted_count: number;
  freed_bytes: number;
  skipped_unverified_count: number;
  skipped_unverified_bytes: number;
}

const EMPTY_SUMMARY: EvictionSummary = {
  evicted_count: 0,
  freed_bytes: 0,
  skipped_unverified_count: 0,
  skipped_unverified_bytes: 0,
};

/**
 * The one place an eviction is started from — boot, a finished download and
 * `POST /cache/evict` all go through the same instance on the context.
 *
 * Two behaviours are load-bearing:
 *
 *   DEFERRED. `onSucceeded` fires from inside the engine's `#finish`, while
 *   the task still holds the song's `file` claim (it is released in
 *   `#execute`'s finally, a microtask later). Evicting right there would find
 *   the just-downloaded song busy, skip it, and never come back. So a drain
 *   always starts on a macrotask — after every microtask continuation.
 *
 *   DIRTY DRAIN-LOOP, not "join the in-flight promise". A trigger that arrives
 *   after the running drain took its candidate snapshot has NOT been handled
 *   by it. Marking the run dirty and going round again with the current config
 *   is what makes "download finished" reliably mean "the cache was checked
 *   afterwards". The loop is driven by triggers only — never by
 *   `limit_satisfied` staying false, which would spin forever whenever the
 *   overflow is unreclaimable.
 */
export class EvictionScheduler {
  readonly #ctx: AppContext;
  #running: Promise<EvictionSummary> | null = null;
  #dirty = false;
  #closing = false;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /**
   * Ask for a drain. NEVER throws and never blocks: `onSucceeded` is a void
   * callback called past a download's commit point, so a throw here would
   * un-succeed a task that has already committed (M3's point-of-no-return
   * invariant). Failures surface as a rejected promise, which the caller may
   * await (the manual route) or observe (`.catch` + a log line).
   */
  schedule(): Promise<EvictionSummary> {
    if (this.#closing) return Promise.resolve(EMPTY_SUMMARY);
    if (this.#running !== null) {
      this.#dirty = true;
      return this.#running;
    }
    this.#running = this.#drain();
    return this.#running;
  }

  /**
   * Stop scheduling and wait for the in-flight drain. Teardown must await this
   * BEFORE closing the events bus and the database: a drain parked on a probe
   * wakes up in its `finally` and would otherwise touch both after they went
   * away. The drain itself is cut short by the shutdown signal, so the wait is
   * short.
   */
  async close(): Promise<void> {
    this.#closing = true;
    try {
      await this.#running;
    } catch {
      // A failed drain is the scheduler's business, not teardown's; the
      // triggering call site already logged it.
    }
  }

  async #drain(): Promise<EvictionSummary> {
    // Past every microtask continuation — see DEFERRED above.
    await new Promise((resolve) => setImmediate(resolve));

    const evicted = new Map<string, number>();
    const skipped = new Map<string, number>();

    try {
      return await this.#rounds(evicted, skipped);
    } finally {
      // Clearing the slot and re-arming happen in the SAME synchronous step:
      // a trigger that lands between "the loop decided it was done" and "the
      // slot is free" would otherwise be recorded as dirty and never run.
      this.#running = null;
      if (this.#dirty && !this.#closing) {
        this.#dirty = false;
        scheduleEvictionInBackground(this.#ctx, 'late-trigger');
      }
    }
  }

  async #rounds(
    evicted: Map<string, number>,
    skipped: Map<string, number>,
  ): Promise<EvictionSummary> {
    for (;;) {
      this.#dirty = false;
      const run = await runEviction(this.#ctx.db, {
        ...cacheOptions(this.#ctx),
        acquireFileClaim: (songId) => {
          try {
            const token = this.#ctx.downloads.claims.acquire(
              songId,
              'file',
              `cache:${randomUUID()}`,
            );
            return { release: () => this.#ctx.downloads.claims.release(token) };
          } catch {
            return null; // SongBusyError: someone else is writing this song
          }
        },
        probe: (sourceKey) => canRedownload(this.#ctx, sourceKey),
        onEvicted: ({ song_id }) => this.#ctx.eventsBus.emit({ type: 'cache:evicted', song_id }),
        signal: this.#ctx.shutdownSignal,
      });

      for (const item of run.evicted) {
        evicted.set(item.song_id, item.freed_bytes);
        // It was skipped in an earlier round and has now gone: it is not a
        // "could not verify" outcome any more (M5-6).
        skipped.delete(item.song_id);
      }
      for (const item of run.skipped_unverified) {
        if (!evicted.has(item.song_id)) skipped.set(item.song_id, item.bytes);
      }
      for (const item of run.failed) {
        this.#ctx.logger.warn(
          { song_id: item.song_id, err: item.message },
          'could not delete a cached file',
        );
      }

      if (!this.#dirty || this.#closing) break;
    }

    const sum = (map: Map<string, number>): number => {
      let total = 0;
      for (const bytes of map.values()) total += bytes;
      return total;
    };
    return {
      evicted_count: evicted.size,
      freed_bytes: sum(evicted),
      skipped_unverified_count: skipped.size,
      skipped_unverified_bytes: sum(skipped),
    };
  }
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
