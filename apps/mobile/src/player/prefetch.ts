// Which song to fetch BEFORE it is needed (0.1.1 ⑥).
//
// 🔑 IT ASKS `decideNext`, and that is the whole design. The song to fetch
// early is by definition the song that will play next, so working it out a
// second way here would eventually fetch one song and play another — and the
// symptom of that is not an error, it is a wait that the prefetch was supposed
// to remove, on a phone, once in a while.
//
// TWO MODES ANSWER `null` FOR REASONS THAT ARE NOT "off":
//
//   `shuffle`     the next song is drawn when the current one ends. There is
//                 nothing to fetch early — a guess would be right one time in
//                 N and spend the data every time.
//   `repeat-one`  there is no next song.
//
// AND IT ONLY EVER LOOKS ONE AHEAD. Two would double the data spent on a
// guess, and the second guess is only as good as the first one being right.

import type { PlayMode, SongData } from '@lark/shared';
import { decideNext } from '@lark/shared';

export interface PrefetchInput {
  /** The queue as the library has it now. */
  songs: readonly SongData[];
  currentId: string | null;
  mode: PlayMode;
  /** 「自动下载下一首」. Off means there is nothing to prepare for. */
  enabled: boolean;
}

export function songToPrefetch(input: PrefetchInput): SongData | null {
  if (!input.enabled) return null;
  if (input.mode === 'shuffle' || input.mode === 'repeat-one') return null;

  const decision = decideNext({
    songs: input.songs,
    currentId: input.currentId,
    mode: input.mode,
    // The question is what will happen when this song RUNS OUT, which is the
    // only moment a prefetch is for — and with the setting on, by definition.
    trigger: 'ended',
    fetchWhenEnded: true,
  });
  if (decision.kind !== 'play') return null;

  const song = input.songs.find((candidate) => candidate.id === decision.songId);
  if (song === undefined) return null;
  // Already here, or nothing to fetch it from (an imported file has no key).
  if (song.has_file !== false || song.source_key === null) return null;
  return song;
}
