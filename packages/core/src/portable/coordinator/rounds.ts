// The queue every sync round goes through, and the two questions the host's
// triggers ask it (v0.2 T3c; extracted from the daemon's `triggers.ts` in N1f).
//
// A host decides WHEN to ask — a timer, a foreground transition, a push
// notification, a button. What happens once it asks is the same everywhere,
// and all of it is here:
//
//   the COALESCER — one round in flight, at most one queued behind it. A
//     caller that arrives mid-round gets the FOLLOW-UP, never the in-flight
//     promise: that round may have read the outbox before this caller's commit
//     landed, and telling them "your change was pushed" would be a lie.
//   the BACKOFF — a failed round pushes the next attempt out, with jitter, so
//     devices that failed together do not retry in lockstep.
//   the DEBOUNCE — `MAX(local_seq) WHERE synced_at IS NULL` (covered by the
//     partial index from 0001), quiet for 800ms but never starved beyond 5s,
//     which turns a burst of edits into one round instead of one per keystroke.
//   the STATE GATE — a round can only succeed with a session, and a result
//     that arrives after its session was replaced changes nothing.
//
// The timers and the server's event stream stay with the host: they are how a
// platform says "later" and "somebody else pushed", and those are the two
// things an OS has opinions about.

import type { RunSyncResult } from '../sync/engine.js';
import type { CoordinatorContext } from './context.js';
import { type SyncTrigger, runSyncRound } from './runner.js';

/** Fire once the outbox has stopped growing for this long. */
const QUIET_MS = 800;
/** …but never wait longer than this, however fast the user keeps typing. */
const MAX_WAIT_MS = 5_000;
/** Backoff after a failed round, in ms. The last entry repeats. */
const BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];
/** ±20% spread, so devices that failed together do not retry in lockstep. */
const JITTER_RATIO = 0.2;

export interface SyncRoundQueueOptions {
  /** Jitter source. Injected so a test gets a backoff it can predict. */
  random?: () => number;
}

export class SyncRoundQueue {
  readonly #ctx: CoordinatorContext;
  readonly #random: () => number;

  #stopped = false;

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

  constructor(ctx: CoordinatorContext, options: SyncRoundQueueOptions = {}) {
    this.#ctx = ctx;
    this.#random = options.random ?? Math.random;
  }

  /** True once `stop()` has run — the host is going away. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** True while a round is running. Triggers skip rather than pile up. */
  get busy(): boolean {
    return this.#inflight !== null;
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

  /** Run, and let the outcome drive the backoff the triggers respect. */
  async runTracked(trigger: SyncTrigger): Promise<void> {
    const epoch = this.#ctx.sync.epoch;
    try {
      await this.run(trigger);
      if (this.stale(epoch)) return;
      this.#failures = 0;
      this.#nextAttemptAt = 0;
      // Whatever is still pending after a successful round starts a fresh
      // dirty window rather than an already-expired one.
      this.#lastHi = null;
      this.#dirtySince = 0;
    } catch {
      if (this.stale(epoch)) return;
      this.#failures += 1;
      const base = BACKOFF_MS[Math.min(this.#failures - 1, BACKOFF_MS.length - 1)];
      const delay = Math.round(base * (1 + (this.#random() - 0.5) * 2 * JITTER_RATIO));
      this.#nextAttemptAt = this.#ctx.now() + delay;
      // The round itself already logged what went wrong.
    }
  }

  /** Has the backoff expired? The clock trigger asks before it fires. */
  get backoffElapsed(): boolean {
    return this.#ctx.now() >= this.#nextAttemptAt;
  }

  stale(epoch: number): boolean {
    return this.#stopped || this.#ctx.sync.isStale(epoch);
  }

  /** A round can only succeed with a session; anything else is silence. */
  ready(): boolean {
    return !this.#stopped && this.#ctx.sync.session !== null;
  }

  /**
   * Is the outbox due? Owns the debounce bookkeeping so the host's poll reads
   * as a straight line.
   */
  outboxDue(): number | null {
    const row = this.#ctx.db.sqlite
      .prepare('SELECT MAX(local_seq) AS hi FROM sync_changes WHERE synced_at IS NULL')
      .get() as { hi: number | null } | undefined;
    const hi = row?.hi ?? null;
    const now = this.#ctx.now();

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

  /** No more rounds start after this. */
  stop(): void {
    this.#stopped = true;
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
    this.#controller?.abort(new Error('sync session replaced'));
    const pending = [this.#inflight, this.#followUp].filter(
      (p): p is Promise<RunSyncResult | null> => p !== null,
    );
    if (pending.length > 0) await Promise.allSettled(pending);
  }
}
