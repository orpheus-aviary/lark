// The hub, as React reads it (N4d-1).
//
// `hub.ts` was written for this and left the hook for its first component:
// `getState()` hands back a CACHED object and rebuilds it only when the engine
// says something changed, which is exactly `useSyncExternalStore`'s contract —
// it compares snapshots with `Object.is`, so a store that built a fresh object
// per call would re-render forever.
//
// No selector argument, deliberately. `useSyncExternalStore` re-runs the
// selector on every emission and compares its RESULT, so a selector returning
// a derived array or object would reintroduce the same infinite loop the hub
// was shaped to avoid. There is one screen reading this; when a second one
// wants a slice of it, `useSyncExternalStoreWithSelector` and an equality
// function is the answer, with a reason.

import { useSyncExternalStore } from 'react';
import { type DownloadsState, downloads } from './hub';

export function useDownloads(): DownloadsState {
  return useSyncExternalStore(downloads.subscribe, downloads.getState);
}
