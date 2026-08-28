// ⑤ 判据 19 的修订 — the arithmetic of dragging and resizing the lyric window.
// The pixels are a device question; what is decidable here is where the window
// ends up given where the cursor went.

import { describe, expect, it } from 'vitest';
import {
  type Bounds,
  DesktopLyricsGestures,
  type GestureTarget,
} from './desktop-lyrics-gesture.js';

const START: Bounds = { x: 100, y: 200, width: 900, height: 120 };

/** `clamp` stands in for a platform that does not grant what it was asked. */
function harness(bounds: Bounds = START, clamp: (asked: Bounds) => Bounds = (asked) => asked) {
  let cursor = { x: 0, y: 0 };
  let current = { ...bounds };
  const target: GestureTarget = {
    getBounds: () => ({ ...current }),
    setBounds: (next) => {
      current = clamp({ ...next });
    },
  };
  const gestures = new DesktopLyricsGestures(() => cursor);
  return {
    gestures,
    target,
    bounds: () => current,
    moveCursorTo: (x: number, y: number) => {
      cursor = { x, y };
    },
  };
}

describe('a pointer gesture on the lyric window', () => {
  it('moves the window by however far the cursor came', () => {
    const h = harness();
    h.gestures.attach(h.target);
    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });
    h.moveCursorTo(530, 480);
    h.gestures.handle({ kind: 'move', phase: 'update' });

    expect(h.bounds()).toEqual({ x: 130, y: 180, width: 900, height: 120 });
  });

  // 🔴 `setBounds` IS A REQUEST, NOT AN ASSIGNMENT — macOS will not put a
  // window under the menu bar, and a display ends somewhere. Re-anchoring on
  // what came back would fold that refusal into every step after it, and the
  // window would trail the cursor by however far it was once refused. Anchored
  // on the press, it catches up the moment the cursor is back in reach.
  it('keeps up with the cursor after a position the platform refused', () => {
    const h = harness(START, (asked) => ({ ...asked, y: Math.max(0, asked.y) }));
    h.gestures.attach(h.target);
    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });

    h.moveCursorTo(500, 100);
    h.gestures.handle({ kind: 'move', phase: 'update' });
    expect(h.bounds().y).toBe(0);

    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'update' });
    expect(h.bounds().y).toBe(200);
  });

  it('resizes from the corner, and stops at the smallest window worth having', () => {
    const h = harness();
    h.gestures.attach(h.target);
    h.moveCursorTo(1000, 320);
    h.gestures.handle({ kind: 'resize', phase: 'begin' });
    h.moveCursorTo(1100, 400);
    h.gestures.handle({ kind: 'resize', phase: 'update' });
    expect(h.bounds()).toEqual({ x: 100, y: 200, width: 1000, height: 200 });

    // Dragging the corner up and to the left, far past both floors.
    h.moveCursorTo(0, 0);
    h.gestures.handle({ kind: 'resize', phase: 'update' });
    expect(h.bounds()).toEqual({ x: 100, y: 200, width: 200, height: 40 });
  });

  it('does nothing with an update that no press began', () => {
    const h = harness();
    h.gestures.attach(h.target);
    h.moveCursorTo(900, 900);
    h.gestures.handle({ kind: 'move', phase: 'update' });

    expect(h.bounds()).toEqual(START);
  });

  // The button came up. Anything after that is the cursor going about its day.
  it('lets go on end', () => {
    const h = harness();
    h.gestures.attach(h.target);
    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });
    h.gestures.handle({ kind: 'move', phase: 'end' });
    h.moveCursorTo(900, 900);
    h.gestures.handle({ kind: 'move', phase: 'update' });

    expect(h.bounds()).toEqual(START);
  });

  // The press decides what this is. An update that disagreed would turn a drag
  // into a resize with the pointer already captured — nobody could stop it.
  it('will not change kind half-way through', () => {
    const h = harness();
    h.gestures.attach(h.target);
    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });
    h.moveCursorTo(560, 560);
    h.gestures.handle({ kind: 'resize', phase: 'update' });

    expect(h.bounds()).toEqual({ x: 160, y: 260, width: 900, height: 120 });
  });

  it('does nothing at all with no window open', () => {
    const h = harness();
    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });
    h.gestures.attach(h.target);
    h.moveCursorTo(700, 500);
    h.gestures.handle({ kind: 'move', phase: 'update' });

    // Attaching a window does not adopt a gesture that began without one.
    expect(h.bounds()).toEqual(START);
  });

  // Same identity check `noteClosed` makes, for the same reason: a closed
  // window that is no longer the one we hold must not disarm the one we do.
  it('ignores a close from a window it is no longer holding', () => {
    const h = harness();
    const stale: GestureTarget = { getBounds: () => START, setBounds: () => {} };
    h.gestures.attach(stale);
    h.gestures.attach(h.target);
    h.gestures.detach(stale);

    h.moveCursorTo(500, 500);
    h.gestures.handle({ kind: 'move', phase: 'begin' });
    h.moveCursorTo(550, 500);
    h.gestures.handle({ kind: 'move', phase: 'update' });
    expect(h.bounds().x).toBe(150);
  });
});
