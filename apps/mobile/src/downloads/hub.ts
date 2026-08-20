// The process's download state, as one external store (N4b, decision n).
//
// A MODULE SINGLETON, like the player and for the same reason: an Activity
// that Android destroyed and rebuilt remounts every screen, and download state
// that lived on a component would be download state that disappears exactly
// when a download is still running.
//
// IT HAS TO EXIST BEFORE THE ENGINE DOES. `EngineCallbacks` is given at
// construction and there is no add/remove subscription face (`engine.ts`), so
// "who listens" is decided once, permanently, at the moment the engine is
// built. A hub added later would have nowhere to attach — which is why this
// file and the assembly are one batch (§1.1).
//
// Same selector contract as `usePlayback`: this is `useSyncExternalStore` with
// no memo layer, so a selector must return a primitive or a stable reference.
// `getState()` therefore hands back a CACHED object and rebuilds it only when
// the engine says something changed.

import type { DownloadEngine } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { useSyncExternalStore } from 'react';

export interface DownloadsState {
  /** Newest first, terminal tasks included — the engine's own ring (§4-f). */
  tasks: readonly DownloadTaskData[];
  batches: readonly DownloadBatchData[];
}

const NOTHING: DownloadsState = { tasks: [], batches: [] };

const listeners = new Set<() => void>();

let engine: DownloadEngine | null = null;
let state: DownloadsState = NOTHING;

/**
 * Re-read the engine and tell everyone.
 *
 * Called from every engine callback. Cheap enough to call per progress event
 * because the engine throttles those to one per task per 500ms, and the
 * snapshot is the same one the daemon builds for `GET /download/tasks`.
 */
export function refreshDownloads(): void {
  state = engine === null ? NOTHING : engine.snapshot();
  for (const listener of listeners) listener();
}

/**
 * Called once, by the assembly, with the engine it just built.
 *
 * Nothing can have been enqueued yet — the constructor does not start the
 * worker — so no callback can have fired into an unattached hub.
 */
export function attachDownloadEngine(next: DownloadEngine): void {
  engine = next;
  refreshDownloads();
}

/** The engine, for the screens that command it. */
export function downloadEngine(): DownloadEngine {
  if (engine === null) throw new Error('downloads were used before the library was open');
  return engine;
}

export const downloads = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: (): DownloadsState => state,
};

/** Subscribe to one slice of download state. See the selector rule above. */
export function useDownloads<T>(select: (state: DownloadsState) => T): T {
  return useSyncExternalStore(downloads.subscribe, () => select(downloads.getState()));
}
