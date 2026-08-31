// Where THIS PHONE keeps the number (0.1.1 ⑧).
//
// The judgement — which codes, how many — moved to `@lark/core/portable`'s
// `download/retry.ts` on 2026-08-31 and is tested there, once, for both ends.
// What is asserted here is the half that is genuinely the phone's: reading and
// writing one key in device settings.

import type { DeviceSettingsPort } from '@lark/core/portable';
import { DEFAULT_RETRY_LIMIT } from '@lark/core/portable';
import { describe, expect, it, vi } from 'vitest';
import { RETRY_LIMIT_KEY, readRetryLimit, writeRetryLimit } from './retry';

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
