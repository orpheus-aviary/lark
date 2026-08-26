// Criterion 21 (N2g). The Bluetooth behaviour itself is not testable here —
// there is no player and no receiver — so what is on trial is exactly the part
// that can be: where the setting lives, what a device without it reads as, and
// what a value this build does not understand does NOT do to what is stored.

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import type { StructuredLogger } from './logger.js';
import {
  DEFAULT_NOW_PLAYING_MODE,
  NOW_PLAYING_MODE_KEY,
  readNowPlayingMode,
  writeNowPlayingMode,
} from './now-playing-mode.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (value: string): DeviceSettingsPort => ({
  get: (key) => (key === NOW_PLAYING_MODE_KEY ? value : undefined),
  set: () => {
    throw new Error('the read path wrote');
  },
});

const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
const recorder: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: (fields, msg) => {
    warnings.push({ fields, msg });
  },
  error: () => {},
};

beforeEach(() => {
  warnings.length = 0;
});

describe('reading the mode', () => {
  it('a device that has never been asked reads as the default', () => {
    expect(readNowPlayingMode(settings)).toBe(DEFAULT_NOW_PLAYING_MODE);
    expect(DEFAULT_NOW_PLAYING_MODE).toBe('title');
  });

  it('round-trips both modes', async () => {
    await writeNowPlayingMode(settings, 'lyrics');
    expect(readNowPlayingMode(settings)).toBe('lyrics');

    await writeNowPlayingMode(settings, 'title');
    expect(readNowPlayingMode(settings)).toBe('title');
  });
});

describe('a value this build does not understand', () => {
  // The empty string is in here deliberately: it is what a half-written
  // setting looks like, and `''` is falsy in every language a reader might be
  // thinking in when they reach for a shortcut.
  for (const junk of ['', ' lyrics', 'LYRICS', 'lyric', 'true', '1']) {
    it(`reads \`${junk}\` as the default and leaves it alone`, () => {
      const store = readOnly(junk);
      expect(readNowPlayingMode(store, recorder)).toBe(DEFAULT_NOW_PLAYING_MODE);
      // The point of the case: the read path is a read path.
      expect(store.get(NOW_PLAYING_MODE_KEY)).toBe(junk);
    });
  }

  it('says so once, with the value it could not use', () => {
    readNowPlayingMode(readOnly('lyric'), recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: NOW_PLAYING_MODE_KEY, stored: 'lyric' });
  });

  it('stays quiet on the paths that are not surprising', async () => {
    readNowPlayingMode(settings, recorder);
    await writeNowPlayingMode(settings, 'lyrics');
    readNowPlayingMode(settings, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    expect(readNowPlayingMode(readOnly('nonsense'))).toBe(DEFAULT_NOW_PLAYING_MODE);
  });
});
