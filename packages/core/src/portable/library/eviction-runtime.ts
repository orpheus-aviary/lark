// The eviction scheduler, the ensure-lease registry, and the "can we get this
// back" probe — the injectable half of the cache model (N4a, decision g).
//
// `library/cache.ts` is the pure accounting: `cacheStatus` and `runEviction`
// over facts the caller owns. This is the RUNTIME around it — WHEN a drain
// runs, how a late trigger is folded in, how long a freshly ensured file is
// protected — which used to live in `daemon/src/cache.ts` and could not be
// reached from a phone (the mobile guard forbids importing the daemon). Two
// scheduling semantics written twice would drift; the shape of that drift is
// "the same download evicted on one host and not the other", so the loop lives
// here and each host injects its own suppliers.
//
// The one thing a host MUST get right is `defer`: the drain starts a macrotask
// late so a just-finished download has released its file claim before the scan
// (M5-6). The desktop passes `setImmediate`; the phone passes
// `setTimeout(…, 0)`. A microtask here would scan before the release and skip
// the song forever.

import type { PortableDrizzle } from '../db.js';
import { type PipelineDeps, type StepContext, probeSourceKey } from '../download/pipeline.js';
import type { FileContext } from '../ports/fs.js';
import { type WorkspaceLibrary, runEvictionAcross } from './cache-across.js';
import {
  type CacheOptions,
  type ClaimHandle,
  type EvictedSong,
  type EvictionRun,
  runEviction,
} from './cache.js';

// ─── The ensure lease ──────────────────────────────────

/**
 * How long a freshly ensured file is protected from eviction (M5-6).
 *
 * The window it covers: an ensure-file finished, the front end has not received
 * the completion event yet, and no stream has opened — so the song is in
 * nobody's exclusion set and the very next eviction would delete the file that
 * was just fetched to play. The lease is dropped as soon as a stream opens; the
 * TTL only exists so a front end that never comes back cannot pin a file
 * forever.
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

// ─── The re-download probe ─────────────────────────────

/**
 * Is this stored key still downloadable? Anything but a clean yes is a no.
 *
 * The ONE answer to "can we get this back": eviction asks it before deleting a
 * file, and the audio migration asks it before discarding an mp3 it could not
 * read (R26). A second implementation would eventually disagree with this one
 * about a file that is about to be deleted. A probe never re-identifies — it
 * confirms the STORED key — so the deps carry `llm: null`.
 */
export async function canRedownload(
  deps: PipelineDeps,
  sourceKey: string,
  ctx: StepContext,
): Promise<boolean> {
  return (await probeSourceKey(deps, sourceKey, ctx)) !== null;
}

// ─── The eviction scheduler ────────────────────────────

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
 * Everything a drain needs, injected so the same loop runs on every host.
 *
 * `cacheOptions` is a THUNK, evaluated once per round: the limit and the
 * exclusion set can change between rounds (a config PATCH, a song starting to
 * play), and a snapshot would act on a stale world.
 */
export interface EvictionRuntimeDeps {
  files: FileContext;
  db: PortableDrizzle;
  cacheOptions: () => CacheOptions;
  acquireFileClaim: (songId: string) => ClaimHandle | null;
  probe: (sourceKey: string) => Promise<boolean>;
  onEvicted: (evicted: EvictedSong) => void;
  /**
   * The other workspaces on this device, opened for the length of one drain
   * (N7f, §2.6).
   *
   * The cache limit is a DEVICE setting, so once there are several libraries a
   * drain has to account for all of them — and free the ones nobody is looking
   * at first. Opening them is the host's job (it is the half that knows how);
   * this closes whatever it is given, however the drain ends.
   *
   * Absent means "this device has one library", which is what it meant before
   * N7 and what it still means on a phone that has never logged in.
   */
  openOtherWorkspaces?: () => { workspaces: readonly WorkspaceLibrary[]; close: () => void };
  /** A file that was eligible but could not be unlinked (permissions, a race). */
  onDeleteFailed: (songId: string, message: string) => void;
  /** Cut the run short when the host starts shutting down. */
  signal: AbortSignal;
  /**
   * Start a macrotask late (§1.11). `setImmediate` on the desktop,
   * `setTimeout(fn, 0)` on the phone. NOT a microtask.
   */
  defer: (fn: () => void) => void;
  /** A late-trigger re-arm that rejected — the host logs it. */
  onBackgroundError: (err: unknown) => void;
}

/**
 * The one place an eviction is started from — boot, a finished download and a
 * manual "clean up now" all go through the same instance.
 *
 * Two behaviours are load-bearing:
 *
 *   DEFERRED. A trigger fires from inside a download's `onSucceeded`, while the
 *   task still holds the song's `file` claim (released a microtask later).
 *   Evicting right there would find the just-downloaded song busy, skip it, and
 *   never come back. So a drain always starts on a macrotask via `defer`.
 *
 *   DIRTY DRAIN-LOOP, not "join the in-flight promise". A trigger that arrives
 *   after the running drain took its candidate snapshot has NOT been handled by
 *   it. Marking the run dirty and going round again with the current config is
 *   what makes "download finished" reliably mean "the cache was checked after".
 *   The loop is driven by triggers only — never by `limit_satisfied` staying
 *   false, which would spin forever whenever the overflow is unreclaimable.
 */
export class EvictionScheduler {
  readonly #deps: EvictionRuntimeDeps;
  #running: Promise<EvictionSummary> | null = null;
  #dirty = false;
  #closing = false;

  constructor(deps: EvictionRuntimeDeps) {
    this.#deps = deps;
  }

  /**
   * Ask for a drain. NEVER throws and never blocks: `onSucceeded` is a void
   * callback called past a download's commit point, so a throw here would
   * un-succeed a task that has already committed. Failures surface as a
   * rejected promise, which the caller may await (the manual route) or observe.
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
   * BEFORE closing the events sink and the database: a drain parked on a probe
   * wakes up in its `finally` and would otherwise touch both after they went
   * away. The drain itself is cut short by the signal, so the wait is short.
   */
  async close(): Promise<void> {
    this.#closing = true;
    try {
      await this.#running;
    } catch {
      // A failed drain is the scheduler's business, not teardown's; the
      // triggering call site already observed it.
    }
  }

  async #drain(): Promise<EvictionSummary> {
    // Past every microtask continuation — see DEFERRED above.
    await new Promise<void>((resolve) => this.#deps.defer(resolve));

    const evicted = new Map<string, number>();
    const skipped = new Map<string, number>();

    try {
      return await this.#rounds(evicted, skipped);
    } finally {
      // Clearing the slot and re-arming happen in the SAME synchronous step: a
      // trigger that lands between "the loop decided it was done" and "the slot
      // is free" would otherwise be recorded as dirty and never run.
      this.#running = null;
      if (this.#dirty && !this.#closing) {
        this.#dirty = false;
        void this.schedule().catch((err: unknown) => this.#deps.onBackgroundError(err));
      }
    }
  }

  /**
   * One pass, over every library this device holds.
   *
   * The other workspaces are opened here and closed here, per pass rather than
   * per scheduler: a drain that held a connection to somebody else's library
   * for the life of the process would be holding it during the next switch.
   */
  async #onePass(): Promise<EvictionRun> {
    const opened = this.#deps.openOtherWorkspaces?.();
    try {
      const options = {
        ...this.#deps.cacheOptions(),
        acquireFileClaim: this.#deps.acquireFileClaim,
        probe: this.#deps.probe,
        onEvicted: this.#deps.onEvicted,
        signal: this.#deps.signal,
      };
      const current = { id: 'current', files: this.#deps.files, db: this.#deps.db };
      if (opened === undefined || opened.workspaces.length === 0) {
        return await runEviction(current.files, current.db, options);
      }
      const across = await runEvictionAcross(current, { ...options, others: opened.workspaces });
      // Flattened: the rounds loop above cares about songs, not about which
      // library each came from, and the host's `onEvicted` already fired.
      return {
        evicted: across.runs.flatMap((entry) => entry.run.evicted),
        skipped_unverified: across.runs.flatMap((entry) => entry.run.skipped_unverified),
        failed: across.runs.flatMap((entry) => entry.run.failed),
      };
    } finally {
      opened?.close();
    }
  }

  async #rounds(
    evicted: Map<string, number>,
    skipped: Map<string, number>,
  ): Promise<EvictionSummary> {
    for (;;) {
      this.#dirty = false;
      const run = await this.#onePass();

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
        this.#deps.onDeleteFailed(item.song_id, item.message);
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
