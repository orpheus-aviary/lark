// The quit sequence (M5-3). What matters is the ORDER — the window size is
// written while the daemon is still up — and that both attachment modes reach
// the end exactly once.

import { describe, expect, it, vi } from 'vitest';
import { QuitCoordinator } from './quit.js';

interface Recorded {
  steps: string[];
  quits: number;
}

function build(overrides: Partial<Record<'flush' | 'settle' | 'stop', () => Promise<void>>> = {}): {
  coordinator: QuitCoordinator;
  recorded: Recorded;
} {
  const recorded: Recorded = { steps: [], quits: 0 };
  const step = (name: string, impl?: () => Promise<void>) => async () => {
    recorded.steps.push(name);
    if (impl) await impl();
  };
  const coordinator = new QuitCoordinator({
    flushWindowSize: step('flush', overrides.flush),
    settleDaemonStart: step('settle', overrides.settle),
    stopOwnedDaemon: step('stop', overrides.stop),
    quit: () => {
      recorded.quits += 1;
    },
  });
  return { coordinator, recorded };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('QuitCoordinator', () => {
  it('runs the steps in order, then quits — and the second quit goes through', async () => {
    const { coordinator, recorded } = build();

    expect(coordinator.handleBeforeQuit()).toBe(true); // prevented
    await settled();

    expect(recorded.steps).toEqual(['flush', 'settle', 'stop']);
    expect(recorded.quits).toBe(1);
    expect(coordinator.finished).toBe(true);
    expect(coordinator.handleBeforeQuit()).toBe(false); // let it exit
  });

  it('runs once however many quits arrive while it is working', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator, recorded } = build({ flush: () => held });

    expect(coordinator.handleBeforeQuit()).toBe(true);
    expect(coordinator.handleBeforeQuit()).toBe(true); // still prevented
    expect(coordinator.handleBeforeQuit()).toBe(true);
    release();
    await settled();

    expect(recorded.steps).toEqual(['flush', 'settle', 'stop']);
    expect(recorded.quits).toBe(1);
  });

  it('a failing step never blocks the exit', async () => {
    const log = vi.fn();
    const recorded: string[] = [];
    let quits = 0;
    const coordinator = new QuitCoordinator({
      flushWindowSize: () => Promise.reject(new Error('daemon already gone')),
      settleDaemonStart: async () => {
        recorded.push('settle');
      },
      stopOwnedDaemon: async () => {
        recorded.push('stop');
      },
      quit: () => {
        quits += 1;
      },
      log,
    });

    coordinator.handleBeforeQuit();
    await settled();

    expect(recorded).toEqual(['settle', 'stop']); // the rest still ran
    expect(quits).toBe(1);
    expect(log).toHaveBeenCalledOnce();
  });

  // The reused case is what M4 skipped entirely: `stopOwnedDaemon` is a no-op
  // there, but the window size still has to be written before exiting.
  it('flushes the window size even when no daemon is owned', async () => {
    const { coordinator, recorded } = build();
    coordinator.handleBeforeQuit();
    await settled();
    expect(recorded.steps[0]).toBe('flush');
  });
});
