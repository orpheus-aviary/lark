// Which failures are worth trying again by themselves (0.1.1 ⑧).
//
// 🔴 THE ALLOWLIST IS THE WHOLE FEATURE, and getting it wrong is silent in
// both directions. Too narrow and the setting does nothing — which is what
// this batch nearly shipped: a transfer that ran out of time used to report as
// `INTERNAL_ERROR`, so "retry the network failures" would have skipped THE
// most common failure on a phone (fixed in `portable/download/task-data.ts`).
// Too wide and lark hammers a dead link three times, or walks straight back
// into bilibili's risk control.
//
// The question each entry answers is not "was this the network" but "could
// asking again produce a different answer":
//
//   `DOWNLOAD_TIMEOUT`   a deadline expired. A phone on a train is the case
//                        this whole feature exists for.
//   `BILIBILI_FAILED`    the transport to bilibili, or a stream that ended
//                        early — `ports/audio-landing.ts` raises it for both.
//   `PREFLIGHT_TIMEOUT`  the pre-enqueue checks blew their budget.
//   `NORMALIZE_FAILED`   a short link would not expand, which is one fetch.
//
// And the ones deliberately left out, each for its own reason:
//
//   `BILIBILI_RISK_CONTROL`  asking again is what caused it.
//   `SOURCE_GONE`            the video is not there. Three times is still not.
//   `INVALID_SOURCE` · `AUDIO_NOT_AAC` · `SOURCE_KEY_CONFLICT` · `NOT_FOUND`
//                            facts about the request, not about the moment.
//   `LLM_NOT_CONFIGURED`     nothing changes until somebody fills in 设置.
//   `LLM_FAILED`             network, yes — but somebody else's, and a model
//                            that refused once usually refuses three times
//                            while charging for each. 重下 is still there.
//   `DOWNLOAD_QUEUE_FULL`    a full queue does not empty because we asked.
//   `INTERNAL_ERROR`         by definition nobody knows what it was.
//
// NO BACKOFF, and that is a decision rather than an omission: a delay would be
// a JS timer, and those are frozen while the screen is off (`docs/INVARIANTS`
// §6) — a "retry in 30 seconds" scheduled as the phone goes into a pocket is a
// retry that happens when somebody next looks at it. Immediate, N times, done.

import type { DeviceSettingsPort, StructuredLogger } from '@lark/core/portable';

export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'DOWNLOAD_TIMEOUT',
  'BILIBILI_FAILED',
  'PREFLIGHT_TIMEOUT',
  'NORMALIZE_FAILED',
]);

/** How many EXTRA attempts a failure gets. `0` turns the feature off. */
export const RETRY_LIMITS = [0, 1, 2, 3] as const;
export type RetryLimit = (typeof RETRY_LIMITS)[number];

/**
 * One extra attempt by default.
 *
 * The failure this is for is a phone that lost its connection for a moment,
 * and one more go answers that. Somebody who wants three can say so; nobody
 * has to discover the setting to get the common case.
 */
export const DEFAULT_RETRY_LIMIT: RetryLimit = 1;

export const RETRY_LIMIT_KEY = 'download_retry_limit';

/**
 * Whether this failure gets another go.
 *
 * `attempts` counts the tries ALREADY MADE, the first one included — so a
 * limit of 1 means "one retry", not "one attempt".
 */
export function shouldRetry(code: string | null, attempts: number, limit: number): boolean {
  if (code === null || !RETRYABLE_CODES.has(code)) return false;
  return attempts <= limit;
}

/** The limit this install is under. An unreadable value reads as the default. */
export function readRetryLimit(settings: DeviceSettingsPort, logger?: StructuredLogger): number {
  const stored = settings.get(RETRY_LIMIT_KEY);
  if (stored === undefined) return DEFAULT_RETRY_LIMIT;
  const value = Number(stored);
  if (RETRY_LIMITS.some((limit) => limit === value)) return value;
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
  if (!RETRY_LIMITS.some((allowed) => allowed === limit)) {
    throw new RangeError(
      `${RETRY_LIMIT_KEY} must be one of ${RETRY_LIMITS.join('/')}, got ${limit}`,
    );
  }
  await settings.set({ [RETRY_LIMIT_KEY]: String(limit) });
}
