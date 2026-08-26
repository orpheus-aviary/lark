// "How much room may downloaded audio take on this install?" (N4g, §1.4)
//
// A DEVICE setting (N7a): a PER-INSTALL preference, never a fact about any
// library, so it stays out of `sync_changes` — and, since N7 gave one phone
// several libraries, out of the libraries themselves. A phone with 12GB free
// and a laptop with 2TB want different answers, and skybridge has no business
// reconciling them. N7 makes the same point within one device: the limit is
// how much room LARK may take, so it is one number for all its workspaces
// (§2.6), not one per account.
//
// WHY THIS EXISTS WHEN THE DESKTOP ALREADY HAS ONE. The desktop's limit is
// `storage.cache_limit_mb` in `lark_config.toml` — a device-level file the
// phone does not have and, per D12, is not getting. The two are the same
// NUMBER in the same unit (MiB, 0 = unlimited) feeding the same
// `CacheOptions.limitBytes`; what differs is only which device file each host
// keeps it in.
//
// The read path never writes. A value we cannot parse belongs to another build
// of this install, not to us — and a boot path that "fixes" what it cannot read
// is how a downgrade eats a setting.

import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

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
 * The limit this install is under, in MiB. Missing value and unreadable value
 * both read as unlimited, and neither writes anything.
 */
export function readCacheLimitMb(settings: DeviceSettingsPort, logger?: StructuredLogger): number {
  const stored = settings.get(CACHE_LIMIT_KEY);

  if (stored === undefined) return DEFAULT_CACHE_LIMIT_MB;
  if (STORED.test(stored)) {
    const mb = Number(stored);
    // A number too large to be exact is a number we cannot do arithmetic with,
    // and `limitBytes` multiplies it by a megabyte before anyone compares it.
    if (Number.isSafeInteger(mb)) return mb;
  }

  logger?.warn(
    { key: CACHE_LIMIT_KEY, stored },
    `${CACHE_LIMIT_KEY} is not a size this build can use — reading it as ${DEFAULT_CACHE_LIMIT_MB} (unlimited)`,
  );
  return DEFAULT_CACHE_LIMIT_MB;
}

/**
 * Set the limit.
 *
 * It REFUSES rather than clamps: every caller is a settings form that has
 * already parsed what a person typed, and a writer that quietly turned `-1`
 * into `0` would be a settings page that says "unlimited" to somebody who
 * meant something else.
 */
export async function writeCacheLimitMb(settings: DeviceSettingsPort, mb: number): Promise<void> {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new RangeError(
      `${CACHE_LIMIT_KEY} must be a non-negative whole number of MiB, got ${mb}`,
    );
  }
  await settings.set({ [CACHE_LIMIT_KEY]: String(mb) });
}
