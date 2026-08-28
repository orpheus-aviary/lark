// The same three questions `play-mode.test.ts` asks of its own key: what a
// device that was never asked reads, what round-trips, and what a value this
// build cannot parse does NOT do to what is stored.

import { DEFAULT_SORT, SORT_FIELDS, type SortState } from '@lark/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';
import { DEFAULT_SONG_SORT, SONG_SORT_KEY, readSongSort, writeSongSort } from './song-sort-pref.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (stored: Record<string, string>): DeviceSettingsPort => ({
  get: (key) => stored[key],
  set: () => {
    throw new Error('the read path wrote');
  },
});

describe('the song order this device lists in', () => {
  it('a device that has never been asked gets the order the library came in', () => {
    expect(readSongSort(settings)).toEqual(DEFAULT_SONG_SORT);
    expect(DEFAULT_SONG_SORT).toEqual(DEFAULT_SORT);
  });

  it('round-trips every field, in both directions', async () => {
    for (const field of SORT_FIELDS) {
      for (const order of ['asc', 'desc'] as const) {
        const sort: SortState = { field, order };
        await writeSongSort(settings, sort);
        expect(readSongSort(settings)).toEqual(sort);
      }
    }
  });

  // A build that shipped a fifth field, a hand-edited file, a truncated write.
  it('a value this build cannot parse reads as the default and is left alone', () => {
    for (const junk of ['', 'name', 'name:', ':asc', 'rank:asc', 'name:sideways', 'name:asc:x']) {
      const store = readOnly({ [SONG_SORT_KEY]: junk });
      expect(readSongSort(store)).toEqual(DEFAULT_SONG_SORT);
      expect(store.get(SONG_SORT_KEY)).toBe(junk);
    }
  });
});
