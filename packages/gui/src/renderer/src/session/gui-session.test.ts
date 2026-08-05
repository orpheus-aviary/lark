// GuiSession protocol tests (M4-9 + M4-8 two epochs + T2 StrictMode safety).
// The fake subscribe records every live subscription; the fakes never touch
// the network.

import type { SseDisconnect, SubscribeSseOptions } from '@lark/shared';
import { SseHttpError } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import { GuiSession, type GuiSessionDeps } from './gui-session.js';

interface FakeSubscription {
  options: SubscribeSseOptions;
  emit(event: string, data: string): void;
  disconnect(info: Partial<SseDisconnect>): 'stop' | undefined;
  aborted(): boolean;
}

function harness(overrides: Partial<GuiSessionDeps> = {}) {
  const subscriptions: FakeSubscription[] = [];
  let registerCount = 0;

  const deps: GuiSessionDeps = {
    registerGui: vi.fn(async () => {
      registerCount++;
      return `gui-${registerCount}`;
    }),
    subscribe: (options: SubscribeSseOptions) => {
      subscriptions.push({
        options,
        emit: (event, data) => options.onEvent(event, data),
        disconnect: (info) => {
          const outcome = options.onDisconnect?.({
            error: null,
            clean: true,
            usedToken: 'tok',
            ...info,
          });
          return outcome === 'stop' ? 'stop' : undefined;
        },
        aborted: () => options.signal.aborted,
      });
    },
    probeStatusPid: vi.fn(async () => 111),
    readToken: vi.fn(() => 'token-a'),
    onHello: vi.fn(),
    onGenerationChange: vi.fn(),
    onEvent: vi.fn(),
    onOnline: vi.fn(),
    onOffline: vi.fn(),
    warn: vi.fn(),
    registerRetryMs: 1,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    ...overrides,
  };
  const session = new GuiSession(deps);
  return {
    session,
    deps,
    subscriptions,
    /** Live (non-aborted) subscriptions. */
    live: () => subscriptions.filter((s) => !s.aborted()),
    flush: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };
}

const hello = JSON.stringify({ type: 'hello', server_time: 1 });

describe('registration and subscription', () => {
  it('registers, then subscribes with the returned gui_id', async () => {
    const h = harness();
    h.session.start();
    await h.flush();
    expect(h.subscriptions).toHaveLength(1);
    expect(h.subscriptions[0]?.options.path).toBe('/events?role=gui&gui_id=gui-1');
  });

  it('retries a failed register until it succeeds', async () => {
    let failures = 2;
    const h = harness({
      registerGui: vi.fn(async () => {
        if (failures > 0) {
          failures--;
          throw new Error('daemon down');
        }
        return 'gui-ok';
      }),
    });
    h.session.start();
    await h.flush();
    await h.flush();
    expect(h.subscriptions).toHaveLength(1);
    expect(h.subscriptions[0]?.options.path).toContain('gui-ok');
    expect(h.deps.onOffline).toHaveBeenCalled();
  });

  it('StrictMode: dispose() before register resolves → the ghost never subscribes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      registerGui: vi.fn(async () => {
        await gate;
        return 'gui-ghost';
      }),
    });
    h.session.start();
    h.session.dispose(); // cleanup fires while register is in flight
    release?.();
    await h.flush();
    expect(h.subscriptions).toHaveLength(0);
  });

  it('StrictMode: mount→cleanup→remount ends with exactly one live subscription', async () => {
    const h = harness();
    h.session.start(); // first mount
    await h.flush();
    h.session.dispose(); // cleanup
    const second = new GuiSession(h.deps);
    second.start(); // remount
    await h.flush();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]?.options.path).toBe('/events?role=gui&gui_id=gui-2');
    second.dispose();
  });
});

describe('409 recovery', () => {
  it('stops the dead id, re-registers, resubscribes with a fresh controller', async () => {
    const h = harness();
    h.session.start();
    await h.flush();

    const outcome = h.subscriptions[0]?.disconnect({
      error: new SseHttpError(409, 'Conflict', '{"error_code":"GUI_REGISTRATION_REQUIRED"}'),
      clean: false,
    });
    expect(outcome).toBe('stop'); // never retry the dead gui_id
    await h.flush();

    expect(h.subscriptions).toHaveLength(2);
    expect(h.subscriptions[1]?.options.path).toBe('/events?role=gui&gui_id=gui-2');
    expect(h.subscriptions[0]?.aborted()).toBe(true);
    expect(h.live()).toHaveLength(1);
  });

  it('a plain network disconnect lets the subscribe loop retry the SAME id', async () => {
    const h = harness();
    h.session.start();
    await h.flush();

    const outcome = h.subscriptions[0]?.disconnect({
      error: new TypeError('fetch failed'),
      clean: false,
    });
    expect(outcome).toBeUndefined(); // subscribeSse backoff owns the retry
    expect(h.deps.onOffline).toHaveBeenCalledTimes(1);
    expect(h.deps.registerGui).toHaveBeenCalledTimes(1); // no re-register
  });
});

describe('two epochs (M4-8)', () => {
  it('hello → onOnline + onHello every time', async () => {
    const h = harness();
    h.session.start();
    await h.flush();
    h.subscriptions[0]?.emit('hello', hello);
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    expect(h.deps.onHello).toHaveBeenCalledTimes(2);
    expect(h.deps.onOnline).toHaveBeenCalledTimes(2);
  });

  it('same token + same pid across reconnects → NO generation change', async () => {
    const h = harness();
    h.session.start();
    await h.flush();
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    expect(h.deps.onGenerationChange).not.toHaveBeenCalled();
  });

  it('token content change across a reconnect → generation change', async () => {
    let token = 'token-a';
    const h = harness({ readToken: () => token });
    h.session.start();
    await h.flush();
    h.subscriptions[0]?.emit('hello', hello); // seeds the baseline
    await h.flush();
    token = 'token-b'; // daemon restarted, rotated token
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    expect(h.deps.onGenerationChange).toHaveBeenCalledTimes(1);
  });

  it('/status pid change across a reconnect → generation change', async () => {
    let pid = 111;
    const h = harness({ probeStatusPid: async () => pid });
    h.session.start();
    await h.flush();
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    pid = 222;
    h.subscriptions[0]?.emit('hello', hello);
    await h.flush();
    expect(h.deps.onGenerationChange).toHaveBeenCalledTimes(1);
  });
});

describe('event dispatch', () => {
  it('forwards business events and drops malformed frames', async () => {
    const h = harness();
    h.session.start();
    await h.flush();
    h.subscriptions[0]?.emit('songs:changed', '{"type":"songs:changed"}');
    h.subscriptions[0]?.emit('garbage', 'not-json{');
    expect(h.deps.onEvent).toHaveBeenCalledTimes(1);
    expect(h.deps.onEvent).toHaveBeenCalledWith({ type: 'songs:changed' });
    expect(h.deps.warn).toHaveBeenCalled();
  });

  it('after dispose, frames and disconnects are inert', async () => {
    const h = harness();
    h.session.start();
    await h.flush();
    h.session.dispose();
    h.subscriptions[0]?.emit('songs:changed', '{"type":"songs:changed"}');
    expect(h.deps.onEvent).not.toHaveBeenCalled();
    const outcome = h.subscriptions[0]?.disconnect({ error: null, clean: true });
    expect(outcome).toBe('stop');
    expect(h.deps.registerGui).toHaveBeenCalledTimes(1);
  });
});
