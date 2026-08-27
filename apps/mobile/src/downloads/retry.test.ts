import type { DeviceSettingsPort } from '@lark/core/portable';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_LIMIT,
  RETRYABLE_CODES,
  RETRY_LIMIT_KEY,
  readRetryLimit,
  shouldRetry,
  writeRetryLimit,
} from './retry';

const settings = (stored?: string): DeviceSettingsPort & { written: Record<string, string>[] } => {
  const written: Record<string, string>[] = [];
  return {
    get: () => stored,
    set: async (entries) => {
      written.push(entries as Record<string, string>);
    },
    written,
  };
};

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
      'INTERNAL_ERROR',
    ]) {
      expect(shouldRetry(code, 1, 3), code).toBe(false);
    }
  });

  it('never retries risk control — asking again is what caused it', () => {
    expect(RETRYABLE_CODES.has('BILIBILI_RISK_CONTROL')).toBe(false);
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

describe('the setting', () => {
  it('is one retry until somebody says otherwise', () => {
    expect(readRetryLimit(settings())).toBe(DEFAULT_RETRY_LIMIT);
  });

  it('reads back what was stored', () => {
    expect(readRetryLimit(settings('3'))).toBe(3);
    expect(readRetryLimit(settings('0'))).toBe(0);
  });

  it('reads a value it does not offer as the default, and says so', () => {
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    expect(readRetryLimit(settings('99'), logger)).toBe(DEFAULT_RETRY_LIMIT);
    expect(readRetryLimit(settings('nope'), logger)).toBe(DEFAULT_RETRY_LIMIT);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('refuses a count that is not on the menu rather than clamping it', async () => {
    await expect(writeRetryLimit(settings(), 7 as 3)).rejects.toBeInstanceOf(RangeError);
  });

  it('writes the one key it owns', async () => {
    const port = settings();
    await writeRetryLimit(port, 2);
    expect(port.written).toEqual([{ [RETRY_LIMIT_KEY]: '2' }]);
  });
});
