// The server's event stream, and the two ways it lies about being alive
// (N5d-2; the shape is owl's, arrived at the hard way in its `sse-bridge.ts`).
//
// Subscribing is one line. Everything else in this file exists because a
// stream that is up is not the same thing as a stream that is working:
//
//   ① IT DOES NOT REPLAY. The server sends what happens AFTER a subscription,
//      never what happened before one. So a client that was disconnected —
//      offline, asleep, mid-reconnect — has a hole exactly the width of the
//      gap, and nothing in the protocol closes it. `onOpen` therefore runs a
//      catch-up round: the pull is the replay. Without it the hole stays open
//      until the clock trigger comes round, which is five minutes on the
//      desktop and fifteen on a phone.
//   ② IT CAN GO SILENT WITHOUT SAYING SO. A half-open socket — no FIN, no
//      RST, no read error — fires NO callback at all. `onError` only ever
//      covers explicit disconnects, so without a watchdog a client sits in a
//      zombie "connected" state forever, believing it will be told. The server
//      writes `:ok` on open and `event: ping` every 25s
//      (`skybridge/packages/server/src/routes/events.ts`), the SDK forwards
//      every frame to `onFrame`, and a frame — any frame — is proof of life.
//      Sixty seconds of silence is two missed pings, and it is treated exactly
//      as an error: drop the zombie, cool down, let the host's poll rebuild.
//
// WHY THIS IS PORTABLE AND THE TIMERS AROUND IT ARE NOT. N1f drew the line at
// "what an operating system has opinions about" and left the stream with the
// hosts, which was right when the stream was a subscribe call and a cooldown.
// It stopped being right the moment there were two policies to keep in step:
// the daemon and the phone would have grown two watchdogs that agree for a
// while, and the way that drift shows up is "the phone reconnected and the
// laptop did not". `setTimeout` is a language global, not a host API — the
// portable guard has always allowed it (`library/eviction-runtime.ts` uses it).

import type { CoordinatorContext } from './context.js';
import type { SyncTrigger } from './runner.js';

/** After a stream failure, wait this long before subscribing again. */
export const SSE_COOLDOWN_MS = 30_000;
/**
 * How long a stream may stay silent before it is presumed dead.
 *
 * Two missed pings. Anything tighter would kill healthy streams on a slow
 * network; anything looser leaves a zombie collecting nothing for minutes.
 */
export const SSE_IDLE_MS = 60_000;

/** The one thing this controller does with a round: ask for one. */
export interface SyncStreamQueue {
  runTracked(trigger: SyncTrigger): Promise<void>;
}

export interface SyncStreamOptions {
  cooldownMs?: number;
  /** 0 disables the watchdog — for a test that wants to drive it by hand. */
  idleMs?: number;
}

/** What `session.client.subscribeEvents` is called with, minus the SDK types. */
type Unsubscribe = () => void;

export class SyncStreamController {
  readonly #ctx: CoordinatorContext;
  readonly #queue: SyncStreamQueue;
  readonly #cooldownMs: number;
  readonly #idleMs: number;

  #stopped = false;
  #unsubscribe: Unsubscribe | null = null;
  #subscribedEpoch = -1;
  #blockedUntil = 0;
  #watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: CoordinatorContext, queue: SyncStreamQueue, options: SyncStreamOptions = {}) {
    this.#ctx = ctx;
    this.#queue = queue;
    this.#cooldownMs = options.cooldownMs ?? SSE_COOLDOWN_MS;
    this.#idleMs = options.idleMs ?? SSE_IDLE_MS;
  }

  /** True while a subscription is installed. For tests and diagnostics. */
  get open(): boolean {
    return this.#unsubscribe !== null;
  }

  /**
   * Subscribe if we should be and are not.
   *
   * Called from whatever the host polls on. Idempotent and cheap: the common
   * case is "already subscribed to the current session", which returns after
   * two comparisons.
   */
  ensure(): void {
    if (this.#stopped) return;
    const session = this.#ctx.sync.session;
    if (session === null) {
      this.drop();
      return;
    }
    if (this.#unsubscribe !== null) {
      if (!this.#ctx.sync.isStale(this.#subscribedEpoch)) return;
      this.drop(); // the session was replaced under us
    }
    if (this.#ctx.now() < this.#blockedUntil) return;

    const epoch = this.#ctx.sync.epoch;
    this.#subscribedEpoch = epoch;
    try {
      this.#unsubscribe = session.client.subscribeEvents(session.workspaceId, {
        onOpen: () => {
          if (this.#dead(epoch)) return;
          this.#armWatchdog(epoch);
          // ①: the pull IS the replay. Deliberately unconditional — a stream
          // opening is either this client's first (and the outbox may hold
          // work from before it had a session) or a reconnection (and the gap
          // is exactly what nobody will tell us about). The coalescer collapses
          // it against a round already running, so the cost of the redundant
          // case is one follow-up, and the cost of the missing case is silence
          // until the clock comes round.
          void this.#queue.runTracked('remote');
        },
        // ②: any frame is proof of life — `:ok`, `ping` and `change` alike.
        onFrame: () => {
          if (this.#dead(epoch)) return;
          this.#armWatchdog(epoch);
        },
        onChange: () => {
          if (this.#dead(epoch)) return;
          void this.#queue.runTracked('remote');
        },
        onError: (err: unknown) => {
          // The SDK does not reconnect (it is deliberately stateless), so the
          // stream is dead until the host's poll rebuilds it — after a
          // cooldown, so a server refusing the stream is not asked once a
          // second.
          this.#fail('sync event stream failed', err);
        },
      });
      // A server that never sends `:ok` would leave the watchdog unarmed, so
      // it starts here rather than only in `onOpen`. Every frame resets it.
      this.#armWatchdog(epoch);
    } catch (err) {
      this.#fail('could not open the sync event stream', err);
    }
  }

  /** Let go of the stream. The session is not this controller's business. */
  drop(): void {
    this.#clearWatchdog();
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

  /** No more subscriptions. The host is going away. */
  stop(): void {
    this.#stopped = true;
    this.drop();
  }

  /** A callback that belongs to a stream nobody is listening to any more. */
  #dead(epoch: number): boolean {
    return this.#stopped || this.#ctx.sync.isStale(epoch);
  }

  #armWatchdog(epoch: number): void {
    this.#clearWatchdog();
    if (this.#idleMs <= 0) return;
    this.#watchdog = setTimeout(() => {
      if (this.#dead(epoch)) return;
      this.#fail(`sync event stream went silent for ${this.#idleMs}ms`, null);
    }, this.#idleMs);
    // Node keeps the event loop alive for a pending timer; a daemon shutting
    // down must not wait out a minute of silence to exit. No-op in a runtime
    // that has never heard of it, which is every one but Node's.
    this.#watchdog?.unref?.();
  }

  #clearWatchdog(): void {
    if (this.#watchdog === null) return;
    clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  /**
   * The one exit for both ways a stream stops working.
   *
   * A silent stream and a broken one are the same problem wearing different
   * clothes, and the response is the same: let go, wait, let the poll try
   * again. Keeping them on one path is what stops the watchdog from growing a
   * recovery policy of its own.
   */
  #fail(message: string, err: unknown): void {
    this.#ctx.logger.warn(err === null ? {} : { err }, message);
    this.drop();
    this.#blockedUntil = this.#ctx.now() + this.#cooldownMs;
  }
}
