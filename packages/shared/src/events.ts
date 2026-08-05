// SSE payload helpers for `GET /events` consumers (M4-13③).

import type { LarkEvent } from './types.js';

/**
 * Parse one raw SSE `data` string into a {@link LarkEvent}. `null` for
 * anything that is not a JSON object with a string `type` — a malformed
 * frame must be dropped, never crash the subscriber. Unknown `type` values
 * pass through so an older GUI survives a newer daemon (receivers switch on
 * `type` and ignore what they don't know).
 */
export function parseLarkEvent(raw: string): LarkEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (typeof (value as { type?: unknown }).type !== 'string') return null;
  return value as LarkEvent;
}

/** The slice of `download:status` the dedupe key is built from. */
export interface DownloadStatusKey {
  task_id: string;
  state: string;
  stage: string | null;
  revision: number;
}

/**
 * Stateful `download:status` dedupe, keyed PER TASK on
 * `(task_id, state, stage, revision)` (M4-13③): a global last-tuple would
 * swallow updates from parallel tasks that legitimately agree on
 * `(state, stage, revision)`. Returns `true` when the event is fresh.
 *
 * Terminal states arrive via their own event types, so entries are simply
 * retained until `clear()` — the epoch-scoped subscriber discards the whole
 * deduper on reconnect.
 */
export function createDownloadStatusDedupe(): {
  isFresh(event: DownloadStatusKey): boolean;
  clear(): void;
} {
  const lastByTask = new Map<string, string>();
  return {
    isFresh(event: DownloadStatusKey): boolean {
      const key = `${event.state}|${event.stage ?? ''}|${event.revision}`;
      if (lastByTask.get(event.task_id) === key) return false;
      lastByTask.set(event.task_id, key);
      return true;
    },
    clear(): void {
      lastByTask.clear();
    },
  };
}
