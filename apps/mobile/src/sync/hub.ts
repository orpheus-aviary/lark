// The process's sync state, as one external store (N5c).
//
// A MODULE SINGLETON, like the player, the download hub and for the same
// reason: an Activity that Android destroyed and rebuilt remounts every
// screen, and sync state that lived on a component would be state that
// disappears exactly while a round is running.
//
// WHAT IT IS NOT. The desktop's `stores/sync.ts` (259 lines) is a zustand store
// that POLLS `GET /sync/status` over HTTP, because the GUI and the daemon are
// two processes. Here the coordinator is in this JS heap: the status is a
// function call, and the only question is when to call it. So this is a cache
// with an invalidation signal, not a client.
//
// `getState()` hands back a CACHED object and rebuilds it only on `refresh()`,
// because the screens read it through `useSyncExternalStore` — which compares
// with `Object.is` and would re-render forever against a freshly built object.

import {
  type CoordinatorContext,
  buildSyncStatus,
  countUnresolvedConflicts,
} from '@lark/core/portable';
import type { SyncStatusData } from '@lark/shared';

export interface SyncHubState {
  /**
   * Null until the first refresh — which is not the same as "sync is off".
   * A library with no credentials still produces a status saying so
   * (`configured: false`), so null means only "nobody has looked yet".
   */
  status: SyncStatusData | null;
  /** Unresolved conflicts. Beside the status rather than inside it because the desktop badge reads them from two places too. */
  conflicts: number;
}

const EMPTY: SyncHubState = { status: null, conflicts: 0 };

const listeners = new Set<() => void>();

let ctx: CoordinatorContext | null = null;
let state: SyncHubState = EMPTY;

/**
 * Give the hub the coordinator. Once per process, beside the assembly.
 *
 * It does NOT refresh here: attaching happens inside boot's `.then()`, and a
 * status read is several database queries plus a directory listing. The first
 * screen that wants it asks.
 */
export function attachSync(coordinator: CoordinatorContext): void {
  ctx = coordinator;
}

/** Re-read everything and tell the screens. A no-op before `attachSync`. */
export function refreshSync(): void {
  if (ctx === null) return;
  state = { status: buildSyncStatus(ctx), conflicts: countUnresolvedConflicts(ctx.db.sqlite) };
  for (const listener of listeners) listener();
}

export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncState(): SyncHubState {
  return state;
}
