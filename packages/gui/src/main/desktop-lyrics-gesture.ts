// Moving and resizing the floating lyric window with the pointer (0.5.0 ⑤).
//
// 🔴 THIS EXISTS BECAUSE A DRAG REGION CANNOT BE HOVERED. `-webkit-app-region:
// drag` over the whole window swallows every mouse event inside it (Electron's
// own docs say so), so the window could never notice the pointer arriving —
// and the control bar only exists while the pointer is on it. `no-drag` punches
// holes in elements that are ALREADY DRAWN, which the bar is not: it is drawn
// because of the hover the drag region ate. The pointer drives the window
// instead, and the window's own rectangle stops being a title bar (which is
// also where the stray right-click menu came from).
//
// Electron-free like its neighbours: the caller hands in a cursor reader and
// the window to act on, tests hand in fakes.

import { DESKTOP_LYRICS_BOUNDS } from '@lark/shared';
import type { DesktopLyricsGesture, DesktopLyricsGestureKind } from '../shared/desktop-lyrics.js';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The slice of a BrowserWindow a gesture needs. */
export interface GestureTarget {
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
}

interface Anchor {
  kind: DesktopLyricsGestureKind;
  cursor: Point;
  bounds: Bounds;
}

/**
 * One gesture at a time, against whichever lyric window is open.
 *
 * 🔴 ANCHORED, NOT INCREMENTAL. Every update is measured from where the cursor
 * AND the window were when the gesture began, so the window moving out from
 * under the pointer cannot feed back into the next step — the failure mode of
 * per-event deltas is a window that accelerates away or lags behind by a few
 * pixels per event, and neither is recoverable once it starts.
 */
export class DesktopLyricsGestures {
  readonly #cursor: () => Point;
  #target: GestureTarget | null = null;
  #anchor: Anchor | null = null;

  constructor(cursor: () => Point) {
    this.#cursor = cursor;
  }

  /** A window opened. Any gesture in flight belonged to the old one. */
  attach(target: GestureTarget): void {
    this.#target = target;
    this.#anchor = null;
  }

  /**
   * A window closed. Identity-checked for the same reason `noteClosed` is: the
   * caller lets go of a window before destroying it, and a `closed` event for
   * one we are no longer holding must not disarm the one we are.
   */
  detach(target: GestureTarget): void {
    if (this.#target !== target) return;
    this.#target = null;
    this.#anchor = null;
  }

  handle(gesture: DesktopLyricsGesture): void {
    if (gesture.phase === 'begin') {
      const target = this.#target;
      // No window means no anchor, and no anchor means the updates that follow
      // do nothing — rather than a gesture that starts measuring from a
      // rectangle nobody can see.
      this.#anchor =
        target === null
          ? null
          : { kind: gesture.kind, cursor: this.#cursor(), bounds: target.getBounds() };
      return;
    }
    if (gesture.phase === 'end') {
      this.#anchor = null;
      return;
    }
    const anchor = this.#anchor;
    const target = this.#target;
    if (anchor === null || target === null) return;
    const cursor = this.#cursor();
    const dx = cursor.x - anchor.cursor.x;
    const dy = cursor.y - anchor.cursor.y;
    // THE ANCHOR DECIDES THE KIND, not the message: an update that disagrees
    // with the press that started it would turn a drag into a resize halfway
    // through, and the pointer is captured by then — nobody could stop it.
    target.setBounds(nextBounds(anchor, dx, dy));
  }
}

/** Where the window goes, given how far the cursor has come since the press. */
function nextBounds(anchor: Anchor, dx: number, dy: number): Bounds {
  const { bounds } = anchor;
  if (anchor.kind === 'move') {
    return { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
  }
  // The same floor the config sanitiser holds, applied where a person can
  // actually reach it: dragging past it stops rather than producing a window
  // too small to show a line — or to grab again.
  return {
    ...bounds,
    width: Math.max(DESKTOP_LYRICS_BOUNDS.width.min, bounds.width + dx),
    height: Math.max(DESKTOP_LYRICS_BOUNDS.height.min, bounds.height + dy),
  };
}
