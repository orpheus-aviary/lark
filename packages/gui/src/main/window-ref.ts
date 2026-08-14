// Who holds the main window, and how "there is no window" is asked.
//
// `null` is not the only shape of that answer. A BrowserWindow whose native
// side is gone stays a perfectly ordinary JS object, and every call on it
// throws `Object has been destroyed` — so a reference that is only ever
// cleared by an event is wrong twice over: the event may not have fired yet,
// and nothing clears it at all if the window is destroyed rather than closed.
//
// That is not theoretical. macOS keeps the app alive with no window, so the
// next dock click reaches `activate`, calls `show()` on the corpse, and takes
// the whole process down with an uncaught exception — behind an error dialog
// that cannot be dismissed, because the thing that would dismiss it is the
// process that just died.
//
// So: ask, never remember. `live()` checks at the moment of use, and `adopt()`
// also clears the reference on `closed` so a window that goes away tidily does
// not keep its memory (and its size-flush timer) alive.

export interface DestroyableWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
}

export class WindowRef<T extends DestroyableWindow> {
  #window: T | null = null;

  /** Take ownership. `onClosed` runs when this exact window goes away. */
  adopt(window: T, onClosed?: () => void): void {
    this.#window = window;
    window.once('closed', () => {
      // Guarded: a LATER window may already own the reference by now, and
      // clearing it would lose the live one.
      if (this.#window === window) this.#window = null;
      onClosed?.();
    });
  }

  /** The window, if there is still one to talk to. */
  live(): T | null {
    if (this.#window === null || this.#window.isDestroyed()) return null;
    return this.#window;
  }
}
