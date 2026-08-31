// The order the download page lists what is running (0.5.1，用户 2026-08-31).
//
// 🔴 A LYRICS TASK IS THE TAIL OF A DOWNLOAD, NOT A NEW ARRIVAL. `lyrics` is
// not a stage of a download — a successful download SPAWNS a second task
// (M3-9), and that task is registered at the moment the first one ended. Both
// ends ordered the running group oldest-first, so the continuation of the song
// somebody just watched finish landed at the BOTTOM, under every download
// still going. Reported as 「匹配歌词阶段不应该沉到下面」.
//
// The fix is not a special case for `lyrics` — it is asking the right question
// of every task: WHEN DID THIS SONG ENTER THE QUEUE? For a download that is
// its own `created_at`; for a continuation it is the `created_at` of the
// download it continues, which is still in the snapshot because a terminal
// task stays in the ring.
//
// Portable, and shared, because this is exactly the kind of rule that goes
// wrong by drifting: the desktop had it in a comparator inside `DownloadPanel`
// and the phone had it implicitly in a Map's insertion order, which is two
// answers to one question waiting to disagree.

import type { DownloadTaskData } from '@lark/shared';

/**
 * When the SONG this task is about entered the queue.
 *
 * The fallback is the task's own moment, and it is reached in two honest
 * cases: an ordinary download, and a continuation whose download has aged out
 * of the 100-task ring. Neither is a failure — the second just means the
 * question can no longer be answered better than this.
 */
export function queuedAt(task: DownloadTaskData, all: readonly DownloadTaskData[]): number {
  const own = task.started_at ?? task.created_at;
  if (task.kind !== 'lyrics' || task.song_id === null) return own;
  const parent = all.find(
    (candidate) => candidate.kind !== 'lyrics' && candidate.song_id === task.song_id,
  );
  return parent === undefined ? own : (parent.started_at ?? parent.created_at);
}

/**
 * `visible` in queue order, oldest song first.
 *
 * Two arguments rather than one: the continuation's answer lives on a task
 * that is NOT in `visible` — it already finished, which is precisely why its
 * continuation exists.
 */
export function orderedTasks(
  visible: readonly DownloadTaskData[],
  all: readonly DownloadTaskData[],
): DownloadTaskData[] {
  return [...visible].sort((a, b) => {
    const byQueue = queuedAt(a, all) - queuedAt(b, all);
    // A song's own download and its continuation can only tie when the parent
    // is gone; the continuation is the later half of that song either way.
    if (byQueue !== 0) return byQueue;
    return a.created_at - b.created_at;
  });
}
