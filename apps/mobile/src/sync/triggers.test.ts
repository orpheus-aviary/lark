// When this phone asks for a round (N5d, criteria 77–79).
//
// What is on trial is the half the daemon does not have: a host that goes
// away. The queue's own behaviour — coalescing, the 800ms debounce, the
// backoff — is settled in core and deliberately faked here, because driving it
// would mean driving a real round against a real server to learn something
// core already proves.
//
// Backgrounding a real phone and watching what stops is the worst possible way
// to check this: the symptom of a leaked timer is a battery figure a week
// later, and the symptom of a session dropped on suspend is somebody being
// asked to log in again for no reason they can describe.

import {
  type CoordinatorContext,
  SyncRuntime,
  type SyncSession,
  type SyncTrigger,
} from '@lark/core/portable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSource } from './app-state';
import { MobileSyncHandles, type RoundQueueLike } from './triggers';

// ── the seams ──

class FakeQueue implements RoundQueueLike {
  busy = false;
  backoffElapsed = true;
  due: number | null = null;
  session = true;
  readonly triggers: SyncTrigger[] = [];
  stopped = false;
  drained = 0;

  ready(): boolean {
    return !this.stopped && this.session;
  }
  outboxDue(): number | null {
    return this.due;
  }
  async runTracked(trigger: SyncTrigger): Promise<void> {
    this.triggers.push(trigger);
  }
  async run(trigger: SyncTrigger): Promise<null> {
    this.triggers.push(trigger);
    return null;
  }
  stop(): void {
    this.stopped = true;
  }
  async abortAndDrain(): Promise<void> {
    this.drained += 1;
  }
}

function fakeAppState(active: boolean) {
  const listeners = new Set<(active: boolean) => void>();
  let current = active;
  const source: AppStateSource = {
    active: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    go(next: boolean) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/** Everything the handles actually read off the context, and nothing else. */
function fakeContext(): CoordinatorContext {
  const sync = new SyncRuntime();
  return {
    sync,
    now: () => Date.now(),
    intervalMin: () => 15,
  } as unknown as CoordinatorContext;
}

/** A session whose only real part is the stream — the rest is never read here. */
function fakeSession(onUnsubscribe: () => void) {
  const opened: { onChange: () => void }[] = [];
  const session = {
    workspaceId: 'w',
    client: {
      subscribeEvents: (_workspace: string, handlers: { onChange: () => void }) => {
        opened.push(handlers);
        return onUnsubscribe;
      },
    },
  } as unknown as SyncSession;
  return { session, opened };
}

let queue: FakeQueue;
let refreshed: number;
let refreshOrder: string[];

beforeEach(() => {
  vi.useFakeTimers();
  queue = new FakeQueue();
  refreshed = 0;
  refreshOrder = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const build = (app: { source: AppStateSource }, ctx = fakeContext()) => ({
  ctx,
  handles: new MobileSyncHandles(ctx, app.source, {
    queue,
    refresh: async () => {
      refreshed += 1;
      refreshOrder.push('refresh');
    },
  }),
});

describe('starting in the foreground', () => {
  it('arms the timers and catches up', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    expect(handles.running).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(queue.triggers).toEqual(['resume']);
  });

  it('checks the token BEFORE the round, not after', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    // The order is the whole point: an app out of a pocket holds a token that
    // very likely expired in it, and a round run first would spend a 401
    // learning that and log the person out.
    queue.runTracked = async (trigger) => {
      refreshOrder.push(`round:${trigger}`);
    };
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshOrder).toEqual(['refresh', 'round:resume']);
  });

  it('polls the outbox once a second, and only when it is due', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    queue.triggers.length = 0;

    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.triggers).toEqual([]);

    queue.due = 42;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.triggers).toEqual(['outbox']);
  });

  it('fires the clock trigger on the interval', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    queue.triggers.length = 0;

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(queue.triggers).toContain('scheduler');
  });
});

describe('starting in the background', () => {
  it('watches, but arms nothing', async () => {
    const app = fakeAppState(false);
    const { handles } = build(app);
    handles.start();
    expect(handles.running).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.triggers).toEqual([]);
    expect(refreshed).toBe(0);
  });
});

describe('going away (criterion 77)', () => {
  it('stops every timer', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    queue.due = 7;
    queue.triggers.length = 0;

    app.go(false);
    expect(handles.running).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(queue.triggers).toEqual([]);
  });

  it('lets go of the event stream', async () => {
    let closed = 0;
    const app = fakeAppState(true);
    const { ctx, handles } = build(app);
    const { session, opened } = fakeSession(() => {
      closed += 1;
    });
    ctx.sync.installSession(session);

    handles.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveLength(1);

    app.go(false);
    expect(closed).toBe(1);
  });

  it('does NOT touch the session (criterion 78)', async () => {
    const app = fakeAppState(true);
    const { ctx, handles } = build(app);
    const { session } = fakeSession(() => {});
    ctx.sync.installSession(session);
    const epoch = ctx.sync.epoch;

    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    app.go(false);

    // Backgrounding is not a lifecycle change. A badge that flipped to
    // "需要登录" every time somebody took a phone call would be a lie.
    expect(ctx.sync.session).toBe(session);
    expect(ctx.sync.epoch).toBe(epoch);
    expect(ctx.sync.state).not.toBe('auth_required');
  });

  it('leaves a round in flight alone rather than aborting it', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    queue.busy = true;

    app.go(false);
    // `abortAndDrain` belongs to login/logout/unbind. Killing work the OS had
    // not yet frozen would be this file inventing a failure.
    expect(queue.drained).toBe(0);
  });
});

describe('coming back', () => {
  it('catches up again, and rebuilds the stream', async () => {
    let closed = 0;
    const app = fakeAppState(true);
    const { ctx, handles } = build(app);
    const { session, opened } = fakeSession(() => {
      closed += 1;
    });
    ctx.sync.installSession(session);

    handles.start();
    await vi.advanceTimersByTimeAsync(1_000);
    app.go(false);
    expect(closed).toBe(1);
    queue.triggers.length = 0;

    app.go(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.triggers[0]).toBe('resume');
    expect(opened).toHaveLength(2);
  });

  it('ignores a repeat of the state it is already in', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);
    queue.triggers.length = 0;

    // Android delivers `active` again for reasons of its own; a second resume
    // would mean a second set of timers over one process.
    app.go(true);
    app.go(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.triggers).toEqual([]);
  });
});

describe('with no session', () => {
  it('asks for nothing at all', async () => {
    queue.session = false;
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.triggers).toEqual([]);
    // The token check still runs: it is what a restored-but-expired session
    // needs, and it is a no-op without one.
    expect(refreshed).toBeGreaterThan(0);
  });
});

describe('stopping for good', () => {
  it('unhooks the app state listener and stops the queue', async () => {
    const app = fakeAppState(true);
    const { handles } = build(app);
    handles.start();
    await vi.advanceTimersByTimeAsync(0);

    handles.stop();
    expect(queue.stopped).toBe(true);
    expect(handles.running).toBe(false);
    expect(app.listeners.size).toBe(0);

    queue.triggers.length = 0;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(queue.triggers).toEqual([]);
  });
});
