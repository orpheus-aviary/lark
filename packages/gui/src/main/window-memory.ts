// "Remember the window size" (M5-3). Electron-free by design: `index.ts`
// hands in the BrowserWindow and a real fetch, tests hand in fakes.
//
// The size is written through the daemon's `PATCH /config`, never straight to
// the TOML. The daemon is the file's only writer — a direct save here would
// leave its in-memory config disagreeing with the disk, and the next PATCH
// from the settings page would write the stale window size back.
//
// Two rules the naive version gets wrong:
//
//   Only NORMAL bounds count. Maximising or going full screen changes the
//   size to the screen's, and remembering that means "restore" comes back
//   full screen next launch. Those states are skipped, and the last normal
//   size is what a flush writes.
//
//   The flush at quit is not the debounce firing. Quitting cancels the timer
//   and writes once, with a short timeout: a daemon that is already stopping
//   must not hold up the exit.

export interface WindowSize {
  width: number;
  height: number;
}

/** The slice of BrowserWindow this needs. */
export interface WindowLike {
  getNormalBounds(): { width: number; height: number };
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  on(event: 'resize' | 'move', listener: () => void): void;
}

export interface WindowMemoryDeps {
  /** Persist a size. Rejections are logged and swallowed by the caller. */
  save: (size: WindowSize, timeoutMs: number) => Promise<void>;
  debounceMs?: number;
  /** Budget for the write at quit — the daemon may be going down with us. */
  flushTimeoutMs?: number;
  log?: (msg: string) => void;
}

const DEBOUNCE_MS = 1000;
const FLUSH_TIMEOUT_MS = 1000;

export class WindowMemory {
  readonly #window: WindowLike;
  readonly #deps: Required<WindowMemoryDeps>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The most recent size worth remembering, or null if nothing changed. */
  #pending: WindowSize | null = null;
  #lastNormal: WindowSize | null = null;

  constructor(window: WindowLike, deps: WindowMemoryDeps) {
    this.#window = window;
    this.#deps = {
      debounceMs: DEBOUNCE_MS,
      flushTimeoutMs: FLUSH_TIMEOUT_MS,
      log: () => {},
      ...deps,
    };
    const onChange = (): void => this.#record();
    window.on('resize', onChange);
    window.on('move', onChange);
  }

  /** The size a flush would write — for assertions. */
  get lastNormalSize(): WindowSize | null {
    return this.#lastNormal;
  }

  #record(): void {
    if (this.#window.isDestroyed()) return;
    // A maximised / full-screen window is not a size the user chose.
    if (this.#window.isMaximized() || this.#window.isFullScreen()) return;
    const { width, height } = this.#window.getNormalBounds();
    this.#lastNormal = { width, height };
    this.#pending = { width, height };
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#write(this.#deps.debounceMs);
    }, this.#deps.debounceMs);
  }

  async #write(timeoutMs: number): Promise<void> {
    const size = this.#pending;
    if (size === null) return;
    this.#pending = null;
    try {
      await this.#deps.save(size, timeoutMs);
    } catch (err) {
      // A failed write costs the user a remembered size, nothing more.
      this.#deps.log(`[window] could not save the window size: ${String(err)}`);
    }
  }

  /**
   * Cancel the pending debounce and write the final size now. Safe to call
   * more than once; a second call with nothing pending resolves immediately.
   */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#write(this.#deps.flushTimeoutMs);
  }
}
