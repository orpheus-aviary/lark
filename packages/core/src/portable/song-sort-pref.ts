// "Which order does this install list songs in?" (0.5.0，用户上手后提的)
//
// A DEVICE setting, on the same terms as `play-mode.ts` beside it: a phone
// sorted by 创建时间 and a laptop sorted by 歌名 are not in disagreement, and
// two accounts on one phone are not either. So it never reaches a library and
// never reaches `sync_changes`.
//
// 🔴 THE COMPARATORS ARE SHARED, THE PERSISTENCE IS NOT — decision n, again.
// `@lark/shared`'s `song-sort.ts` says what each order MEANS so that a library
// reads the same way in a pocket as on a desk; where the choice is remembered
// is each front end's own business, and the desktop already had localStorage
// (`stores/view-prefs.ts`). The phone had nowhere, so it forgot on every
// launch — which is what this file is for.
//
// STORED AS `field:order`, not JSON: the port is a string KV, and a hand-
// editable pair needs no parser that can throw. Read path never writes, so a
// value from another build survives being read by this one.

import { type SortState, isValidSort } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

export const SONG_SORT_KEY = 'song_sort';

/** What an install that has never been asked shows: the order it came in. */
export const DEFAULT_SONG_SORT: SortState = { field: 'default', order: 'asc' };

export function readSongSort(settings: DeviceSettingsPort, logger?: StructuredLogger): SortState {
  const stored = settings.get(SONG_SORT_KEY);
  if (stored === undefined) return DEFAULT_SONG_SORT;

  // Exactly two parts. A third one means the value was written by something
  // that means more by it than this build does, and the rule for that is a new
  // key — not this one read as a prefix of itself.
  const parts = stored.split(':');
  const parsed = { field: parts[0], order: parts[1] };
  if (parts.length === 2 && isValidSort(parsed)) return parsed;

  logger?.warn(
    { key: SONG_SORT_KEY, stored },
    `${SONG_SORT_KEY} is not an order this build knows — reading it as the default`,
  );
  return DEFAULT_SONG_SORT;
}

export function writeSongSort(settings: DeviceSettingsPort, sort: SortState): Promise<void> {
  return settings.set({ [SONG_SORT_KEY]: `${sort.field}:${sort.order}` });
}
