// What starts a sync round, and the one queue they all go through (v0.2 T3c).
//
// Four things ask for a round:
//
//   the SERVER, over its event stream — somebody else pushed;
//   the OUTBOX, when this device has unpushed work (push-on-mutation);
//   the CLOCK, every `[sync] interval_min`, as the backstop that covers
//     everything the other two missed;
//   a PERSON, through `POST /sync/run`.
//
// The outbox trigger POLLS rather than listening for an in-process event, the
// same conclusion owl reached (`daemon/src/sync/outbox-watcher.ts`) for a
// reason that survives lark's differences: `emitSyncChange` runs inside the
// caller's transaction, so an event fired there can outlive a rollback, and an
// event fired after the commit relies on every future write path remembering
// to send one. Two paths here already would not — the login backfill and a
// conflict resolved as `local` both emit changes without touching the library
// event bus. Polling asks the only question that is always true or always
// false: is there a row nobody has pushed?
//
// The probe is `MAX(local_seq) WHERE synced_at IS NULL`, which the partial
// index from 0001 covers, and the debounce (quiet for 800ms, but never more
// than 5s of waiting) turns a burst of edits into one round instead of one
// round per keystroke.
//
// All four funnel through a two-slot coalescer: one round in flight, at most
// one queued behind it. A caller that arrives mid-round gets the FOLLOW-UP,
// never the in-flight promise — the in-flight round may have read the outbox
// before that caller's commit landed, and telling them "your change was
// pushed" would be a lie.

import type { RunSyncResult } from '@lark/core';
import type { AppContext } from '../context.js';
import { refreshSessionToken, tokenNeedsRefresh } from './refresh.js';
import { type SyncTrigger, runSyncRound } from './runner.js';
import type { SyncBackgroundHandles } from './runtime.js';

/** Outbox poll cadence, and the resolution of its debounce. */
const POLL_MS = 1_000;
/** Fire once the outbox has stopped growing for this long. */
const QUIET_MS = 800;
/** …but never wait longer than this, however fast the user keeps typing. */
const MAX_WAIT_MS = 5_000;
/** Backoff after a failed round, in ms. The last entry repeats. */
const BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];
/** ±20% spread, so devices that failed together do not retry in lockstep. */
const JITTER_RATIO = 0.2;
/** How often the token expiry is checked. */
const REFRESH_POLL_MS = 60_000;
/** After a stream error, wait this long before subscribing again. */
const SSE_COOLDOWN_MS = 30_000;

export interface SyncHandlesOptions {
  now?: () => number;
  random?: () => number;
}

/**
 * The background half of sync: the coalescer, three triggers and the refresh
 * timer. One per daemon, attached for its whole life — every trigger gates on
 * "is there a session right now", so a logout does not have to dismantle them
 * and a login does not have to rebuild them.
 */
export class SyncHandles implements SyncBackgroundHandles {
  readonly #ctx: AppContext;
  readonly #now: () => number;
  readonly #random: () => number;

  #stopped = false;
  #timers: NodeJS.Timeout[] = [];

  // ── coalescer ──
  #inflight: Promise<RunSyncResult | null> | null = null;
  #followUp: Promise<RunSyncResult | null> | null = null;
  #queued = new Set<SyncTrigger>();
  #controller: AbortController | null = null;

  // ── outbox debounce ──
  /** Highest pending local_seq seen; null when the outbox is clean. */
  #lastHi: number | null = null;
  #hiChangedAt = 0;
  #dirtySince = 0;
  #failures = 0;
  #nextAttemptAt = 0;

  // ── server stream ──
  #unsubscribe: (() => void) | null = null;
  #subscribedEpoch = -1;
  #sseBlockedUntil = 0;

  constructor(ctx: AppContext, options: SyncHandlesOptions = {}) {
    this.#ctx = ctx;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  /** Start the timers. Does nothing when this context runs without triggers. */
  start(): void {
    if (!this.#ctx.sync.triggersEnabled || this.#stopped) return;
    this.#every(POLL_MS, () => this.tickOutbox());
    this.#every(REFRESH_POLL_MS, () => void this.tickRefresh());
    // The config validator floors this at 1, so there is no "disabled" value to
    // handle — the guard is against a hand-edited file that got past a loader.
    const minutes = this.#ctx.config.sync.interval_min;
    if (minutes > 0) this.#every(minutes * 60_000, () => this.tickScheduler());
    this.#ctx.logger.info({ interval_min: minutes, poll_ms: POLL_MS }, 'sync triggers started');
  }

  #every(ms: number, fn: () => void): void {
    const timer = setInterval(fn, ms);
    // Without unref a daemon shutting down would wait out the longest interval
    // before the event loop could drain.
    timer.unref?.();
    this.#timers.push(timer);
  }

  /**
   * Ask for a round.
   *
   * A caller that arrives while one is running is served by the follow-up, not
   * by the round already in flight: that round may have read the outbox before
   * this caller's change was committed.
   */
  run(trigger: SyncTrigger): Promise<RunSyncResult | null> {
    this.#queued.add(trigger);
    if (this.#inflight === null) return this.#start();
    if (this.#followUp !== null) return this.#followUp;
    // The chain swallows the in-flight rejection: the follow-up's caller did
    // not ask for that attempt and must not inherit its failure.
    this.#followUp = this.#inflight
      .catch(() => undefined)
      .then(() => {
        this.#followUp = null;
        return this.#start();
      });
    return this.#followUp;
  }

  #start(): Promise<RunSyncResult | null> {
    const triggers = [...this.#queued];
    this.#queued.clear();
    const controller = new AbortController();
    this.#controller = controller;

    const round = runSyncRound(this.#ctx, { triggers, signal: controller.signal }).finally(() => {
      if (this.#inflight === round) {
        this.#inflight = null;
        this.#controller = null;
      }
    });
    this.#inflight = round;
    return round;
  }

  /** Stop the timers and the stream for good. The daemon is going away. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.#dropSubscription();
  }

  /**
   * Cancel the round in flight and wait for it to unwind.
   *
   * Cooperative: `runSync` stops between batches, so a round parked on a slow
   * request finishes that request first. It never abandons a batch midway,
   * which is the property that lets the cursor and the apply share one
   * transaction.
   */
  async abortAndDrain(): Promise<void> {
    this.#dropSubscription();
    this.#controller?.abort(new Error('sync session replaced'));
    const pending = [this.#inflight, this.#followUp].filter(
      (p): p is Promise<RunSyncResult | null> => p !== null,
    );
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  // ── triggers ──

  /**
   * One outbox poll. Public because the tests drive it directly: an assertion
   * about a debounce should not have to wait a real second for it.
   */
  tickOutbox(): void {
    if (!this.#ready()) return;
    this.#ensureSubscription();
    if (this.#inflight !== null) {
      // Load-bearing: the coalescer runs a follow-up even when the in-flight
      // round rejected, so polling into it every second would re-run a failing
      // push immediately and step straight over the backoff below.
      return;
    }
    const hi = this.#dueNow();
    if (hi === null) return;
    void this.#runTracked('outbox');
  }

  tickScheduler(): void {
    if (!this.#ready() || this.#inflight !== null) return;
    if (this.#now() < this.#nextAttemptAt) return;
    void this.#runTracked('scheduler');
  }

  async tickRefresh(): Promise<void> {
    if (this.#stopped || !tokenNeedsRefresh(this.#ctx, this.#now())) return;
    await refreshSessionToken(this.#ctx);
  }

  /** Run, and let the outcome drive the backoff the triggers respect. */
  async #runTracked(trigger: SyncTrigger): Promise<void> {
    const epoch = this.#ctx.sync.epoch;
    try {
      await this.run(trigger);
      if (this.#stale(epoch)) return;
      this.#failures = 0;
      this.#nextAttemptAt = 0;
      // Whatever is still pending after a successful round starts a fresh
      // dirty window rather than an already-expired one.
      this.#lastHi = null;
      this.#dirtySince = 0;
    } catch {
      if (this.#stale(epoch)) return;
      this.#failures += 1;
      const base = BACKOFF_MS[Math.min(this.#failures - 1, BACKOFF_MS.length - 1)];
      const delay = Math.round(base * (1 + (this.#random() - 0.5) * 2 * JITTER_RATIO));
      this.#nextAttemptAt = this.#now() + delay;
      // The round itself already logged what went wrong.
    }
  }

  #stale(epoch: number): boolean {
    return this.#stopped || this.#ctx.sync.isStale(epoch);
  }

  /** A round can only succeed with a session; anything else is silence. */
  #ready(): boolean {
    return !this.#stopped && this.#ctx.sync.session !== null;
  }

  /**
   * Is the outbox due? Owns the debounce bookkeeping so `tickOutbox` reads as
   * a straight line.
   */
  #dueNow(): number | null {
    const row = this.#ctx.sqlite
      .prepare('SELECT MAX(local_seq) AS hi FROM sync_changes WHERE synced_at IS NULL')
      .get() as { hi: number | null } | undefined;
    const hi = row?.hi ?? null;
    const now = this.#now();

    if (hi === null) {
      this.#lastHi = null;
      this.#dirtySince = 0;
      return null;
    }
    if (hi !== this.#lastHi) {
      this.#lastHi = hi;
      this.#hiChangedAt = now;
      if (this.#dirtySince === 0) this.#dirtySince = now;
    }
    if (now < this.#nextAttemptAt) return null;
    const settled = now - this.#hiChangedAt >= QUIET_MS;
    const starved = now - this.#dirtySince >= MAX_WAIT_MS;
    return settled || starved ? hi : null;
  }

  // ── the server's event stream ──

  #ensureSubscription(): void {
    const session = this.#ctx.sync.session;
    if (session === null) {
      this.#dropSubscription();
      return;
    }
    if (this.#unsubscribe !== null) {
      if (!this.#ctx.sync.isStale(this.#subscribedEpoch)) return;
      this.#dropSubscription(); // the session was replaced under us
    }
    if (this.#now() < this.#sseBlockedUntil) return;

    const epoch = this.#ctx.sync.epoch;
    this.#subscribedEpoch = epoch;
    try {
      this.#unsubscribe = session.client.subscribeEvents(session.workspaceId, {
        onChange: () => {
          if (this.#stale(epoch)) return;
          void this.#runTracked('remote');
        },
        onError: (err) => {
          // The SDK does not reconnect (it is deliberately stateless), so the
          // stream is dead until the next poll rebuilds it — after a cooldown,
          // so a server refusing the stream is not asked once a second.
          this.#ctx.logger.warn({ err }, 'sync event stream failed');
          this.#sseBlockedUntil = this.#now() + SSE_COOLDOWN_MS;
          this.#subscribedEpoch = -1;
        },
      });
    } catch (err) {
      this.#ctx.logger.warn({ err }, 'could not open the sync event stream');
      this.#sseBlockedUntil = this.#now() + SSE_COOLDOWN_MS;
    }
  }

  #dropSubscription(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    this.#subscribedEpoch = -1;
    if (unsubscribe === null) return;
    try {
      unsubscribe();
    } catch (err) {
      this.#ctx.logger.warn({ err }, 'closing the sync event stream failed');
    }
  }
}

/**
 * Build the handles and hand them to the runtime.
 *
 * Called right after the context is complete — including on contexts that run
 * without triggers, because `POST /sync/run` goes through the same coalescer
 * and a context whose manual runs bypassed it would have two paths into one
 * database.
 */
export function attachSyncHandles(ctx: AppContext, options: SyncHandlesOptions = {}): SyncHandles {
  const handles = new SyncHandles(ctx, options);
  ctx.sync.attachHandles(handles);
  handles.start();
  return handles;
}
