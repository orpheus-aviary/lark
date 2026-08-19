// What starts a sync round on THIS host (v0.2 T3c; halved in N1f).
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
// What is LEFT in this file after N1f is exactly the part an operating system
// has opinions about: `setInterval`, `unref`, and the SDK's event stream. The
// coalescer, the debounce, the backoff and the "is there a session" gate went
// to `@lark/core/portable` (`coordinator/rounds.ts`) — a phone asks at
// different moments, and must not answer differently.

import {
  type RunSyncResult,
  type SyncBackgroundHandles,
  SyncRoundQueue,
  type SyncTrigger,
} from '@lark/core';
import type { AppContext } from '../context.js';
import { coordinatorContext, refreshSessionToken, tokenNeedsRefresh } from './coordinator.js';

/** Outbox poll cadence, and the resolution of its debounce. */
const POLL_MS = 1_000;
/** How often the token expiry is checked. */
const REFRESH_POLL_MS = 60_000;
/** After a stream error, wait this long before subscribing again. */
const SSE_COOLDOWN_MS = 30_000;

export interface SyncHandlesOptions {
  now?: () => number;
  random?: () => number;
}

/**
 * The background half of sync: the timers, the server subscription and the
 * round queue they drive. One per daemon, attached for its whole life — every
 * trigger gates on "is there a session right now", so a logout does not have
 * to dismantle them and a login does not have to rebuild them.
 */
export class SyncHandles implements SyncBackgroundHandles {
  readonly #ctx: AppContext;
  readonly #now: () => number;
  readonly #queue: SyncRoundQueue;

  #stopped = false;
  #timers: NodeJS.Timeout[] = [];
  /** The clock trigger specifically: it is the one that can be re-armed (F1). */
  #scheduler: NodeJS.Timeout | null = null;

  // ── server stream ──
  #unsubscribe: (() => void) | null = null;
  #subscribedEpoch = -1;
  #sseBlockedUntil = 0;

  constructor(ctx: AppContext, options: SyncHandlesOptions = {}) {
    this.#ctx = ctx;
    this.#now = options.now ?? Date.now;
    // One context for the queue's whole life, carrying THIS host's clock: the
    // trigger tests drive a virtual one, and a queue reading a different clock
    // to the timers around it would debounce against a time nobody is at.
    this.#queue = new SyncRoundQueue(
      { ...coordinatorContext(ctx), now: this.#now },
      options.random === undefined ? {} : { random: options.random },
    );
  }

  /** Start the timers. Does nothing when this context runs without triggers. */
  start(): void {
    if (!this.#ctx.sync.triggersEnabled || this.#stopped) return;
    this.#every(POLL_MS, () => this.tickOutbox());
    this.#every(REFRESH_POLL_MS, () => void this.tickRefresh());
    this.rearmScheduler();
    this.#ctx.logger.info(
      { interval_min: this.#ctx.config.sync.interval_min, poll_ms: POLL_MS },
      'sync triggers started',
    );
  }

  /**
   * Re-read `[sync] interval_min` and put the clock trigger on the new one
   * (F1).
   *
   * Called by `PATCH /config`, because the interval used to be read exactly
   * once — at boot. Changing it in the settings page wrote the file, updated
   * the in-memory config and re-rendered the field, and the timer went on
   * firing at the old cadence until the next restart, with nothing on any
   * screen saying so.
   *
   * Re-arming restarts the period rather than shortening the current one: a
   * user who just moved 60 minutes to 5 waits 5 from now, which is both what
   * they meant and the easier promise to keep.
   */
  rearmScheduler(): void {
    if (this.#scheduler !== null) {
      clearInterval(this.#scheduler);
      this.#timers = this.#timers.filter((timer) => timer !== this.#scheduler);
      this.#scheduler = null;
    }
    if (this.#stopped || !this.#ctx.sync.triggersEnabled) return;
    // The config validator floors this at 1, so there is no "disabled" value to
    // handle — the guard is against a hand-edited file that got past a loader.
    const minutes = this.#ctx.config.sync.interval_min;
    if (minutes > 0) this.#scheduler = this.#every(minutes * 60_000, () => this.tickScheduler());
  }

  #every(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setInterval(fn, ms);
    // Without unref a daemon shutting down would wait out the longest interval
    // before the event loop could drain.
    timer.unref?.();
    this.#timers.push(timer);
    return timer;
  }

  /** Ask for a round. Every caller goes through the one queue. */
  run(trigger: SyncTrigger): Promise<RunSyncResult | null> {
    return this.#queue.run(trigger);
  }

  /** Stop the timers and the stream for good. The daemon is going away. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#queue.stop();
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.#scheduler = null;
    this.#dropSubscription();
  }

  /**
   * Cancel the round in flight and wait for it to unwind.
   *
   * The subscription goes first: it is the one trigger that can fire from
   * outside this process while the drain is waiting.
   */
  async abortAndDrain(): Promise<void> {
    this.#dropSubscription();
    await this.#queue.abortAndDrain();
  }

  // ── triggers ──

  /**
   * One outbox poll. Public because the tests drive it directly: an assertion
   * about a debounce should not have to wait a real second for it.
   */
  tickOutbox(): void {
    if (!this.#queue.ready()) return;
    this.#ensureSubscription();
    if (this.#queue.busy) {
      // Load-bearing: the coalescer runs a follow-up even when the in-flight
      // round rejected, so polling into it every second would re-run a failing
      // push immediately and step straight over the backoff.
      return;
    }
    if (this.#queue.outboxDue() === null) return;
    void this.#queue.runTracked('outbox');
  }

  tickScheduler(): void {
    if (!this.#queue.ready() || this.#queue.busy) return;
    if (!this.#queue.backoffElapsed) return;
    void this.#queue.runTracked('scheduler');
  }

  async tickRefresh(): Promise<void> {
    if (this.#stopped || !tokenNeedsRefresh(this.#ctx, this.#now())) return;
    await refreshSessionToken(this.#ctx);
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
          if (this.#queue.stale(epoch)) return;
          void this.#queue.runTracked('remote');
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
