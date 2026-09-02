// What the hardware back key means, one screen at a time (0.1.1 ④).
//
// Until 0.1.1 this app answered the back key exactly once: RN's `Modal` does
// it for free, so the player, the queue, every sheet and every picker already
// closed. What had nobody was the ONE screen that is not a modal — a playlist
// opened inside its tab — so backing out of a playlist left the app.
//
// 🔴 PRIORITY IS EXPLICIT, NOT REGISTRATION ORDER, and that is the whole
// reason this file exists rather than a `BackHandler` line in each screen.
// React runs effects CHILD FIRST, so a plain LIFO stack asks the PARENT
// first — a playlist detail would close before the selection inside it, which
// is backwards, and it would be backwards for a reason nothing on screen can
// show. A number says what is meant.
//
// A handler answers `true` for "I consumed it". Everybody answering `false`
// means the system gets it, which on the root screen is what leaving the app
// is — deliberately NOT `BackHandler.exitApp()` (`docs/INVARIANTS.md` §6: it
// finishes the Activity and leaves the JS runtime alive, so the next launch
// would skip `bootOnce`).
//
// No React Native import here on purpose: the ordering is the part that can
// be wrong, and it is only testable where `react-native` does not load
// (`apps/mobile/vitest.config.ts`). The `BackHandler` subscription is one
// line in the assembly root.

import { useEffect, useRef } from 'react';

/** `true` = consumed, `false` = not mine, ask the next one. */
export type BackAction = () => boolean;

/**
 * The three layers this app has, from the innermost out.
 *
 * Numbers rather than an enum order so a fourth layer can land between two
 * of them without renumbering anything that already works.
 */
export const BACK = {
  /**
   * A sheet drawn over the app (`ui/overlay.tsx`). The innermost thing there
   * is: it was a `Modal` until 2026-09-02, and a Modal answered the back key
   * by itself — leaving it does not, so this layer is what replaces that.
   */
  sheet: 40,
  /** A selection inside a list — leaving it is the first thing back means. */
  selection: 30,
  /** A screen pushed inside a tab. Today: the playlist detail. */
  screen: 20,
  /** Which tab is showing. */
  tab: 10,
} as const;

interface Entry {
  action: BackAction;
  priority: number;
  /** Registration order, for ties: the newest of equal claims wins. */
  seq: number;
}

const entries: Entry[] = [];
let nextSeq = 0;

/** Register while a layer is on screen. The returned function removes it. */
export function registerBack(action: BackAction, priority: number): () => void {
  const entry: Entry = { action, priority, seq: nextSeq++ };
  entries.push(entry);
  return () => {
    const at = entries.indexOf(entry);
    if (at >= 0) entries.splice(at, 1);
  };
}

/**
 * Ask everyone, innermost first, until somebody consumes it.
 *
 * Over a COPY: a handler is free to unregister itself as part of consuming
 * the press, which is exactly what closing a screen does.
 */
export function handleBack(): boolean {
  const ordered = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  for (const entry of ordered) if (entry.action()) return true;
  return false;
}

/** Test seam only — a module singleton outlives one test file. */
export function resetBackHandlers(): void {
  entries.length = 0;
  nextSeq = 0;
}

/**
 * Hold a back handler for as long as `active`.
 *
 * The action is read through a ref so that a screen whose closure changes on
 * every render — every screen — does not re-register on every render.
 */
export function useBack(active: boolean, action: BackAction, priority: number): void {
  const held = useRef(action);
  held.current = action;
  useEffect(() => {
    if (!active) return;
    return registerBack(() => held.current(), priority);
  }, [active, priority]);
}
