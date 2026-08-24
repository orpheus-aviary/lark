// "How much room may downloaded audio take on this install?" (N4g, §1.4)
//
// One key in `local_metadata`, beside `device_uuid`, `now_playing_mode`,
// `play_mode` and `naming_mode`, and for the same reason: a PER-INSTALL
// preference, never a fact about the library, so it stays out of
// `sync_changes`. A phone with 12GB free and a laptop with 2TB want different
// answers, and skybridge has no business reconciling them.
//
// WHY THIS EXISTS WHEN THE DESKTOP ALREADY HAS ONE. The desktop's limit is
// `storage.cache_limit_mb` in `lark_config.toml` — a file the phone does not
// have and, per D12, is not getting. The two are the same NUMBER in the same
// unit (MiB, 0 = unlimited) feeding the same `CacheOptions.limitBytes`; what
// differs is only where each host keeps it.
//
// The read path never writes. A value we cannot parse belongs to another build
// of this install, not to us — and a boot path that "fixes" what it cannot read
// is how a downgrade eats a setting.

import type { StructuredLogger } from './logger.js';
import type { SqliteLike } from './sqlite.js';

export const CACHE_LIMIT_KEY = 'cache_limit_mb';

/**
 * Unlimited, which is what a phone nobody has asked means.
 *
 * The same default the desktop config ships, and the same one `runEviction`
 * treats as "do nothing at all": `limitBytes <= 0` returns before it scans a
 * single directory (`library/cache.ts`).
 */
export const DEFAULT_CACHE_LIMIT_MB = 0;

/** Digits only. `12.5`, `-1`, `1e3` and `  12` are all values we did not write. */
const STORED = /^\d+$/;

/**
 * The limit this install is under, in MiB. Missing row and unreadable value
 * both read as unlimited, and neither touches the library.
 */
export function readCacheLimitMb(sqlite: SqliteLike, logger?: StructuredLogger): number {
  const row = sqlite
    .prepare('SELECT value FROM local_metadata WHERE key = ?')
    .get(CACHE_LIMIT_KEY) as { value: string } | undefined;

  if (row === undefined) return DEFAULT_CACHE_LIMIT_MB;
  if (STORED.test(row.value)) {
    const mb = Number(row.value);
    // A number too large to be exact is a number we cannot do arithmetic with,
    // and `limitBytes` multiplies it by a megabyte before anyone compares it.
    if (Number.isSafeInteger(mb)) return mb;
  }

  logger?.warn(
    { key: CACHE_LIMIT_KEY, stored: row.value },
    `local_metadata.${CACHE_LIMIT_KEY} is not a size this build can use — reading it as ${DEFAULT_CACHE_LIMIT_MB} (unlimited)`,
  );
  return DEFAULT_CACHE_LIMIT_MB;
}

/**
 * Set the limit. Upsert, because the row only exists once someone has chosen.
 *
 * It REFUSES rather than clamps: every caller is a settings form that has
 * already parsed what a person typed, and a writer that quietly turned `-1`
 * into `0` would be a settings page that says "unlimited" to somebody who
 * meant something else.
 */
export function writeCacheLimitMb(sqlite: SqliteLike, mb: number): void {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new RangeError(
      `${CACHE_LIMIT_KEY} must be a non-negative whole number of MiB, got ${mb}`,
    );
  }
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(CACHE_LIMIT_KEY, String(mb));
}
