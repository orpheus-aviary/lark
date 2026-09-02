// How tall a list's row is, measured once per process and per list (P2,
// 2026-09-02; a second list on 2026-09-02 evening).
//
// WHAT IT BUYS is `getItemLayout`. Without one, a `FlatList` estimates its
// total content height from the rows it has measured SO FAR, and revises that
// estimate on every batch it renders — so the scroll indicator is re-drawn,
// smaller, again and again while the list fills in. REPORTED by the user:
// 「加载歌曲页面进度条会有一个收缩动画」. With one, the content height is
// exact from the first frame and the thumb never moves on its own.
//
// MEASURED RATHER THAN WRITTEN DOWN. A row's height IS a constant — both of
// its lines are `numberOfLines={1}` and the paddings are fixed — but only for
// a given font scale, and the system font size is the user's. A hardcoded 56
// would clip text for anyone who enlarges it.
//
// 🔴 THE CACHE IS KEYED ON THE FONT SCALE, and that is not decoration.
// Changing the system font size RECREATES THE ACTIVITY, and this app's own
// rule is that an Activity restart does NOT restart the JS runtime
// (`docs/INVARIANTS.md` §6, the `bootOnce` lesson) — so a bare module-level
// number would survive the one event that invalidates it, and every list would
// lay out against a height that is no longer true.

import { useSyncExternalStore } from 'react';
import { PixelRatio } from 'react-native';

/**
 * Which list. Two shapes, and they really are different heights: a song row
 * carries two lines, a queue row one — measuring once and sharing the answer
 * would put the queue's rows at the wrong offsets, which is the exact bug
 * `getItemLayout` exists to avoid.
 */
export type RowKind = 'song' | 'queue';

const measured = new Map<RowKind, { height: number; fontScale: number }>();
const listeners = new Set<() => void>();

/** The row height, or `null` while nothing has reported one at this font scale. */
export function rowHeight(kind: RowKind): number | null {
  const seen = measured.get(kind);
  if (seen === undefined) return null;
  return seen.fontScale === PixelRatio.getFontScale() ? seen.height : null;
}

/**
 * Said by every row as it lays itself out; the first one to arrive is the one
 * that counts. Ignores a zero (a pass with nothing to measure) and stays quiet
 * when the answer has not changed — otherwise every row on screen would wake
 * the list up to tell it what it already knows.
 */
export function reportRowHeight(kind: RowKind, height: number): void {
  if (height <= 0) return;
  const fontScale = PixelRatio.getFontScale();
  const seen = measured.get(kind);
  if (seen !== undefined && seen.height === height && seen.fontScale === fontScale) return;
  measured.set(kind, { height, fontScale });
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The height, as a list reads it.
 *
 * `useSyncExternalStore` because this is a module-level value that outlives
 * every component reading it — the same shape as `downloads/use-downloads.ts`.
 * The snapshot is a number or null, so there is nothing here to compare wrong.
 */
export function useRowHeight(kind: RowKind): number | null {
  return useSyncExternalStore(subscribe, () => rowHeight(kind));
}
