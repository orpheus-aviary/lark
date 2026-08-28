// Whether the floating lyric window exists, and what it is being told (⑤).
//
// Electron-free by design, like `window-memory.ts` beside it: `index.ts` hands
// in a factory that builds a real `BrowserWindow`, tests hand in a fake. What
// is decidable here is the whole of the lifecycle — a config that says `true`
// twice must not open two windows, one that says `false` must take the window
// away, and a window that goes away on its own is the user turning the
// feature off.
//
// 🔴 THE MAIN WINDOW'S "RED X = HIDE" DOES NOT APPLY HERE. That rule exists
// because the main renderer owns playback and the SSE command channel, so a
// closed one would be a silent app. This window owns nothing: closing it is
// the whole of what turning the feature off means, and it writes `enabled =
// false` back so the next launch agrees with what the person just did.

import type { DesktopLyricsConfig } from '@lark/shared';
import { type DesktopLyricsMessage, desktopLyricsInteraction } from '../shared/desktop-lyrics.js';

/** The slice of a BrowserWindow this needs. */
export interface DesktopLyricsWindow {
  isDestroyed(): boolean;
  destroy(): void;
  /** Hand the window its next frame. A destroyed window swallows it. */
  publish(state: DesktopLyricsMessage): void;
  /**
   * Click-through, whole window (`setIgnoreMouseEvents`).
   *
   * 🔴 The half a stylesheet cannot do. A locked window that only stopped
   * SHOWING its controls would still swallow every click over whatever is
   * behind it — which is the exact complaint locking exists to answer.
   */
  setIgnoreMouseEvents(ignore: boolean): void;
}

export interface DesktopLyricsDeps {
  create: (config: DesktopLyricsConfig) => DesktopLyricsWindow;
  /**
   * The window is gone and we did not ask — the person closed it. The caller
   * writes `enabled = false` back through the daemon.
   */
  onClosedByUser: () => void;
}

export class DesktopLyricsController {
  readonly #deps: DesktopLyricsDeps;
  #window: DesktopLyricsWindow | null = null;
  /**
   * The last thing published, replayed into a window that opens mid-song.
   *
   * Without it, turning the lyrics on during a song would show an empty strip
   * until the line changed — which reads as "it did not work" for as long as
   * the current line lasts.
   */
  #last: DesktopLyricsMessage | null = null;

  constructor(deps: DesktopLyricsDeps) {
    this.#deps = deps;
  }

  /** Bring the window into line with the config. Idempotent, on purpose. */
  apply(config: DesktopLyricsConfig): void {
    if (!config.enabled) {
      this.close();
      return;
    }
    const existing = this.#alive();
    if (existing !== null) {
      // Everything else about the window is redrawn from the message; this one
      // is a property of the window itself, so it is applied on every pass
      // rather than only when it is built.
      existing.setIgnoreMouseEvents(desktopLyricsInteraction(config.locked).clickThrough);
      return;
    }
    const window = this.#deps.create(config);
    this.#window = window;
    window.setIgnoreMouseEvents(desktopLyricsInteraction(config.locked).clickThrough);
    if (this.#last !== null) window.publish(this.#last);
  }

  publish(state: DesktopLyricsMessage): void {
    this.#last = state;
    this.#alive()?.publish(state);
  }

  /** Our doing: `enabled` went false, or the app is quitting. */
  close(): void {
    const window = this.#alive();
    this.#window = null;
    window?.destroy();
  }

  /**
   * The window reports itself gone.
   *
   * Identity-checked rather than flag-guarded: `close()` lets go of the window
   * BEFORE destroying it, so a `closed` event we caused finds a controller
   * that is no longer holding it and says nothing. Order-independent, which a
   * boolean around a `destroy()` call is not.
   */
  noteClosed(window: DesktopLyricsWindow): void {
    if (this.#window !== window) return;
    this.#window = null;
    this.#deps.onClosedByUser();
  }

  #alive(): DesktopLyricsWindow | null {
    if (this.#window === null) return null;
    if (this.#window.isDestroyed()) {
      this.#window = null;
      return null;
    }
    return this.#window;
  }
}
