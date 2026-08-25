// What starts a sync round on a PHONE (N5d; the daemon's counterpart is
// `daemon/src/sync/triggers.ts`).
//
// N1f split this question in two. `SyncRoundQueue` in `@lark/core/portable`
// owns what happens once somebody asks — the coalescer, the 800ms debounce,
// the backoff with jitter, the "is there a session" gate — and every host must
// reuse it rather than answer differently. What is left is the half an
// operating system has opinions about, and Android has more of them than a
// daemon's host does:
//
//   🔴 JS TIMERS DO NOT RUN IN THE BACKGROUND. That is not a guess; it is the
//      fourth time this app has been bitten by it (`docs/LESSONS.md`). A
//      `setInterval` armed at boot and left alone — which is exactly what the
//      daemon does — would fire while the app is in front of somebody and
//      silently stop when it is not, so the honest thing is to say so in the
//      structure rather than discover it as a bug report.
//   🔴 A LONG-LIVED SOCKET UNDER A DARK SCREEN IS A BATTERY BUG. The server's
//      event stream is dropped on the way out and rebuilt on the way back.
//
// So sync runs IN THE FOREGROUND ONLY (decision b, recorded as deferred rather
// than rejected), and coming back to the foreground is itself a trigger. The
// product consequence is real and belongs on a screen, not in a comment: this
// phone does not learn about another device's edits while it is in a pocket.
// It catches up the moment it is looked at.
//
// SUSPEND DOES NOT TOUCH THE SESSION. Backgrounding is not a lifecycle change
// — `teardownSession` is for login, logout and unbind — so the epoch does not
// move, nothing is dropped, and a round in flight is left alone rather than
// aborted: it may well finish, and killing work the OS had not yet frozen
// would be this file inventing a failure.

import {
  type CoordinatorContext,
  type RunSyncResult,
  type StructuredLogger,
  type SyncBackgroundHandles,
  SyncRoundQueue,
  SyncStreamController,
  type SyncTrigger,
  refreshSessionToken,
  restoreSession,
  tokenNeedsRefresh,
} from '@lark/core/portable';
import type { AppStateSource } from './app-state';

/** Outbox poll cadence, and the resolution of the queue's debounce. */
const POLL_MS = 1_000;
/** How often the token expiry is checked while the app is in front. */
const REFRESH_POLL_MS = 60_000;

/**
 * The part of `SyncRoundQueue` this file uses.
 *
 * Named as an interface so a test can hand over a recorder: what is on trial
 * here is WHICH trigger fires WHEN, and driving that through a real queue
 * would mean driving it through a real round against a real server.
 */
export interface RoundQueueLike {
  readonly busy: boolean;
  readonly backoffElapsed: boolean;
  ready(): boolean;
  outboxDue(): number | null;
  runTracked(trigger: SyncTrigger): Promise<void>;
  run(trigger: SyncTrigger): Promise<RunSyncResult | null>;
  stop(): void;
  abortAndDrain(): Promise<void>;
}

export interface MobileSyncHandlesOptions {
  /** TEST SEAM. Defaults to a real `SyncRoundQueue` over the context. */
  queue?: RoundQueueLike;
  /**
   * TEST SEAM: token upkeep, which otherwise needs a session and a server.
   * Defaults to the portable pair the daemon's `tickRefresh` uses.
   */
  refresh?: () => Promise<void>;
  /** TEST SEAM: the shared stream controller. */
  stream?: SyncStreamController;
  /**
   * Only for the one line `syncTriggersOnce` logs about the restored session —
   * everything else here writes through `ctx.logger`, which on this phone is
   * the same ring (`downloads/log.ts`).
   */
  logger?: StructuredLogger;
}

/**
 * The background half of sync on this phone.
 *
 * One per process, attached for its whole life. Every trigger gates on "is
 * there a session right now", so a logout does not dismantle it and a login
 * does not rebuild it — the same arrangement the daemon has, for the same
 * reason.
 */
export class MobileSyncHandles implements SyncBackgroundHandles {
  readonly #ctx: CoordinatorContext;
  readonly #queue: RoundQueueLike;
  readonly #refresh: () => Promise<void>;
  readonly #appState: AppStateSource;
  /**
   * The server stream, its cooldown and its idle watchdog (N5d-2).
   *
   * Shared with the daemon rather than written twice — the policy is identical
   * and the drift would not be. What stays here is WHEN to hold one at all:
   * a stream open under a dark screen is a battery bug, so `#suspend` drops it
   * and `#resume` lets the poll rebuild it.
   */
  readonly #stream: SyncStreamController;

  #stopped = false;
  /** Whether the timers and the stream should be running at all. */
  #foreground = false;
  #timers: ReturnType<typeof setInterval>[] = [];
  /** The clock trigger specifically: the one `rearmScheduler` replaces. */
  #scheduler: ReturnType<typeof setInterval> | null = null;
  #unwatchAppState: (() => void) | null = null;

  constructor(
    ctx: CoordinatorContext,
    appState: AppStateSource,
    options: MobileSyncHandlesOptions = {},
  ) {
    this.#ctx = ctx;
    this.#appState = appState;
    this.#queue = options.queue ?? new SyncRoundQueue(ctx);
    this.#stream = options.stream ?? new SyncStreamController(ctx, this.#queue);
    this.#refresh = options.refresh ?? (() => this.#refreshToken());
  }

  /** Whether the timers are armed right now. For tests and the settings page. */
  get running(): boolean {
    return this.#foreground && !this.#stopped;
  }

  /**
   * Begin watching the foreground, and resume immediately if we are already in
   * it — which is the normal case, because this is called from `App`'s boot.
   */
  start(): void {
    if (this.#stopped || this.#unwatchAppState !== null) return;
    this.#unwatchAppState = this.#appState.subscribe((active) => {
      if (active) this.#resume();
      else this.#suspend();
    });
    if (this.#appState.active()) this.#resume();
  }

  // ── SyncBackgroundHandles ──

  /** Ask for a round. Every caller goes through the one queue. */
  run(trigger: SyncTrigger): Promise<RunSyncResult | null> {
    return this.#queue.run(trigger);
  }

  /**
   * Put the clock trigger on the current interval.
   *
   * The interval is a constant here (decision d), so unlike the desktop's this
   * is never called by a settings change — but the runtime calls it through
   * `SyncRuntime.rearmScheduler()`, and a resume has to arm it in the first
   * place. Re-arming restarts the period rather than shortening it.
   */
  rearmScheduler(): void {
    if (this.#scheduler !== null) {
      clearInterval(this.#scheduler);
      this.#timers = this.#timers.filter((timer) => timer !== this.#scheduler);
      this.#scheduler = null;
    }
    if (!this.running) return;
    const minutes = this.#ctx.intervalMin();
    if (minutes > 0) this.#scheduler = this.#every(minutes * 60_000, () => this.tickScheduler());
  }

  /** Stop everything for good. The process is going away. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#queue.stop();
    this.#suspend();
    this.#stream.stop();
    this.#unwatchAppState?.();
    this.#unwatchAppState = null;
  }

  /**
   * Cancel the round in flight and wait for it to unwind.
   *
   * The subscription goes first: it is the one trigger that can fire from
   * outside this process while the drain is waiting.
   */
  async abortAndDrain(): Promise<void> {
    this.#stream.drop();
    await this.#queue.abortAndDrain();
  }

  // ── foreground transitions ──

  /**
   * Back in front of somebody. Arm the timers, then catch up.
   *
   * THE ORDER MATTERS. The token is checked BEFORE the round, because an app
   * that has been in a pocket for two hours is holding an access token that
   * very likely expired in it — and running the round first would spend a
   * request learning that, drop the session on the 401, and ask the person to
   * log in again for no reason.
   */
  #resume(): void {
    if (this.#stopped || this.#foreground) return;
    this.#foreground = true;
    this.#every(POLL_MS, () => this.tickOutbox());
    this.#every(REFRESH_POLL_MS, () => void this.#refresh());
    this.rearmScheduler();
    void this.#catchUp();
  }

  async #catchUp(): Promise<void> {
    await this.#refresh();
    if (this.#stopped || !this.#queue.ready()) return;
    void this.#queue.runTracked('resume');
  }

  /**
   * Out of sight. Stop asking, and let go of the socket.
   *
   * It deliberately does NOT touch the session, abort the round in flight, or
   * tell the runtime anything: none of those is what backgrounding means, and
   * a status that flipped to `auth_required` every time somebody took a call
   * would be a lie on the badge.
   */
  #suspend(): void {
    this.#foreground = false;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.#scheduler = null;
    this.#stream.drop();
  }

  #every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const timer = setInterval(fn, ms);
    this.#timers.push(timer);
    return timer;
  }

  // ── triggers ──

  /**
   * One outbox poll. Public because the tests drive it directly: an assertion
   * about a debounce should not have to wait a real second for it.
   */
  tickOutbox(): void {
    if (!this.#queue.ready()) return;
    if (this.running) this.#stream.ensure();
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

  async #refreshToken(): Promise<void> {
    if (this.#stopped || !tokenNeedsRefresh(this.#ctx, this.#ctx.now())) return;
    await refreshSessionToken(this.#ctx);
  }
}

let handles: MobileSyncHandles | null = null;

/**
 * The handles this process gets, once, whatever the Activity does.
 *
 * A second set would be a second `AppState` listener, a second poll and a
 * second subscription over one session — and, worse, a second `SyncRoundQueue`,
 * which is the one thing the whole coalescer exists to prevent.
 */
export function syncTriggersOnce(
  ctx: CoordinatorContext,
  appState: AppStateSource,
  options: MobileSyncHandlesOptions = {},
): MobileSyncHandles {
  if (handles === null) {
    // Rebuild the session from SecureStore before anything can look for one.
    // OFFLINE BY CONSTRUCTION — it reads the credential store and the binding
    // row and makes no request, so this app comes up in the same state on a
    // plane as on wifi, and it is the first ROUND that discovers a token the
    // server no longer honours. Same order and same reason as
    // `daemon/src/boot.ts`, and inside the once-gate because installing a
    // session bumps the epoch: doing it again on an Activity remount would
    // invalidate a round that was already in flight.
    const restored = restoreSession(ctx);
    options.logger?.info({ restored: restored.installed }, 'sync session restored');

    handles = new MobileSyncHandles(ctx, appState, options);
    ctx.sync.attachHandles(handles);
    handles.start();
  }
  return handles;
}

/** Tests only. See `resetSyncHubForTests`. */
export function resetSyncTriggersForTests(): void {
  handles?.stop();
  handles = null;
}
