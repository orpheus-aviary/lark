// How many extra attempts THIS PHONE gives a failure (0.1.1 ⑧).
//
// 🔴 WHICH failures are worth another go is no longer here — it is
// `@lark/core/portable`'s `download/retry.ts`, shared with the desktop since
// 2026-08-31. An allowlist that exists twice is an allowlist that will say
// different things, and getting it wrong is silent in both directions (that
// module's header says how). What is left in this file is the one thing that
// genuinely differs per host: where the NUMBER is kept. On a phone that is
// device settings; on the desktop it is `[download] retry_limit` in the config
// file, which is also why neither end can own the judgement.

import {
  DEFAULT_RETRY_LIMIT,
  type DeviceSettingsPort,
  RETRY_LIMITS,
  type RetryLimit,
  type StructuredLogger,
  isRetryLimit,
} from '@lark/core/portable';

export const RETRY_LIMIT_KEY = 'download_retry_limit';

/** The limit this install is under. An unreadable value reads as the default. */
export function readRetryLimit(settings: DeviceSettingsPort, logger?: StructuredLogger): number {
  const stored = settings.get(RETRY_LIMIT_KEY);
  if (stored === undefined) return DEFAULT_RETRY_LIMIT;
  const value = Number(stored);
  if (isRetryLimit(value)) return value;
  logger?.warn(
    { key: RETRY_LIMIT_KEY, stored },
    `${RETRY_LIMIT_KEY} is not a count this build offers — reading it as ${DEFAULT_RETRY_LIMIT}`,
  );
  return DEFAULT_RETRY_LIMIT;
}

/** Set the limit. Refuses anything not on the menu, rather than clamping. */
export async function writeRetryLimit(
  settings: DeviceSettingsPort,
  limit: RetryLimit,
): Promise<void> {
  if (!isRetryLimit(limit)) {
    throw new RangeError(
      `${RETRY_LIMIT_KEY} must be one of ${RETRY_LIMITS.join('/')}, got ${limit}`,
    );
  }
  await settings.set({ [RETRY_LIMIT_KEY]: String(limit) });
}
