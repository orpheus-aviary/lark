// Which failures are worth trying again by themselves (0.1.1 ⑧).
//
// 🔴 BOTH ENDS READ THIS ONE COPY (2026-08-31 对齐). It was the phone's alone
// until the desktop grew the same feature, and an allowlist that exists twice
// is an allowlist that will say different things — the failure mode being
// silent in both directions (below). WHAT differs per host is only the NUMBER:
// the phone keeps it in device settings, the desktop in `[download]
// retry_limit`. The judgement is here.
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
//   `CACHE_LIMIT`            🔴 the one that would defeat its own feature: a
//                            batch stopped BECAUSE there is no room, and an
//                            automatic retry would walk straight through the
//                            gate that stopped it. Going past the limit is a
//                            person's decision (⑤), taken by tapping 重下.
//   `INTERNAL_ERROR`         by definition nobody knows what it was.
//
// NO BACKOFF, and that is a decision rather than an omission: a delay would be
// a JS timer, and those are frozen while the screen is off (`docs/INVARIANTS`
// §6) — a "retry in 30 seconds" scheduled as the phone goes into a pocket is a
// retry that happens when somebody next looks at it. Immediate, N times, done.
// The desktop inherits it rather than re-deciding: the same failure wants the
// same answer, and a laptop that shut its lid is the phone in a pocket.
//
// LYRICS ARE NEVER RETRIED AUTOMATICALLY, and that rule is not here because
// it is about the task rather than the code: the engine spawns a lyrics task
// after every download, nobody asked for it on its own, and hammering three
// providers for every failed fetch is a cost with no consumer. It is enforced
// where the task is known — `DownloadEngine.enqueueRetry`.

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
 * The failure this is for is a connection that dropped for a moment, and one
 * more go answers that. Somebody who wants three can say so; nobody has to
 * discover the setting to get the common case.
 */
export const DEFAULT_RETRY_LIMIT: RetryLimit = 1;

/** Whether `value` is a count this build offers, for hosts reading it off disk. */
export function isRetryLimit(value: unknown): value is RetryLimit {
  return RETRY_LIMITS.some((limit) => limit === value);
}

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
