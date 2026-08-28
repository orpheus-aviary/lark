// A batch, counted from one of its tasks (N4f-1, decision h).
//
// Eight lines that lived in the Electron renderer's download store until a
// second front end needed the same M/N. What must not differ between two hosts
// is the MEANING of a number both of them show — the same reason `decideNext`
// (play-queue) and the three label tables (download-labels) are here rather
// than in whichever host asked first.
//
// A PURE MOVE: the body below is the one `gui/stores/download.ts` had, byte for
// byte. Nothing about the desktop's status line changes, which is what makes
// its own tests the check on this file arriving intact.
//
// TWO WAYS IN, ONE RULE (N4f-2). The desktop asks "which batch is this task
// in, and how far along is it" — its status line is about a task. The phone's
// list has a line of its own above every row and asks about a BATCH directly,
// so `batchDone` is the shared half and `batchProgress` is the lookup in front
// of it.
//
// WHAT "DONE" MEANS IS THE WHOLE POINT: an item counts once it is SETTLED, not
// once it succeeded. A batch of ten where three failed reads 10/10 and stops —
// the failures are the task rows' business, and a counter that stalled at 7/10
// forever would be the batch claiming work is still coming.

import type { DownloadBatchData, DownloadBatchGroupInput, ParsedItem } from './types.js';

/** How many of a batch's items have settled — the `n` of `n/total`. */
export function batchDone(batch: DownloadBatchData): number {
  return batch.items.filter((item) => item.final !== null).length;
}

/** `n/total` for the batch a task belongs to, or null when it is a lone task. */
export function batchProgress(
  batches: readonly DownloadBatchData[],
  taskId: string,
): { batch: DownloadBatchData; done: number } | null {
  const batch = batches.find((candidate) =>
    candidate.items.some((item) => item.task_id === taskId),
  );
  if (!batch) return null;
  return { batch, done: batchDone(batch) };
}

/**
 * The `source` a list group submits (0.5.0 ④), from the list link and the name
 * on screen.
 *
 * Here rather than in either front end for the reason everything else in this
 * file is: both ends send the same group, and a second copy of "which title
 * goes in" is a second answer waiting to happen.
 *
 * THE TITLE IS THE ONE THE USER IS LOOKING AT, edited or not. That name also
 * becomes the playlist, so 「from：X」 and the playlist called X are the same
 * X — which is the reading somebody has when they go back to ask where a song
 * came from.
 */
export function listSource(
  item: Extract<ParsedItem, { kind: 'favorites' | 'collection' }>,
  title: string,
): NonNullable<DownloadBatchGroupInput['source']> {
  return { list: item.kind, title, url: item.url };
}
