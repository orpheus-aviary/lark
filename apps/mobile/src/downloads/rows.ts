// Which tasks a list shows, and in which order (N4d-2, decision c).
//
// Its own module rather than a few lines inside `ui/task-list.tsx` because it
// is the one part of that screen that can be wrong in a way nobody sees: a
// `FlatList` only renders what fits, so a row sorted off the bottom of the
// screen is indistinguishable from a row that does not exist. MEASURED, N4d-2:
// it took a cancelled download that reported 「已取消」 and then could not be
// found in the list to notice that the order was reversed.
//
// 🔴 THE ENGINE HANDS BACK INSERTION ORDER — OLDEST FIRST. `snapshot()` is
// `[...this.#tasks.values()]` over a Map, which is the order things were
// registered in, NOT the "newest first" the hub's own comment claimed. So a
// naive `slice(0, 20)` keeps the twenty OLDEST terminal tasks and drops every
// recent one — the exact opposite of decision c's 「终态只留最近 20 条」.

import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { isActive } from './cancel';

/** A screen and a bit of the ring. The engine keeps 100; nobody scrolls to them. */
export const TERMINAL_SHOWN = 20;

/**
 * Active tasks first, in the order they were queued — the one that is running
 * is the oldest of them, so it lands on top by itself — then the terminal ones,
 * most recently finished first.
 *
 * `finished_at` and not the array order: it is what "recent" means, and a task
 * that somehow lacks one sorts last rather than jumping to the top.
 */
export function orderTaskRows(
  tasks: readonly DownloadTaskData[],
  limit = TERMINAL_SHOWN,
): DownloadTaskData[] {
  const terminal = tasks
    .filter((task) => !isActive(task))
    .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))
    .slice(0, limit);
  return [...tasks.filter(isActive), ...terminal];
}

/**
 * The batch a list should be reporting on: the most recent one (N4f-2).
 *
 * BY `created_at`, NOT BY POSITION, for the same reason the rows above sort by
 * `finished_at`: the engine hands back a Map's insertion order and a screen
 * that read `at(-1)` would be trusting a detail of a registry it does not own.
 * Ties go to the later entry — two batches opened in the same millisecond are
 * one submission's worth of groups, and the phone only ever submits one.
 *
 * "Most recent" rather than "the one the running task is in" (the desktop's
 * rule, `batchProgress`): a phone's list IS the screen, and a line that
 * vanished the instant the last item settled would never be seen reading N/N.
 */
export function latestBatch(batches: readonly DownloadBatchData[]): DownloadBatchData | null {
  let latest: DownloadBatchData | null = null;
  for (const batch of batches) {
    if (latest === null || batch.created_at >= latest.created_at) latest = batch;
  }
  return latest;
}
