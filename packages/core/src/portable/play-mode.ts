// "Which order does this install play in?" (N3b, decision g)
//
// One key in `local_metadata`, beside `device_uuid` and `now_playing_mode` and
// for the same reason: a PER-INSTALL preference, never a fact about the
// library, so it stays out of `sync_changes`. A phone on shuffle and a laptop
// playing a playlist in order are not in disagreement.
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
import type { SqliteLike } from './sqlite.js';

export const PLAY_MODE_KEY = 'play_mode';

/** What a library that has never been asked plays in. */
export const DEFAULT_PLAY_MODE: PlayMode = 'sequential';

export function readPlayMode(sqlite: SqliteLike, logger?: StructuredLogger): PlayMode {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(PLAY_MODE_KEY) as
    | { value: string }
    | undefined;

  if (row === undefined) return DEFAULT_PLAY_MODE;
  if (isPlayMode(row.value)) return row.value;

  logger?.warn(
    { key: PLAY_MODE_KEY, stored: row.value },
    `local_metadata.${PLAY_MODE_KEY} is not a mode this build knows — reading it as '${DEFAULT_PLAY_MODE}'`,
  );
  return DEFAULT_PLAY_MODE;
}

export function writePlayMode(sqlite: SqliteLike, mode: PlayMode): void {
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(PLAY_MODE_KEY, mode);
}
