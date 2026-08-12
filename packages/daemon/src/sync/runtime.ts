// Sync lifecycle state, and the mutual exclusion around it (v0.2 T3b, §3.11).
//
// Four operations change what a sync round is talking to — login, logout, a
// persisted token refresh, and unbind — and every one of them is a sequence
// with awaits in the middle. Two of them interleaving is not a rare race: a
// user hitting "log in" twice, or a refresh timer firing during a logout, is
// Tuesday. So:
//
//   ONE mutex serializes all four. They are rare and short; there is no case
//     where running two of them at once is better than running them in order.
//   ONE epoch counter numbers the sessions. Anything that awaited across a
//     lifecycle change compares the epoch it started with before it touches
//     shared state — its result describes a session that no longer exists.
//
// The runtime deliberately does NOT own the round itself. T3c attaches the
// triggers and the runner through `attachHandles`, and everything here needs
// from them is "stop, and tell me when the in-flight round has unwound".

import type { RunSyncResult } from '@lark/core';
import type { SyncAuthReason, SyncState } from '@lark/shared';
import type { AppContext } from '../context.js';
import { type SkybridgeApi, realSkybridgeApi } from './client.js';
import type { SyncTrigger } from './runner.js';
import type { SyncSession } from './session.js';

/**
 * The background half: the timers, the server subscription and the round.
 *
 * Attached ONCE per daemon, not per session — every trigger gates on "is there
 * a session right now", so they survive a logout and pick up the next login
 * without being rebuilt. `stop` ends them for good (daemon teardown);
 * `abortAndDrain` only ends the round in flight, which is what a lifecycle
 * change needs.
 */
export interface SyncBackgroundHandles {
  /** Ask for a round through the coalescer. Every caller goes through this. */
  run(trigger: SyncTrigger): Promise<RunSyncResult | null>;
  stop(): void;
  abortAndDrain(): Promise<void>;
}

export interface SyncRuntimeOptions {
  /** The SDK surface. Tests pass a fake; boot passes the real one. */
  api?: SkybridgeApi;
  /** Run the background triggers (timers + server subscription). Default true. */
  triggers?: boolean;
}

export class SyncRuntime {
  readonly api: SkybridgeApi;

  #session: SyncSession | null = null;
  #epoch = 0;
  /** Tail of the lifecycle chain — the mutex, as a promise nobody rejects. */
  #lifecycle: Promise<void> = Promise.resolve();
  #handles: SyncBackgroundHandles | null = null;

  /** Everything `GET /sync/status` reports about the current moment. */
  state: SyncState = 'auth_required';
  authReason: SyncAuthReason | null = 'missing_session';
  lastError: string | null = null;
  lastSyncAt: number | null = null;
  /** When the outbox was last trimmed — retention is hourly, not per round. */
  lastRetentionAt: number | null = null;
  /**
   * Whether this context runs background triggers at all.
   *
   * Off in tests by default: a unit test that logs in must not acquire a 1s
   * interval timer and a server subscription as a side effect.
   */
  readonly triggersEnabled: boolean;

  constructor(options: SyncRuntimeOptions = {}) {
    this.api = options.api ?? realSkybridgeApi;
    this.triggersEnabled = options.triggers ?? true;
  }

  get session(): SyncSession | null {
    return this.#session;
  }

  /** The current session number. Capture it before an await, compare it after. */
  get epoch(): number {
    return this.#epoch;
  }

  /** True when the session this epoch belonged to has been replaced or dropped. */
  isStale(epoch: number): boolean {
    return epoch !== this.#epoch;
  }

  attachHandles(handles: SyncBackgroundHandles): void {
    this.#handles = handles;
  }

  /**
   * Ask for a round. Every caller — the timers, the server stream, the route —
   * goes through the one coalescer, so two rounds never run at once.
   */
  run(trigger: SyncTrigger): Promise<RunSyncResult | null> {
    if (this.#handles === null) {
      throw new Error('sync handles are not attached to this context');
    }
    return this.#handles.run(trigger);
  }

  /**
   * Serialize a lifecycle operation.
   *
   * The chain absorbs rejections (`#lifecycle` is only ever a resolved
   * promise) so one failed login does not poison every later one; the caller
   * still sees its own error.
   */
  async lifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lifecycle.then(fn, fn);
    this.#lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * End the current session and wait for the round in flight to unwind.
   *
   * The epoch bump comes FIRST, before any await. Everything that resumes
   * after this point can then tell that it belongs to a session that is gone,
   * including the very round we are about to wait for.
   *
   * The handles stay attached: they are the daemon's, not the session's, and
   * every one of them already gates on "is there a session".
   */
  async teardownSession(): Promise<void> {
    this.#epoch += 1;
    this.#session = null;
    await this.#handles?.abortAndDrain();
  }

  /**
   * Drop the session WITHOUT waiting for anything.
   *
   * For the one caller that cannot await a drain: a round that just learned
   * its token is rejected is itself the round a drain would wait for.
   */
  dropSession(reason: SyncAuthReason): void {
    this.#epoch += 1;
    this.#session = null;
    this.noteAuthRequired(reason);
  }

  /** Daemon teardown: the triggers end for good. */
  stopHandles(): void {
    this.#handles?.stop();
  }

  installSession(session: SyncSession): void {
    this.#epoch += 1;
    this.#session = session;
    this.state = 'idle';
    this.authReason = null;
    this.lastError = null;
  }

  /** No session, and the reason a client should show for it. */
  noteAuthRequired(reason: SyncAuthReason): void {
    this.state = 'auth_required';
    this.authReason = reason;
  }

  noteError(message: string): void {
    this.state = 'error';
    this.lastError = message;
  }

  /** The server could not be reached — distinct from "it said no". */
  noteOffline(message: string): void {
    this.state = 'offline';
    this.lastError = message;
  }

  noteSyncing(): void {
    this.state = 'syncing';
  }

  noteSuccess(atMs: number): void {
    this.state = 'idle';
    this.lastError = null;
    this.lastSyncAt = atMs;
  }
}

/**
 * Complete a context with its sync runtime, the way `withEvictionScheduler`
 * completes it with the eviction driver: the two are mutually dependent (the
 * runtime reads the context on every round, the routes reach the runtime
 * through the context), so one of them is filled in after the fact and the
 * cast lives in exactly one documented place.
 */
export function withSyncRuntime<T extends Omit<AppContext, 'sync'>>(
  ctx: T,
  options: SyncRuntimeOptions = {},
): T & { sync: SyncRuntime } {
  const full = ctx as T & { sync: SyncRuntime };
  full.sync = new SyncRuntime(options);
  return full;
}
