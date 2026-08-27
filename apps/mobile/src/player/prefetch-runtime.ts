// Fetching the next song while this one plays (0.1.1 ⑥).
//
// WHAT it fetches is `prefetch.ts`, which asks `decideNext` so that the song
// prepared is always the song that will play. What is here is when to ask:
// once per SONG, not once per status tick — the player publishes twice a
// second and re-resolving the queue that often would be a library query twice
// a second for no new answer.
//
// 🔴 IT DOES NOT GO THROUGH THE CACHE BUDGET, and that is a deliberate
// departure from this batch's plan. The budget (`downloads/budget.ts`) is
// about a BATCH: tens of songs, nobody waiting, and 「下新删旧」 as a surprise.
// A lookahead of exactly one song, for a list somebody is listening to right
// now, is a different thing — and gating it would achieve nothing anyway,
// because the same song gets fetched three minutes later by the advance that
// needs it. All the gate would add is a gap in the music.
//
// IT DOES NOT CLAIM A PLAY INTENT. `ensureController` is a promise to play
// something when it lands (N4g); this is a guess about the future, and a guess
// that took the intent would silence whatever a person just asked for.
// Straight to the engine, which dedupes on `ensure-file:<songId>` — so if the
// advance later asks for the same song, the two become one task.

import type { DownloadEngine } from '@lark/core/portable';
import type { SongData } from '@lark/shared';
import { engineLogger } from '../downloads/log';
import { player } from './index';
import { songToPrefetch } from './prefetch';
import type { PlayQueue } from './queue';

let bound = false;

export function bindPrefetch(deps: {
  engine: DownloadEngine;
  /** The queue's songs as the library has them now. */
  songsOf: (queue: PlayQueue) => readonly SongData[];
  /** 「自动下载下一首」, read fresh: a setting changed mid-song counts. */
  enabled: () => boolean;
}): void {
  if (bound) return;
  bound = true;

  let last: string | null = null;
  player.subscribe(() => {
    const state = player.getState();
    const currentId = state.song?.id ?? null;
    if (currentId === last) return;
    last = currentId;
    if (state.queue === null || currentId === null) return;

    const target = songToPrefetch({
      songs: deps.songsOf(state.queue),
      currentId,
      mode: state.mode,
      enabled: deps.enabled(),
    });
    if (target === null) return;

    try {
      deps.engine.enqueueEnsureFile(target.id);
    } catch (err) {
      // A full queue, or a song deleted between the decision and the enqueue.
      // Nobody asked for this and nobody is waiting on it: the advance will
      // ask again when it actually needs the file.
      engineLogger.warn({ song: target.id, err: String(err) }, 'could not prefetch the next song');
    }
  });
}
