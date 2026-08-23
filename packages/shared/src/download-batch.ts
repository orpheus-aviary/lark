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
// WHAT "DONE" MEANS IS THE WHOLE POINT: an item counts once it is SETTLED, not
// once it succeeded. A batch of ten where three failed reads 10/10 and stops —
// the failures are the task rows' business, and a counter that stalled at 7/10
// forever would be the batch claiming work is still coming.

import type { DownloadBatchData } from './types.js';

/** `n/total` for the batch a task belongs to, or null when it is a lone task. */
export function batchProgress(
  batches: readonly DownloadBatchData[],
  taskId: string,
): { batch: DownloadBatchData; done: number } | null {
  const batch = batches.find((candidate) =>
    candidate.items.some((item) => item.task_id === taskId),
  );
  if (!batch) return null;
  return { batch, done: batch.items.filter((item) => item.final !== null).length };
}
