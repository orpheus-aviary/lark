// Criterion 69's storage half (N5b). Whether a login actually refuses is
// `sync/server-url.test.ts`'s job; what is on trial HERE is the switch itself:
// where it lives, what a device that has never been asked reads as, and —
// the part that matters more than anywhere else in this directory — which way
// it falls when it cannot read what it finds.

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';
import {
  DEFAULT_SYNC_ALLOW_INSECURE,
  SYNC_ALLOW_INSECURE_KEY,
  readSyncAllowInsecure,
  writeSyncAllowInsecure,
} from './sync-insecure.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (value: string): DeviceSettingsPort => ({
  get: (key) => (key === SYNC_ALLOW_INSECURE_KEY ? value : undefined),
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

describe('reading the switch', () => {
  it('a device that has never been asked refuses plaintext', () => {
    expect(readSyncAllowInsecure(settings)).toBe(false);
    // Not a decoration: this default is the whole reason the read path is safe
    // to call before anyone has opened the settings page.
    expect(DEFAULT_SYNC_ALLOW_INSECURE).toBe(false);
  });

  it('round-trips both answers', async () => {
    await writeSyncAllowInsecure(settings, true);
    expect(readSyncAllowInsecure(settings)).toBe(true);
    expect(settings.get(SYNC_ALLOW_INSECURE_KEY)).toBe('1');

    await writeSyncAllowInsecure(settings, false);
    expect(readSyncAllowInsecure(settings)).toBe(false);
    // Kept at '0' rather than removed — "somebody turned this off" outlives
    // the absence of a value that cannot tell off from never-asked.
    expect(settings.get(SYNC_ALLOW_INSECURE_KEY)).toBe('0');
  });
});

describe('a value this build did not write', () => {
  // Every one of these is something a future build, a hand-edited file or a
  // half-finished migration could plausibly leave behind. None of them is '1'.
  for (const stored of ['true', 'TRUE', 'yes', '', ' 1', '1 ', '2', '-1', 'on']) {
    it(`refuses plaintext for ${JSON.stringify(stored)}`, () => {
      expect(readSyncAllowInsecure(readOnly(stored), recorder)).toBe(false);
    });
  }

  it('says so rather than swallowing it', () => {
    readSyncAllowInsecure(readOnly('true'), recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ key: SYNC_ALLOW_INSECURE_KEY, stored: 'true' });
  });

  it('does not warn about the two values it does understand', () => {
    expect(readSyncAllowInsecure(readOnly('0'), recorder)).toBe(false);
    expect(readSyncAllowInsecure(readOnly('1'), recorder)).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('never repairs what it cannot read', () => {
    const store = readOnly('true');
    readSyncAllowInsecure(store, recorder);
    // A read that "fixed" this would be a downgrade eating a setting — and in
    // this particular case, a downgrade silently deciding a security question.
    expect(store.get(SYNC_ALLOW_INSECURE_KEY)).toBe('true');
  });
});
