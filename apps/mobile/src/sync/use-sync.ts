// The sync hub, as React reads it (N5e).
//
// Same contract and same caveat as `downloads/use-downloads.ts`: the hub hands
// back a CACHED object and rebuilds it only on `refreshSync()`, because
// `useSyncExternalStore` compares snapshots with `Object.is` and a store that
// built a fresh object per call would re-render forever.
//
// `useSyncNow` is the other half. The hub deliberately does not read the
// database when it is attached — a status is several queries plus a directory
// listing — so the first screen that wants one asks for it, and asks again
// whenever it comes back into view.

import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { type SyncHubState, getSyncState, refreshSync, subscribeSync } from './hub';

export function useSync(): SyncHubState {
  return useSyncExternalStore(subscribeSync, getSyncState);
}

/**
 * Read the status once on mount, and hand back a way to read it again.
 *
 * The effect is the legitimate kind: this synchronises with something outside
 * React (a database that other code writes), which is exactly what `useEffect`
 * is for and not a lifecycle hook in disguise.
 */
export function useSyncNow(): SyncHubState {
  const state = useSync();
  useEffect(() => {
    refreshSync();
  }, []);
  return state;
}
