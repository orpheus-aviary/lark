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

import type { DownloadTaskData } from '@lark/shared';
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
