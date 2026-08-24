// The ensure controller, wired to this process (N4g-1).
//
// Same split as the player: `ensure.ts` is the state machine with every
// dependency injected and no React Native anywhere in it, so the race it
// implements is testable in a second; this is where it meets the four things
// it cannot reach on its own — the engine, the library, the player, and the
// toast a person actually reads.
//
// It is a SINGLETON for the reason everything else here is: Android destroys
// and rebuilds the Activity, `App` remounts, and a second controller would be
// a second slot — the first one still holding a tap that a finished download
// is about to honour, with nobody listening any more.

import type { LibraryService } from '@lark/core/portable';
import { NotFoundError } from '@lark/core/portable';
import type { SongData } from '@lark/shared';
import { ToastAndroid } from 'react-native';
import { player } from '../player';
import type { PlayQueue } from '../player/queue';
import { visibleQueue } from '../player/visible-queue';
import { cancelOne, describeCancel } from './cancel';
import type { DownloadRuntime } from './engine';
import { type EnsureController, ensureOnce } from './ensure';
import { downloads } from './hub';

/**
 * Which list a delayed play plays out of (§2.9): the one on screen when it
 * starts, as long as that list holds the song — otherwise the one the row was
 * tapped in.
 *
 * The fallback is not a corner case. What is on screen a minute later is often
 * 设置, the add page or another playlist, and a queue that does not contain the
 * song being played is a queue whose "next" means nothing.
 */
function queueFor(song: SongData, tapped: PlayQueue): PlayQueue {
  const visible = visibleQueue() ?? tapped;
  return visible.songIds.includes(song.id) ? visible : tapped;
}

export function bindEnsure(deps: {
  library: LibraryService;
  runtime: DownloadRuntime;
}): EnsureController {
  return ensureOnce({
    claimIntent: () => player.claimIntent(),
    holdsIntent: (mine) => player.holdsIntent(mine),
    enqueue: (songId) => deps.runtime.engine.enqueueEnsureFile(songId),
    cancelTask: (taskId) => {
      const task = downloads.getState().tasks.find((candidate) => candidate.id === taskId);
      // Gone from the ring means it is over, and there is nothing to say about
      // a task that already ended.
      if (task === undefined) return;
      // The three outcomes are the engine's and they are different things —
      // a task past its commit point is REFUSED and finishes anyway (§1.3).
      ToastAndroid.show(describeCancel(cancelOne(deps.runtime.engine, task)), ToastAndroid.SHORT);
    },
    getSong: (songId) => {
      try {
        return deps.library.getSong(songId);
      } catch (err) {
        // Deleted between the tap and the file arriving. Every other failure
        // is somebody else's to explain.
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    queueFor,
    play: (song, queue) => void player.play(song, queue),
    say: (message) => ToastAndroid.show(message, ToastAndroid.SHORT),
  });
}

export { ensureController } from './ensure';
export type { EnsureController, EnsureWait } from './ensure';
