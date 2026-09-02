// Where a sheet is drawn (2026-09-02).
//
// 🔴 WHY THIS EXISTS AT ALL: a sheet used to be an RN `Modal`, which is a
// SECOND WINDOW, and a second window turned out to be the root of both
// problems the device found. Its geometry is its own — the room the app makes
// for the keyboard at its root does not reach it — and when the IME covers the
// field, the platform PANS that window to reveal it, by an amount nothing in
// JS can see (Fabric measures the layout tree, which knows nothing about a
// window scroll). A field could therefore be perfectly usable while 保存 under
// it was covered, and correcting for it meant subtracting a number we cannot
// read. `autoFocus` was the same story from the other end: it is applied in
// `onAttachedToWindow`, one line before RN clears the dialog window's
// FLAG_NOT_FOCUSABLE, so the keyboard it asked for never came up.
//
// One window has neither problem. THE OVERLAY IS ABSOLUTELY POSITIONED INSIDE
// THE APP ROOT, so it sits inside the root's padding box — which is where the
// keyboard room already is (`App.tsx`). A sheet is above the keyboard because
// everything is.
//
// This is React Native, so there is no `createPortal`: a host at the root and
// a slot per sheet is the whole mechanism. THE CONSEQUENCE TO KNOW is that a
// sheet's children render HERE rather than where they were written, so the
// context they see is the host's — which is inside `LibraryProvider`, the only
// context this app has. Anything narrower would have to be passed as a prop.
//
// It replaces `Modal` for SHEETS ONLY. The pickers, the player and the queue
// are still `Modal`s: they carry no field that the keyboard has to clear, and
// a full-screen dialog covering the status bar is what they want.

import { type ReactNode, useEffect, useId, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

const slots = new Map<string, ReactNode>();
const listeners = new Set<() => void>();
/** Bumped on every change, because a Map is not a snapshot React can compare. */
let version = 0;

function publish(id: string, node: ReactNode | null): void {
  if (node === null) slots.delete(id);
  else slots.set(id, node);
  version += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Draw this above everything, for as long as the caller is mounted.
 *
 * No dependency array on purpose: `node` is a fresh element on every render of
 * the caller, and a stale one on screen would be worse than a republish. The
 * host re-renders, the caller does not, so there is no loop.
 */
export function useOverlay(node: ReactNode): void {
  const id = useId();
  useEffect(() => {
    publish(id, node);
    return () => publish(id, null);
  });
}

/**
 * The host. One, at the end of the shell, so it draws last.
 *
 * `box-none` so an empty host is not a sheet of glass over the whole app; each
 * sheet brings its own backdrop, which IS meant to take every touch.
 */
export function OverlayHost() {
  useSyncExternalStore(subscribe, () => version);
  if (slots.size === 0) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {[...slots].map(([id, node]) => (
        <View key={id} style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {node}
        </View>
      ))}
    </View>
  );
}
