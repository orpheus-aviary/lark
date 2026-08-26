// Criterion 50 (N4g-1). The cache behaviour itself is on trial elsewhere
// (`library/cache.test.ts` owns eviction, and the phone owns whether a limit
// somebody typed reaches it) — what is on trial HERE is the storage shape the
// siblings share: where the number lives, what a device that has never been
// asked reads as, and what a value this build cannot use does NOT do.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_LIMIT_KEY,
  DEFAULT_CACHE_LIMIT_MB,
  readCacheLimitMb,
  writeCacheLimitMb,
} from './cache-limit.js';
import { createMemoryDeviceSettings } from './device-settings.js';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (value: string): DeviceSettingsPort => ({
  get: (key) => (key === CACHE_LIMIT_KEY ? value : undefined),
  set: () => {
    throw new Error('the read path wrote');
  },
});

const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
const recorder: StructuredLogger = {
  debug: () => {},
  info: () => {},
  warn: (fields, msg) => {
    warnings.push({ fields, msg });
  },
  error: () => {},
};

beforeEach(() => {
  warnings.length = 0;
});

describe('reading the limit', () => {
  it('a device that has never been asked is unlimited', () => {
    expect(readCacheLimitMb(settings)).toBe(DEFAULT_CACHE_LIMIT_MB);
    // 0 is not a decoration: `runEviction` returns before it scans anything.
    expect(DEFAULT_CACHE_LIMIT_MB).toBe(0);
  });

  it('round-trips a number', async () => {
    await writeCacheLimitMb(settings, 2048);
    expect(readCacheLimitMb(settings)).toBe(2048);

    await writeCacheLimitMb(settings, 512);
    expect(readCacheLimitMb(settings)).toBe(512);
  });

  it('takes 0 back as a real choice — "unlimited" is a setting, not a gap', async () => {
    await writeCacheLimitMb(settings, 100);
    await writeCacheLimitMb(settings, 0);
    expect(readCacheLimitMb(settings)).toBe(0);
    expect(settings.get(CACHE_LIMIT_KEY)).toBe('0');
  });
});

describe('a value this build cannot use', () => {
  // `12.5` and `1e3` are in here deliberately: both are numbers a careless
  // writer could have produced, and neither is a value this one ever writes.
  for (const junk of ['', ' 100', '100 ', '12.5', '-1', '1e3', 'lots', '99999999999999999999']) {
    it(`reads \`${junk}\` as unlimited and leaves it alone`, () => {
      const store = readOnly(junk);
      expect(readCacheLimitMb(store, recorder)).toBe(DEFAULT_CACHE_LIMIT_MB);
      // The point of the case: the read path is a read path.
      expect(store.get(CACHE_LIMIT_KEY)).toBe(junk);
    });
  }

  it('says so, with the value it could not use', () => {
    readCacheLimitMb(readOnly('12.5'), recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: CACHE_LIMIT_KEY, stored: '12.5' });
  });

  it('stays quiet on the paths that are not surprising', async () => {
    readCacheLimitMb(settings, recorder);
    await writeCacheLimitMb(settings, 1);
    readCacheLimitMb(settings, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    expect(readCacheLimitMb(readOnly('nonsense'))).toBe(DEFAULT_CACHE_LIMIT_MB);
  });
});

describe('writing', () => {
  it('refuses what a settings form should never have sent', async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      await expect(writeCacheLimitMb(settings, bad)).rejects.toThrow(RangeError);
    }
    // Refused means refused: nothing was stored on the way to the throw.
    expect(settings.get(CACHE_LIMIT_KEY)).toBeUndefined();
  });
});
