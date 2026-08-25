// The two ways an event stream lies about being alive (N5d-2).
//
// Both were live holes in lark until owl's `sse-bridge.ts` was read: a stream
// that reconnects and never mentions what it missed, and a stream that stops
// delivering without ever firing a callback. Neither is reproducible on
// demand — the first needs a disconnect at the right second, the second needs
// a middlebox to eat a connection without closing it — which is exactly why
// they are settled here instead of on a device.
//
// One suite for both hosts. The daemon and the phone hold this controller;
// what differs is only WHEN each of them calls `ensure()` and `drop()`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorContext } from './context.js';
import { SyncRuntime } from './runtime.js';
import type { SyncSession } from './session.js';
import { SSE_COOLDOWN_MS, SSE_IDLE_MS, SyncStreamController } from './stream.js';

interface Handlers {
  onOpen?: () => void;
  onFrame?: (frame: unknown) => void;
  onChange: (latestSeq: number) => void;
  onError?: (err: Error) => void;
}

let opened: Handlers[];
let closed: number;
let subscribeThrows: Error | null;
let rounds: string[];
let warnings: string[];
let now: number;

function fakeContext(): CoordinatorContext {
  return {
    sync: new SyncRuntime(),
    now: () => now,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (_fields: Record<string, unknown>, msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    },
  } as unknown as CoordinatorContext;
}

function installSession(ctx: CoordinatorContext): void {
  ctx.sync.installSession({
    workspaceId: 'w',
    client: {
      subscribeEvents: (_workspace: string, handlers: Handlers) => {
        if (subscribeThrows !== null) throw subscribeThrows;
        opened.push(handlers);
        return () => {
          closed += 1;
        };
      },
    },
  } as unknown as SyncSession);
}

const queue = {
  runTracked: async (trigger: string) => {
    rounds.push(trigger);
  },
};

function build(options: { idleMs?: number } = {}) {
  const ctx = fakeContext();
  const controller = new SyncStreamController(ctx, queue, options);
  return { ctx, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  closed = 0;
  subscribeThrows = null;
  rounds = [];
  warnings = [];
  now = 1_700_000_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance both the injected clock and the timer wheel together. */
function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

describe('subscribing', () => {
  it('does nothing without a session, and lets go of one it held', () => {
    const { ctx, controller } = build();
    controller.ensure();
    expect(opened).toHaveLength(0);

    installSession(ctx);
    controller.ensure();
    expect(controller.open).toBe(true);
    expect(opened).toHaveLength(1);

    ctx.sync.dropSession('token_rejected');
    controller.ensure();
    expect(controller.open).toBe(false);
    expect(closed).toBe(1);
  });

  it('is idempotent while the session stands', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    controller.ensure();
    controller.ensure();
    expect(opened).toHaveLength(1);
  });

  it('resubscribes when the session is replaced under it', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    installSession(ctx); // a second login: new epoch
    controller.ensure();
    expect(opened).toHaveLength(2);
    expect(closed).toBe(1);
  });
});

describe('① the stream does not replay', () => {
  it('runs a catch-up round when it opens', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    expect(rounds).toEqual([]);

    // The server sends nothing from before a subscription, so this pull IS the
    // replay. Without it the gap stays open until the clock trigger — five
    // minutes on a desktop, fifteen on a phone.
    opened[0]?.onOpen?.();
    expect(rounds).toEqual(['remote']);
  });

  it('still runs a round on an ordinary change', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    opened[0]?.onChange(7);
    expect(rounds).toEqual(['remote']);
  });

  it('ignores callbacks belonging to a session that is gone', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    const stream = opened[0];

    ctx.sync.dropSession('token_rejected');
    stream?.onOpen?.();
    stream?.onChange(7);
    expect(rounds).toEqual([]);
  });
});

describe('② the stream can go silent without saying so', () => {
  it('presumes a silent stream dead and lets go of it', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    expect(controller.open).toBe(true);

    advance(SSE_IDLE_MS + 1);
    // No FIN, no RST, no callback — the watchdog is the only thing that can
    // notice, and a zombie left open collects nothing forever.
    expect(controller.open).toBe(false);
    expect(closed).toBe(1);
    expect(warnings.some((line) => line.includes('silent'))).toBe(true);
  });

  it('treats ANY frame as proof of life', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();

    // The server pings every 25s; two of them carry the stream past a minute.
    for (let i = 0; i < 4; i += 1) {
      advance(25_000);
      opened[0]?.onFrame?.({ event: 'ping', data: '{}' });
    }
    expect(controller.open).toBe(true);
    expect(closed).toBe(0);
  });

  it('starts the clock at subscribe, not only at onOpen', () => {
    // A server that never writes `:ok` would otherwise leave the watchdog
    // unarmed and the zombie undetectable.
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    expect(opened[0]?.onOpen).toBeTypeOf('function');

    advance(SSE_IDLE_MS + 1);
    expect(controller.open).toBe(false);
  });

  it('stops watching once it has let go', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    controller.drop();
    warnings.length = 0;

    advance(SSE_IDLE_MS * 3);
    expect(warnings).toEqual([]);
  });
});

describe('cooling down after a failure', () => {
  it('waits before subscribing again, then does', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();
    opened[0]?.onError?.(new Error('stream died'));
    expect(controller.open).toBe(false);
    expect(closed).toBe(1);

    advance(SSE_COOLDOWN_MS - 1);
    controller.ensure();
    expect(opened).toHaveLength(1);

    advance(2);
    controller.ensure();
    expect(opened).toHaveLength(2);
  });

  it('cools down the same way after silence as after an error', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();

    advance(SSE_IDLE_MS + 1);
    controller.ensure();
    // A silent stream and a broken one are the same problem in different
    // clothes; keeping one recovery path is what stops the watchdog from
    // growing a policy of its own.
    expect(opened).toHaveLength(1);

    advance(SSE_COOLDOWN_MS);
    controller.ensure();
    expect(opened).toHaveLength(2);
  });

  it('cools down when subscribing itself throws', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    subscribeThrows = new Error('no route to host');
    controller.ensure();
    expect(controller.open).toBe(false);

    subscribeThrows = null;
    controller.ensure();
    expect(opened).toHaveLength(0);

    advance(SSE_COOLDOWN_MS);
    controller.ensure();
    expect(opened).toHaveLength(1);
  });
});

describe('stopping', () => {
  it('lets go and never subscribes again', () => {
    const { ctx, controller } = build();
    installSession(ctx);
    controller.ensure();

    controller.stop();
    expect(controller.open).toBe(false);
    expect(closed).toBe(1);

    controller.ensure();
    expect(opened).toHaveLength(1);
  });
});

describe('with the watchdog disabled', () => {
  it('never presumes anything', () => {
    const { ctx, controller } = build({ idleMs: 0 });
    installSession(ctx);
    controller.ensure();

    advance(SSE_IDLE_MS * 10);
    expect(controller.open).toBe(true);
  });
});
