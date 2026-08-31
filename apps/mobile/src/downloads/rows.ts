// What the download page shows, and in which order (N4d-2 decision c; rebuilt
// for the persistent history in 0.1.1 ⑦).
//
// Its own module rather than a few lines inside `ui/task-list.tsx` because it
// is the one part of that screen that can be wrong in a way nobody sees: a
// `FlatList` only renders what fits, so a row sorted off the bottom of the
// screen is indistinguishable from a row that does not exist. MEASURED,
// N4d-2: it took a cancelled download that reported 「已取消」 and then could
// not be found in the list to notice that the order was reversed.
//
// TWO GROUPS, AND THEY COME FROM DIFFERENT PLACES. What is RUNNING is the
// engine's, in the order it was queued — 🔴 `snapshot()` walks a Map, so that
// is insertion order and the oldest of them is the one actually running, which
// is why it lands on top by itself. What has FINISHED is the history's
// (`downloads/history.ts`), newest first, and it outlives both the engine's
// 100-task ring and the process.
//
// ONE FLAT LIST, not a `SectionList`: the whole page is already one scroll
// container (0.1.1 ③) and a discriminated row keeps the ordering decidable
// here, in a file that loads without a device.

import { type DownloadRecord, orderedTasks } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';
import { isActive } from './cancel';

/** Which group a heading belongs to. The buttons on it are the screen's. */
export type DownloadSection = 'tasks' | 'records';

export type DownloadListRow =
  | { kind: 'head'; key: string; section: DownloadSection; count: number }
  | { kind: 'task'; key: string; task: DownloadTaskData }
  | { kind: 'record'; key: string; record: DownloadRecord }
  | { kind: 'empty'; key: string; text: string };

/**
 * The page, top to bottom.
 *
 * 下载记录 IS HIDDEN WHEN EMPTY, heading and all: its heading carries 清空记录
 * and 全部重试, and offering either over nothing is two buttons that cannot do
 * anything. 下载任务 always shows, because "nothing is downloading" is an
 * answer somebody came to this page for.
 */
export function downloadListRows(
  tasks: readonly DownloadTaskData[],
  records: readonly DownloadRecord[],
): DownloadListRow[] {
  // 🔴 SORTED, NOT INSERTION ORDER (0.5.1). A Map's insertion order put the
  // lyrics continuation of a song that just finished BELOW every download
  // still going, because it is the newest entry — and on a phone, a row
  // sorted off the bottom is indistinguishable from a row that is not there.
  // `orderedTasks` is the desktop's answer too, from portable.
  const active = orderedTasks(tasks.filter(isActive), tasks);
  const rows: DownloadListRow[] = [
    { kind: 'head', key: 'head:tasks', section: 'tasks', count: active.length },
  ];
  if (active.length === 0) {
    rows.push({ kind: 'empty', key: 'empty:tasks', text: '没有正在进行的下载' });
  } else {
    for (const task of active) rows.push({ kind: 'task', key: `task:${task.id}`, task });
  }
  if (records.length > 0) {
    rows.push({ kind: 'head', key: 'head:records', section: 'records', count: records.length });
    for (const record of records) {
      rows.push({ kind: 'record', key: `record:${record.id}`, record });
    }
  }
  return rows;
}

/**
 * The batch a list should be reporting on: the most recent one (N4f-2).
 *
 * BY `created_at`, NOT BY POSITION: the engine hands back a Map's insertion
 * order and a screen that read `at(-1)` would be trusting a detail of a
 * registry it does not own. Ties go to the later entry — two batches opened in
 * the same millisecond are one submission's worth of groups, and the phone
 * only ever submits one.
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
