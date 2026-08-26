// "Does this install put lyrics in the Now Playing title?" (N2g, decision c)
//
// A DEVICE setting (N7a): a per-install preference, not a fact about any
// library. It therefore never enters `sync_changes` — a phone paired to a car
// stereo and a laptop that has never seen Bluetooth want different answers,
// and skybridge has no business reconciling them — and since N7 it does not
// live in a library either, because one phone now has several and a switch
// that changed with the active account would be a switch nobody touched.
//
// The store being a string KV is the whole version strategy: an unknown key is
// ignored, a missing key is the default, and a value whose MEANING changes
// gets a new key rather than a reinterpretation of this one.
//
// The read path never writes. A garbage value is a value we do not understand,
// not a value we are entitled to overwrite — the user may have a newer build
// on another install, and a boot path that "fixes" what it cannot parse is how
// a downgrade eats a setting.

import { type NowPlayingMode, isNowPlayingMode } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

export const NOW_PLAYING_MODE_KEY = 'now_playing_mode';

/** Off by default: the feature ships unmeasured (§1.10), so it ships dark. */
export const DEFAULT_NOW_PLAYING_MODE: NowPlayingMode = 'title';

/**
 * The mode this install is in. Missing value or unrecognised one — including
 * the empty string — both read as the default, and neither writes anything.
 */
export function readNowPlayingMode(
  settings: DeviceSettingsPort,
  logger?: StructuredLogger,
): NowPlayingMode {
  const stored = settings.get(NOW_PLAYING_MODE_KEY);

  if (stored === undefined) return DEFAULT_NOW_PLAYING_MODE;
  if (isNowPlayingMode(stored)) return stored;

  logger?.warn(
    { key: NOW_PLAYING_MODE_KEY, stored },
    `${NOW_PLAYING_MODE_KEY} is not a mode this build knows — reading it as '${DEFAULT_NOW_PLAYING_MODE}'`,
  );
  return DEFAULT_NOW_PLAYING_MODE;
}

/** Set the mode. */
export function writeNowPlayingMode(
  settings: DeviceSettingsPort,
  mode: NowPlayingMode,
): Promise<void> {
  return settings.set({ [NOW_PLAYING_MODE_KEY]: mode });
}
