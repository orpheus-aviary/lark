// The window reference (0.3.0). The bug it exists for: a destroyed window is
// still an object, and `mainWindow !== null` was true for it — so the next
// dock click called `show()` on a corpse and killed the app with an uncaught
// `Object has been destroyed`, behind an error dialog nothing could dismiss.

import { describe, expect, it, vi } from 'vitest';
import { WindowRef } from './window-ref.js';

function fakeWindow(): {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  destroy(): void;
  close(): void;
} {
  let destroyed = false;
  let onClosed: (() => void) | null = null;
  return {
    isDestroyed: () => destroyed,
    once(_event, listener) {
      onClosed = listener;
      return this;
    },
    /** The native side goes away without the event — a killed renderer. */
    destroy() {
      destroyed = true;
    },
    /** The tidy path: destroyed AND announced. */
    close() {
      destroyed = true;
      onClosed?.();
    },
  };
}

describe('WindowRef', () => {
  it('hands back the window it was given', () => {
    const ref = new WindowRef();
    const win = fakeWindow();
    ref.adopt(win);

    expect(ref.live()).toBe(win);
  });

  it('is empty before anything is adopted', () => {
    expect(new WindowRef().live()).toBeNull();
  });

  it('refuses a destroyed window even when no event announced it', () => {
    const ref = new WindowRef();
    const win = fakeWindow();
    ref.adopt(win);

    win.destroy();

    // The whole point: `!== null` would have said yes here.
    expect(ref.live()).toBeNull();
  });

  it('clears itself and tells the owner when the window closes', () => {
    const ref = new WindowRef();
    const onClosed = vi.fn();
    const win = fakeWindow();
    ref.adopt(win, onClosed);

    win.close();

    expect(ref.live()).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('does not let an old window clear the new one', () => {
    const ref = new WindowRef();
    const first = fakeWindow();
    const second = fakeWindow();
    ref.adopt(first);
    ref.adopt(second);

    // `activate` replaced the window; the old one's `closed` arrives after.
    first.close();

    expect(ref.live()).toBe(second);
  });
});
