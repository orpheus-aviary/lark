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
// `getState()` hands back a CACHED object and rebuilds it only when the engine
// says something changed, because the screens that read it (N4d) will do so
// through `useSyncExternalStore` — which compares with `Object.is` and would
// re-render forever against a freshly built object. The hook itself arrives
// with its first component; there is nothing to hang it on yet.

import type { DownloadEngine } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { FOREGROUND_IDLE, type ForegroundStatus } from './foreground';

export interface DownloadsState {
  /**
   * The engine's own ring, terminal tasks included (§4-f).
   *
   * INSERTION ORDER — OLDEST FIRST. `snapshot()` walks a Map of every task this
   * process has registered, so the newest is at the END. This comment used to
   * say "newest first" and a screen believed it (N4d-2): `slice(0, 20)` kept the
   * twenty oldest and hid every recent one. Reading order belongs to whoever is
   * displaying it — `downloads/rows.ts`.
   */
  tasks: readonly DownloadTaskData[];
  batches: readonly DownloadBatchData[];
  /**
   * Whether a foreground service is holding this process up (N4c, decision e).
   *
   * It lives here and not in a store of its own because the hub is already
   * "the one thing you read to know about downloading", and a degraded
   * download — one running with no service and therefore no protection from
   * being killed — is a fact about downloading that a screen has to be able to
   * show (N4d).
   */
  foreground: ForegroundStatus;
}

const listeners = new Set<() => void>();

let engine: DownloadEngine | null = null;
let foreground: ForegroundStatus = FOREGROUND_IDLE;
let state: DownloadsState = { tasks: [], batches: [], foreground };

/**
 * Re-read the engine and tell everyone.
 *
 * Called from every engine callback. Cheap enough to call per progress event
 * because the engine throttles those to one per task per 500ms, and the
 * snapshot is the same one the daemon builds for `GET /download/tasks`.
 */
export function refreshDownloads(): void {
  state =
    engine === null ? { tasks: [], batches: [], foreground } : { ...engine.snapshot(), foreground };
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

/** The controller's one write face (`foreground.ts`). */
export function setForegroundStatus(next: ForegroundStatus): void {
  foreground = next;
  refreshDownloads();
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
