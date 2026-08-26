// "Which order does this install play in?" (N3b, decision g)
//
// A DEVICE setting (N7a): a per-install preference, never a fact about any
// library, so it stays out of `sync_changes` — and, since N7, out of the
// libraries themselves. A phone on shuffle and a laptop playing a playlist in
// order are not in disagreement, and neither are two accounts on one phone.
//
// It lived in `local_metadata` until N7a, back when a library was the only
// thing this host could write to; `ports/device-settings.ts` says why that
// stopped being true.
//
// The desktop keeps its own adapter (localStorage, `stores/player.ts`) — the
// decision n split from N2f, where `song-sort`'s comparators are shared and
// each front end persists the choice its own way. What must NOT differ is the
// meaning of the four values, and that lives in `@lark/shared`.
//
// Read path never writes: a value we cannot parse belongs to another build of
// this install, not to us.

import { type PlayMode, isPlayMode } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

export const PLAY_MODE_KEY = 'play_mode';

/** What an install that has never been asked plays in. */
export const DEFAULT_PLAY_MODE: PlayMode = 'sequential';

export function readPlayMode(settings: DeviceSettingsPort, logger?: StructuredLogger): PlayMode {
  const stored = settings.get(PLAY_MODE_KEY);

  if (stored === undefined) return DEFAULT_PLAY_MODE;
  if (isPlayMode(stored)) return stored;

  logger?.warn(
    { key: PLAY_MODE_KEY, stored },
    `${PLAY_MODE_KEY} is not a mode this build knows — reading it as '${DEFAULT_PLAY_MODE}'`,
  );
  return DEFAULT_PLAY_MODE;
}

export function writePlayMode(settings: DeviceSettingsPort, mode: PlayMode): Promise<void> {
  return settings.set({ [PLAY_MODE_KEY]: mode });
}
