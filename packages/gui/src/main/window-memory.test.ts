// Remembering the window size (M5-3): what gets written, when, and — the part
// that is easy to get wrong — what must NOT be written.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WindowLike, WindowMemory, type WindowSize } from './window-memory.js';

class FakeWindow implements WindowLike {
  bounds: WindowSize = { width: 1024, height: 768 };
  maximized = false;
  fullScreen = false;
  destroyed = false;
  readonly #listeners: (() => void)[] = [];

  getNormalBounds(): WindowSize {
    return this.bounds;
  }
  isMaximized(): boolean {
    return this.maximized;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(_event: 'resize' | 'move', listener: () => void): void {
    this.#listeners.push(listener);
  }
  /** Pretend the user dragged the frame. */
  resizeTo(size: WindowSize): void {
    this.bounds = size;
    for (const listener of this.#listeners) listener();
  }
}

let win: FakeWindow;
let saved: WindowSize[];
let memory: WindowMemory;

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  saved = [];
  memory = new WindowMemory(win, {
    save: async (size) => {
      saved.push(size);
    },
    debounceMs: 1000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WindowMemory', () => {
  it('writes once after a burst of resizes settles', async () => {
    win.resizeTo({ width: 1100, height: 800 });
    win.resizeTo({ width: 1200, height: 850 });
    win.resizeTo({ width: 1300, height: 900 });
    expect(saved).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);

    expect(saved).toEqual([{ width: 1300, height: 900 }]);
  });

  it('ignores a maximised or full-screen window and keeps the last normal size', async () => {
    win.resizeTo({ width: 1100, height: 800 });
    await vi.advanceTimersByTimeAsync(1000);
    saved.length = 0;

    win.maximized = true;
    win.resizeTo({ width: 3840, height: 2160 });
    win.maximized = false;
    win.fullScreen = true;
    win.resizeTo({ width: 3840, height: 2160 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(saved).toEqual([]); // nothing to write: no normal-state change
    expect(memory.lastNormalSize).toEqual({ width: 1100, height: 800 });
  });

  it('flushes the final size at quit without waiting for the debounce', async () => {
    win.resizeTo({ width: 1400, height: 950 });

    await memory.flush();

    expect(saved).toEqual([{ width: 1400, height: 950 }]);
    // The cancelled timer must not fire a second write afterwards.
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved).toHaveLength(1);
  });

  it('flushing with nothing pending writes nothing', async () => {
    await memory.flush();
    expect(saved).toEqual([]);
  });

  it('swallows a failed save — a lost size must not stop the app quitting', async () => {
    const log = vi.fn();
    const failing = new WindowMemory(win, {
      save: () => Promise.reject(new Error('daemon is stopping')),
      log,
    });
    win.resizeTo({ width: 1500, height: 1000 });

    await expect(failing.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});
