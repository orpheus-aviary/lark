// The queue is a SNAPSHOT of what was playing, not of what is on screen
// (N3c, decision o).
//
// The desktop's queue is its current view: change playlist and the queue
// changes under you, which is why it needs D11 at all. A phone cannot borrow
// that — switching tabs is what phones are for, and the queue panel's "第 3 /
// 7 首" would mean "third of whatever you are looking at" rather than "third
// of what is playing".
//
// IDS, NOT ROWS. A renamed song shows its new name because the panel reads the
// library through these ids; a deleted song simply stops being in the answer,
// instead of sitting in the queue as a line that plays nothing.

import type { QueueSource } from '@lark/core/portable';
import type { SongData } from '@lark/shared';

// `QueueSource` is defined next to the thing that PERSISTS it
// (`portable/last-playback.ts`), not here. Two structurally identical
// definitions would drift the day one of them grew a third kind.
export type { QueueSource };

export interface PlayQueue {
  source: QueueSource;
  /** The order at the moment play started, sort and all. */
  songIds: readonly string[];
}

export function queueFrom(source: QueueSource, songs: readonly SongData[]): PlayQueue {
  return { source, songIds: songs.map((song) => song.id) };
}

/**
 * The queue's songs as the library has them RIGHT NOW, in queue order.
 *
 * Ids the library no longer knows are dropped rather than replaced with a
 * placeholder: "this song is gone" and "this song is here but unplayable"
 * are different things, and the second one already has a representation
 * (`has_file === false`).
 */
export function resolveQueue(queue: PlayQueue, known: readonly SongData[]): readonly SongData[] {
  const byId = new Map(known.map((song) => [song.id, song]));
  const resolved: SongData[] = [];
  for (const id of queue.songIds) {
    const song = byId.get(id);
    if (song !== undefined) resolved.push(song);
  }
  return resolved;
}
