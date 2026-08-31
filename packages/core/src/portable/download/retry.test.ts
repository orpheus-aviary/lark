// Which failures get another go (0.1.1 ⑧; shared with the desktop 2026-08-31).
//
// 🔴 THE REVERSE HALF IS THE POINT. Too narrow an allowlist and the setting
// does nothing; too wide and lark hammers a dead link three times or walks
// back into risk control — and BOTH are silent. So the eleven codes that must
// NOT be retried are asserted one by one, by name, rather than left to
// whatever the set happens to contain.
//
// It lives here rather than in either front end because both ends read this
// one copy: the phone through `downloads/retry.ts`, the desktop through the
// daemon's `download-retry.ts`.

import { describe, expect, it } from 'vitest';
import { RETRYABLE_CODES, shouldRetry } from './retry.js';

describe('shouldRetry', () => {
  it('retries a deadline — the failure this whole feature is for', () => {
    // 🔴 Until 0.1.1 a transfer that ran out of time reported as
    // INTERNAL_ERROR, so an allowlist would have skipped the commonest
    // failure on a phone and the setting would have done nothing.
    expect(shouldRetry('DOWNLOAD_TIMEOUT', 1, 1)).toBe(true);
  });

  it('retries the transport failures and nothing else', () => {
    for (const code of ['BILIBILI_FAILED', 'PREFLIGHT_TIMEOUT', 'NORMALIZE_FAILED']) {
      expect(shouldRetry(code, 1, 1)).toBe(true);
    }
    for (const code of [
      'BILIBILI_RISK_CONTROL',
      'SOURCE_GONE',
      'INVALID_SOURCE',
      'AUDIO_NOT_AAC',
      'SOURCE_KEY_CONFLICT',
      'NOT_FOUND',
      'LLM_NOT_CONFIGURED',
      'LLM_FAILED',
      'DOWNLOAD_QUEUE_FULL',
      'CACHE_LIMIT',
      'INTERNAL_ERROR',
    ]) {
      expect(shouldRetry(code, 1, 3), code).toBe(false);
    }
  });

  it('never retries risk control — asking again is what caused it', () => {
    expect(RETRYABLE_CODES.has('BILIBILI_RISK_CONTROL')).toBe(false);
  });

  it('never retries a cache-limit refusal — it would defeat the gate', () => {
    // 🔴 The batch stopped BECAUSE there is no room. Retrying by itself walks
    // through the gate that stopped it, which is the one thing 「到上限就停」
    // exists to prevent.
    expect(RETRYABLE_CODES.has('CACHE_LIMIT')).toBe(false);
  });

  it('stops at the limit, and 0 turns it off', () => {
    expect(shouldRetry('DOWNLOAD_TIMEOUT', 1, 0)).toBe(false);
    expect(shouldRetry('DOWNLOAD_TIMEOUT', 2, 1)).toBe(false);
    expect(shouldRetry('DOWNLOAD_TIMEOUT', 3, 3)).toBe(true);
    expect(shouldRetry('DOWNLOAD_TIMEOUT', 4, 3)).toBe(false);
  });

  it('says no to a failure that carried no code at all', () => {
    expect(shouldRetry(null, 1, 3)).toBe(false);
  });
});
