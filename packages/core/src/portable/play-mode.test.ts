// Decision g, and the same three questions `now-playing-mode.test.ts` asks of
// its own key: where it lives, what a device without it reads as, and what a
// value this build cannot parse does NOT do to what is stored.

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import { DEFAULT_PLAY_MODE, PLAY_MODE_KEY, readPlayMode, writePlayMode } from './play-mode.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

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

describe('the play mode', () => {
  it('a device that has never been asked plays in order', () => {
    expect(readPlayMode(settings)).toBe('sequential');
    expect(DEFAULT_PLAY_MODE).toBe('sequential');
  });

  it('round-trips all four', async () => {
    for (const mode of ['shuffle', 'repeat-one', 'repeat-all', 'sequential'] as const) {
      await writePlayMode(settings, mode);
      expect(readPlayMode(settings)).toBe(mode);
    }
  });

  it('a value this build cannot parse reads as the default and is left alone', () => {
    for (const junk of ['', 'SHUFFLE', 'repeat', 'random', '1']) {
      const store = readOnly({ [PLAY_MODE_KEY]: junk });
      expect(readPlayMode(store)).toBe(DEFAULT_PLAY_MODE);
      expect(store.get(PLAY_MODE_KEY)).toBe(junk);
    }
  });
});
