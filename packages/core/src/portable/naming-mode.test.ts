// Criterion 24 (N4d), the half that does not need a phone: where the choice
// lives, what an install that has never chosen opens on, and what a value this
// build does not understand does NOT do to what is stored.
//
// The other half — that it survives a cold start — is the device's, because
// what it is really testing there is that the file on disk is the same one the
// next process reads.

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import type { StructuredLogger } from './logger.js';
import {
  NAMING_MODE_KEY,
  readNamingMode,
  resolveNamingMode,
  writeNamingMode,
} from './naming-mode.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (value: string): DeviceSettingsPort => ({
  get: (key) => (key === NAMING_MODE_KEY ? value : undefined),
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

describe('remembering the choice', () => {
  it('an install that has never chosen says so, rather than guessing', () => {
    expect(readNamingMode(settings)).toBeNull();
  });

  it('round-trips both modes', async () => {
    await writeNamingMode(settings, 'clean');
    expect(readNamingMode(settings)).toBe('clean');

    await writeNamingMode(settings, 'original');
    expect(readNamingMode(settings)).toBe('original');
  });
});

describe('a value this build does not understand', () => {
  for (const junk of ['', ' clean', 'CLEAN', 'cleaned', 'true', '1']) {
    it(`reads \`${junk}\` as "never chosen" and leaves it alone`, () => {
      const store = readOnly(junk);
      expect(readNamingMode(store, recorder)).toBeNull();
      // The point of the case: the read path is a read path.
      expect(store.get(NAMING_MODE_KEY)).toBe(junk);
    });
  }

  it('says so once, with the value it could not use', () => {
    readNamingMode(readOnly('cleaned'), recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: NAMING_MODE_KEY, stored: 'cleaned' });
  });

  it('stays quiet on the paths that are not surprising', async () => {
    readNamingMode(settings, recorder);
    await writeNamingMode(settings, 'clean');
    readNamingMode(settings, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    expect(readNamingMode(readOnly('nonsense'))).toBeNull();
  });
});

describe('resolveNamingMode (decision f)', () => {
  it('opens on `original` where there is no model to run `clean`', () => {
    expect(resolveNamingMode({ remembered: null, hasLlm: false })).toBe('original');
  });

  it('opens on `clean` where there is one — the desktop default, earned', () => {
    expect(resolveNamingMode({ remembered: null, hasLlm: true })).toBe('clean');
  });

  it('lets a remembered choice win over both', () => {
    expect(resolveNamingMode({ remembered: 'original', hasLlm: true })).toBe('original');
    expect(resolveNamingMode({ remembered: 'clean', hasLlm: false })).toBe('clean');
  });

  it('does not quietly move a remembered `clean` when the model goes away', () => {
    // The form disables the chip and says why; moving the choice on the user's
    // behalf would hide that the model, not the preference, is what changed.
    expect(resolveNamingMode({ remembered: 'clean', hasLlm: false })).not.toBe('original');
  });
});
