// "Play this song once it has been downloaded" — the pending intent (M5-9).
//
// Playing a song whose file was evicted queues an `ensure-file` task and
// remembers ONE intent: `{task_id, song_id, generation}`. There is deliberately
// no queue of them — the user asked for one song, and the last ask wins.
//
// Three details decide whether this works or hangs:
//
//   MATCH BY TASK ID. `download:error` and `download:cancelled` carry only a
//   task id, so that is what the slot is keyed by.
//
//   SETTLE FROM SNAPSHOTS, NOT EVENTS. SSE has no replay: a zero-network
//   ensure can finish before the POST response is even parsed, and a task that
//   completes while the stream is down is never announced. So every settlement
//   goes through one idempotent reducer fed by `GET /download/tasks` — after
//   the POST, on every hello, and on every refresh. A task the snapshot does
//   not know about clears the slot rather than waiting forever.
//
//   GENERATIONS INVALIDATE AT DISPATCH. `invalidate()` runs in the same
//   synchronous step as the user's action, before the operation reaches the
//   player queue — otherwise a `playPending` already sitting in the queue
//   would play the old song first and the new click would be the one that
//   looked superseded.

import type { DownloadTaskAcceptedData, DownloadTaskData, SongData } from '@lark/shared';
import { API_PATHS, ApiError, apiPath, request } from '@lark/shared';
import { toast } from 'sonner';

export interface PendingIntent {
  taskId: string;
  songId: string;
  generation: number;
}

let slot: PendingIntent | null = null;
let generation = 0;

/** Set by the player store; kept injectable so this module stays store-free. */
type PlayHandler = (song: SongData, expectedGeneration: number) => void;
let playHandler: PlayHandler = () => {};

export function setPendingPlayHandler(handler: PlayHandler): void {
  playHandler = handler;
}

export function pendingIntent(): PendingIntent | null {
  return slot;
}

export function pendingGeneration(): number {
  return generation;
}

/**
 * Drop the current intent and make every continuation that quotes the old
 * generation a no-op. `supersede` additionally asks the daemon to cancel the
 * download nobody is waiting for any more — best effort, because a task past
 * its commit point answers 409 and is allowed to finish (it just will not
 * play: its task id no longer matches the slot).
 */
export function invalidatePending(options: { supersede?: boolean } = {}): number {
  generation += 1;
  const previous = slot;
  slot = null;
  if (previous !== null && options.supersede === true) cancelQuietly(previous.taskId);
  return generation;
}

function cancelQuietly(taskId: string): void {
  void request('POST', API_PATHS.downloadCancel, { task_id: taskId }).catch(() => {
    // 409 TASK_NOT_CANCELLABLE / 404 are both fine: this is only a courtesy.
  });
}

/** Reset for a fresh renderer state — tests and the daemon-generation change. */
export function clearPending(): void {
  slot = null;
}

/**
 * Queue an ensure-file for `song` and remember the intent. Returns what the
 * caller should report: this is a successful command, not a refusal — the song
 * WILL play, just not yet.
 */
export async function requestPendingPlay(
  song: SongData,
): Promise<{ ok: boolean; message: string }> {
  const expected = generation;
  try {
    const envelope = await request<DownloadTaskAcceptedData>(
      'POST',
      apiPath.songEnsureFile(song.id),
    );
    const taskId = envelope.data?.task_id;
    if (taskId === undefined) return { ok: false, message: '下载没有排上队' };
    if (generation !== expected) {
      // The user moved on while the request was in flight.
      cancelQuietly(taskId);
      return { ok: false, message: 'superseded' };
    }
    slot = { taskId, songId: song.id, generation: expected };
    // The task may already be finished — a song that has its file needs no
    // network at all — and its completion event may predate this slot.
    void refreshTasks();
    return { ok: true, message: '正在下载，完成后自动播放' };
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '下载请求失败';
    toast.error(message);
    return { ok: false, message };
  }
}

/** Injected by the download store, which owns the snapshot lane. */
type TaskRefresher = () => void;
let refreshTasks: TaskRefresher = () => {};

export function setPendingTaskRefresher(refresh: TaskRefresher): void {
  refreshTasks = refresh;
}

/**
 * The one settlement path. Idempotent: it may be called with the same snapshot
 * any number of times, and it either leaves the slot alone or consumes it.
 */
export function reconcilePending(tasks: readonly DownloadTaskData[]): void {
  const intent = slot;
  if (intent === null) return;

  const task = tasks.find((candidate) => candidate.id === intent.taskId);
  if (task === undefined) {
    // Not in the snapshot at all: a restarted daemon, or a task trimmed from
    // the terminal ring. Waiting on it forever is the one outcome to avoid.
    slot = null;
    return;
  }

  if (task.state === 'succeeded') {
    slot = null; // consumed here, so a second snapshot cannot re-enter
    void playWhenReady(intent);
    return;
  }
  if (task.state === 'failed' || task.state === 'cancelled') {
    slot = null;
    if (task.state === 'failed') toast.error(`下载失败，无法播放：${task.error_message ?? ''}`);
    return;
  }
  // queued / running: keep waiting.
}

/**
 * Fetch the song fresh — `has_file` is a per-request disk probe, and the
 * library store only knows about the view that happens to be open — then hand
 * it to the player, which re-checks the generation inside its queue slot.
 */
async function playWhenReady(intent: PendingIntent): Promise<void> {
  if (generation !== intent.generation) return;
  try {
    const envelope = await request<SongData>('GET', apiPath.song(intent.songId));
    const song = envelope.data;
    if (song === undefined) return;
    playHandler(song, intent.generation);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      toast.info('这首歌已被删除');
      return;
    }
    toast.error('下载完成了，但取歌曲信息失败');
  }
}
