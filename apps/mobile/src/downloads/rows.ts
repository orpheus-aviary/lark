// What the download page shows, and in which order (N4d-2 decision c; the
// persistent history in 0.1.1 ⑦; three groups in 2026-09-02).
//
// Its own module rather than a few lines inside `ui/task-list.tsx` because it
// is the one part of that screen that can be wrong in a way nobody sees: a
// `FlatList` only renders what fits, so a row sorted off the bottom of the
// screen is indistinguishable from a row that does not exist. MEASURED,
// N4d-2: it took a cancelled download that reported 「已取消」 and then could
// not be found in the list to notice that the order was reversed.
//
// THREE GROUPS, AND THEY ANSWER THREE QUESTIONS — what is happening now, what
// is waiting, and what already happened. The words are the desktop's
// (`DownloadPanel`, §3.6-3) because they are the same three groups; a phone
// that called them something else would be a second vocabulary for one thing.
// The first two are the ENGINE's, live; the third is the history's
// (`downloads/history.ts`), newest first, and it outlives both the engine's
// 100-task ring and the process.
//
// 🔴 AN EMPTY GROUP IS STILL DRAWN, WITH A LINE SAYING SO, and that is a
// deliberate divergence from the desktop (用户, 2026-09-02). There, an empty
// section is noise inside a dialog you opened to look at something else. Here
// this page IS the screen, and 「没有排队的任务」 is an answer somebody came
// to it for.
//
// ONE FLAT LIST, not a `SectionList`: the whole page is already one scroll
// container (0.1.1 ③) and a discriminated row keeps the ordering decidable
// here, in a file that loads without a device.

import { type DownloadRecord, orderedTasks } from '@lark/core/portable';
import type { DownloadBatchData, DownloadTaskData } from '@lark/shared';

/** Which group a heading belongs to. The buttons on it are the screen's. */
export type DownloadSection = 'running' | 'queued' | 'records';

/** The desktop's three words (`DownloadPanel`). */
export const SECTION_TITLES: Record<DownloadSection, string> = {
  running: '进行中',
  queued: '排队中',
  records: '已结束',
};

/** What a group says when it has nothing in it. */
const EMPTY_TEXT: Record<DownloadSection, string> = {
  running: '没有正在下载的歌',
  queued: '没有排队的任务',
  records: '还没有下载记录',
};

export type DownloadListRow =
  | { kind: 'head'; key: string; section: DownloadSection; count: number }
  | { kind: 'task'; key: string; section: 'running' | 'queued'; task: DownloadTaskData }
  | { kind: 'record'; key: string; record: DownloadRecord }
  | { kind: 'empty'; key: string; text: string };

/** A heading, then what is under it — or the one line that says nothing is. */
function group(section: DownloadSection, rows: readonly DownloadListRow[]): DownloadListRow[] {
  const head: DownloadListRow = {
    kind: 'head',
    key: `head:${section}`,
    section,
    count: rows.length,
  };
  if (rows.length === 0) {
    return [head, { kind: 'empty', key: `empty:${section}`, text: EMPTY_TEXT[section] }];
  }
  return [head, ...rows];
}

/**
 * The page, top to bottom.
 *
 * 🔴 SORTED, NOT INSERTION ORDER (0.5.1). A Map's insertion order put the
 * lyrics continuation of a song that just finished BELOW every download still
 * going, because it is the newest entry — and on a phone, a row sorted off the
 * bottom is indistinguishable from a row that is not there. `orderedTasks` is
 * called once per group with the WHOLE task list as its second argument,
 * exactly as the desktop calls it: a continuation is placed by when its parent
 * was queued, and the parent may not be in the group being sorted.
 */
export function downloadListRows(
  tasks: readonly DownloadTaskData[],
  records: readonly DownloadRecord[],
): DownloadListRow[] {
  const taskRow =
    (section: 'running' | 'queued') =>
    (task: DownloadTaskData): DownloadListRow => ({
      kind: 'task',
      key: `task:${task.id}`,
      section,
      task,
    });
  return [
    ...group(
      'running',
      orderedTasks(
        tasks.filter((task) => task.state === 'running'),
        tasks,
      ).map(taskRow('running')),
    ),
    ...group(
      'queued',
      orderedTasks(
        tasks.filter((task) => task.state === 'queued'),
        tasks,
      ).map(taskRow('queued')),
    ),
    ...group(
      'records',
      records.map((record) => ({ kind: 'record', key: `record:${record.id}`, record }) as const),
    ),
  ];
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
