// "Does this install put lyrics in the Now Playing title?" (N2g, decision c)
//
// One key in `local_metadata`, next to `device_uuid` and for the same reason:
// it is a PER-INSTALL preference, not a fact about the library. It therefore
// never enters `sync_changes` — a phone paired to a car stereo and a laptop
// that has never seen Bluetooth want different answers, and skybridge has no
// business reconciling them.
//
// `local_metadata` being a KV log is the whole version strategy: an unknown
// key is ignored, a missing key is the default, and a value whose MEANING
// changes gets a new key rather than a reinterpretation of this one.
//
// The read path never writes. A garbage value is a value we do not understand,
// not a value we are entitled to overwrite — the user may have a newer build
// on another install, and a boot path that "fixes" what it cannot parse is how
// a downgrade eats a setting.

import { type NowPlayingMode, isNowPlayingMode } from '@lark/shared';
import type { StructuredLogger } from './logger.js';
import type { SqliteLike } from './sqlite.js';

export const NOW_PLAYING_MODE_KEY = 'now_playing_mode';

/** Off by default: the feature ships unmeasured (§1.10), so it ships dark. */
export const DEFAULT_NOW_PLAYING_MODE: NowPlayingMode = 'title';

/**
 * The mode this install is in. Missing row or unrecognised value — including
 * the empty string — both read as the default, and neither touches the
 * library.
 */
export function readNowPlayingMode(sqlite: SqliteLike, logger?: StructuredLogger): NowPlayingMode {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(NOW_PLAYING_MODE_KEY) as { value: string } | undefined;

  if (row === undefined) return DEFAULT_NOW_PLAYING_MODE;
  if (isNowPlayingMode(row.value)) return row.value;

  logger?.warn(
    { key: NOW_PLAYING_MODE_KEY, stored: row.value },
    `local_metadata.${NOW_PLAYING_MODE_KEY} is not a mode this build knows — reading it as '${DEFAULT_NOW_PLAYING_MODE}'`,
  );
  return DEFAULT_NOW_PLAYING_MODE;
}

/** Set the mode. Upsert, because the row only exists once someone has chosen. */
export function writeNowPlayingMode(sqlite: SqliteLike, mode: NowPlayingMode): void {
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(NOW_PLAYING_MODE_KEY, mode);
}
