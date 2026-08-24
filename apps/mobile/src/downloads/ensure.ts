// "Play this song once its file is back" — one play intent, waiting (N4g-1).
//
// Tapping a song with no file is A PLAY, not a download (§2.9, decision m):
// the phone fetches the audio and then starts it. Which means the tap has to
// survive up to a minute of network before it can be honoured, and in that
// minute the person who tapped is free to change their mind. Three rules make
// that safe, and all three are the desktop's (`gui/player/pending.ts`), in a
// process that happens to hold its own engine:
//
//   ONE SLOT, LAST TAP WINS. There is no queue of pending intents. A second
//   tap replaces the first, and the download the first one started is left
//   running — it finishes, the song lands in the library, and nothing plays.
//   That is §2.9's "只入库、不抢播" in its entirety.
//
//   THE GENERATION IS THE PLAYER'S. Not a counter of our own: `claimIntent()`
//   is the same `claim()` every `play` uses (`player/store.ts`), so ANYTHING
//   that starts playback — another row, the next-track button, the queue
//   panel, a restored position — supersedes a waiting intent for free. A
//   private counter would have to be invalidated at each of those call sites,
//   and the one that got forgotten would be a song that hijacks the speaker a
//   minute after somebody moved on.
//
//   SETTLE FROM SNAPSHOTS, NOT EVENTS. `reconcile` is an idempotent reducer
//   over the task list, driven by every hub refresh. A zero-network ensure can
//   finish before anyone subscribes, and a task can age out of the engine's
//   terminal ring; both are "not in the snapshot", which clears the slot rather
//   than waiting forever.
//
// THE QUEUE IS TAKEN WHEN PLAYBACK STARTS, not when the row was tapped
// (§2.9, N3 decision o). A minute is long enough to have changed screens, and
// the queue that means anything is the one in front of you — so `queueFor` is
// asked at the last moment, with the tapped screen's queue as the fallback for
// when what is in front of you is not a list at all.

import type { DownloadTaskData, SongData } from '@lark/shared';
import type { PlayQueue } from '../player/queue';
import { downloads } from './hub';

export interface EnsureDeps {
  /** `player.claimIntent()` — take the newest play intent for a later play. */
  claimIntent: () => number;
  /** `player.holdsIntent(mine)` — is that intent still the newest one? */
  holdsIntent: (mine: number) => boolean;
  /** `engine.enqueueEnsureFile`. Throws the way the engine throws. */
  enqueue: (songId: string) => DownloadTaskData;
  /** Give up on a task nobody is waiting for. Says its own outcome out loud. */
  cancelTask: (taskId: string) => void;
  /** The song as the library has it NOW — `has_file` is a disk probe. */
  getSong: (songId: string) => SongData | null;
  /** The queue to play out of, decided at this moment (see the header). */
  queueFor: (song: SongData, tapped: PlayQueue) => PlayQueue;
  play: (song: SongData, queue: PlayQueue) => void;
  /** One line to the person who tapped. */
  say: (message: string) => void;
}

/** What the mini bar shows while a tap is waiting for its file. */
export interface EnsureWait {
  songId: string;
  name: string;
}

interface Slot extends EnsureWait {
  taskId: string;
  intent: number;
  /** The list the row was tapped in — the fallback, not the answer. */
  tapped: PlayQueue;
  /** …unless the caller pinned it, in which case it IS the answer. */
  fixedQueue: boolean;
}

export interface EnsureController {
  subscribe: (listener: () => void) => () => void;
  /** `null` when nothing is waiting. A stable reference between changes. */
  getState: () => EnsureWait | null;
  /**
   * Tapped a song with no file — or advanced onto one (N4g-3).
   *
   * `fixedQueue` is the difference between the two callers. A tap is about a
   * LIST you are looking at, so the queue may be replaced by whatever list is
   * on screen when the file lands (§2.9). 下一首 is about the queue you are
   * already playing, and switching queues because a screen moved would make
   * "next" mean something else entirely.
   */
  request: (song: SongData, queue: PlayQueue, options?: { fixedQueue?: boolean }) => void;
  /** The one settlement path. Idempotent; fed by every hub refresh. */
  reconcile: (tasks: readonly DownloadTaskData[]) => void;
  /** Gave up waiting: drop the intent AND the download (§2.9). */
  cancel: () => void;
}

export function createEnsureController(deps: EnsureDeps): EnsureController {
  const listeners = new Set<() => void>();
  let slot: Slot | null = null;
  let state: EnsureWait | null = null;

  const publish = (next: Slot | null): void => {
    slot = next;
    state = next === null ? null : { songId: next.songId, name: next.name };
    for (const listener of listeners) listener();
  };

  /** The file is here, and the intent was still ours when we checked. */
  const settle = (waited: Slot): void => {
    const song = deps.getSong(waited.songId);
    if (song === null) {
      // Downloaded, and deleted before it could play. Rare, and the honest
      // thing to say is the thing that happened.
      deps.say(`《${waited.name}》已经不在曲库里了`);
      return;
    }
    deps.play(song, waited.fixedQueue ? waited.tapped : deps.queueFor(song, waited.tapped));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getState: () => state,

    request(song, queue, options = {}) {
      let task: DownloadTaskData;
      try {
        // BEFORE the intent is claimed, so a refusal changes nothing: claiming
        // abandons whatever load is in flight, and a queue that is full is no
        // reason to stop the song that is already starting.
        task = deps.enqueue(song.id);
      } catch (err) {
        deps.say(err instanceof Error ? err.message : '这首歌没能排上队');
        return;
      }
      publish({
        taskId: task.id,
        songId: song.id,
        name: song.name,
        intent: deps.claimIntent(),
        tapped: queue,
        fixedQueue: options.fixedQueue === true,
      });
      deps.say(`正在获取《${song.name}》`);
    },

    reconcile(tasks) {
      const waiting = slot;
      if (waiting === null) return;

      // SUPERSEDED, and the row must stop saying otherwise (N4g-3, decision j).
      // Something else has spoken for the speaker — another song, 下一首, a
      // deliberate pause — so this fetch will not play when it lands. The
      // download is NOT cancelled: it was asked for, and it belongs in the
      // library either way. What ends here is the promise.
      if (!deps.holdsIntent(waiting.intent)) {
        publish(null);
        return;
      }

      const task = tasks.find((candidate) => candidate.id === waiting.taskId);
      if (task === undefined) {
        // Not in the snapshot at all — aged out of the terminal ring, or a
        // process that restarted underneath. Waiting forever is the one
        // outcome to avoid.
        publish(null);
        return;
      }
      switch (task.state) {
        case 'succeeded':
          publish(null); // consumed here, so a second snapshot cannot re-enter
          settle(waiting);
          return;
        case 'failed':
          publish(null);
          deps.say(`没能拿回《${waiting.name}》：${task.error_message ?? '下载失败'}`);
          return;
        case 'cancelled':
          // Either this controller cancelled it — in which case the cancel
          // already spoke — or the task list did, where the person watching
          // saw it happen.
          publish(null);
          return;
        default:
          return; // queued / running: keep waiting
      }
    },

    cancel() {
      const waiting = slot;
      if (waiting === null) return;
      publish(null);
      // AFTER the slot is dropped: the outcome may be "已经在落盘，停不下来",
      // and a task that finishes anyway must not then play — which is exactly
      // what an empty slot means.
      deps.cancelTask(waiting.taskId);
    },
  };
}

// ─── The process's one controller ──────────────────────

let controller: EnsureController | null = null;

/**
 * Build it once, whatever the Activity does — the fourth thing in this app
 * that needs saying (`bootOnce`, the player, the download runtime).
 *
 * The hub subscription is HERE rather than in the factory: it is wiring, and
 * a factory that subscribed would be a factory with a side effect nothing can
 * undo. It is never unsubscribed, which is correct — the controller outlives
 * every screen and there is nothing left to hear it after the process ends.
 */
export function ensureOnce(deps: EnsureDeps): EnsureController {
  if (controller === null) {
    const built = createEnsureController(deps);
    downloads.subscribe(() => built.reconcile(downloads.getState().tasks));
    controller = built;
  }
  return controller;
}

/** For the screens. Throws rather than answering with a controller nobody wired. */
export function ensureController(): EnsureController {
  if (controller === null)
    throw new Error('the ensure controller was used before the library was open');
  return controller;
}
