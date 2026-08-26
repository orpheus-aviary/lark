// Criterion 105 (N7a): what a missing, empty or corrupt `device.json` reads
// as, which has to be exactly what a missing `local_metadata` row read as
// before it — the default, without a throw and without a repair.
//
// Also the two rules that only exist because this is a FILE and not a table:
// memory follows the disk rather than leading it, and two saves in the same
// breath take turns rather than racing to replace it.

import { readCacheLimitMb, readSyncAllowInsecure } from '@lark/core/portable';
import { describe, expect, it } from 'vitest';
import { createDeviceSettings } from './device-settings';

const stub = (load: () => string | null, save: (text: string) => Promise<void> = async () => {}) =>
  createDeviceSettings({ load, save });

describe('a file this build cannot use', () => {
  const unreadable: Record<string, () => string | null> = {
    'no file at all': () => null,
    empty: () => '',
    whitespace: () => '   \n',
    truncated: () => '{"cache_limit_mb": "20',
    'not an object': () => '"hello"',
    'an array': () => '[{"cache_limit_mb":"2048"}]',
    null: () => 'null',
    'a read that threw': () => {
      throw new Error('EACCES');
    },
  };

  for (const [name, load] of Object.entries(unreadable)) {
    it(`reads ${name} as no settings at all, without throwing`, () => {
      const settings = stub(load);
      expect(settings.get('cache_limit_mb')).toBeUndefined();
      // Through the readers, because "the default" is theirs to define — and
      // the fail-closed one matters most.
      expect(readCacheLimitMb(settings)).toBe(0);
      expect(readSyncAllowInsecure(settings)).toBe(false);
    });
  }

  it('keeps the values it can read and drops only the ones it cannot', () => {
    const settings = stub(() => '{"cache_limit_mb":"2048","play_mode":7,"llm_url":null}');
    expect(settings.get('cache_limit_mb')).toBe('2048');
    expect(settings.get('play_mode')).toBeUndefined();
    expect(settings.get('llm_url')).toBeUndefined();
  });

  it('never repairs the file on its own — reading is reading', async () => {
    let saves = 0;
    const settings = stub(
      () => 'not json',
      async () => {
        saves += 1;
      },
    );
    settings.get('cache_limit_mb');
    readCacheLimitMb(settings);
    expect(saves).toBe(0);
  });
});

describe('a file this build wrote', () => {
  it('reads back what is in it', () => {
    const settings = stub(() => JSON.stringify({ cache_limit_mb: '512', play_mode: 'shuffle' }));
    expect(readCacheLimitMb(settings)).toBe(512);
    expect(settings.get('play_mode')).toBe('shuffle');
  });

  it('writes the whole file, merged, and reads back what it wrote', async () => {
    const written: string[] = [];
    const settings = stub(
      () => '{"play_mode":"shuffle"}',
      async (text) => {
        written.push(text);
      },
    );
    await settings.set({ cache_limit_mb: '512' });

    expect(JSON.parse(written[0] as string)).toEqual({
      play_mode: 'shuffle',
      cache_limit_mb: '512',
    });
    expect(settings.get('play_mode')).toBe('shuffle');
    expect(settings.get('cache_limit_mb')).toBe('512');
  });
});

describe('when the disk says no', () => {
  it('rejects, and memory still says what is actually on disk', async () => {
    const settings = stub(
      () => '{"cache_limit_mb":"100"}',
      async () => {
        throw new Error('ENOSPC');
      },
    );
    await expect(settings.set({ cache_limit_mb: '512' })).rejects.toThrow('ENOSPC');
    // The settings page reads back after a save. Showing 512 here would be a
    // form reporting a success that will be gone at the next launch.
    expect(settings.get('cache_limit_mb')).toBe('100');
  });

  it('does not poison the next save', async () => {
    let fail = true;
    const settings = stub(
      () => null,
      async () => {
        if (fail) throw new Error('ENOSPC');
      },
    );
    await expect(settings.set({ play_mode: 'shuffle' })).rejects.toThrow();
    fail = false;
    await settings.set({ play_mode: 'repeat-one' });
    expect(settings.get('play_mode')).toBe('repeat-one');
  });
});

describe('two saves in the same breath', () => {
  it('take turns, and neither one loses its key', async () => {
    const written: string[] = [];
    let release!: () => void;
    // Held open until both saves have been asked for, so the first is still in
    // flight when the second arrives. Without a queue the second would land
    // first, and land WITHOUT the first one's key.
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstSave = true;
    const settings = stub(
      () => null,
      async (text) => {
        if (firstSave) {
          firstSave = false;
          await held;
        }
        written.push(text);
      },
    );

    const first = settings.set({ llm_url: 'https://example.test/v1' });
    const second = settings.set({ llm_model: 'm-1' });
    release();
    await Promise.all([first, second]);

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] as string)).toEqual({ llm_url: 'https://example.test/v1' });
    // The second write is built on the first's result, not on the state that
    // was current when it was asked for.
    expect(JSON.parse(written[1] as string)).toEqual({
      llm_url: 'https://example.test/v1',
      llm_model: 'm-1',
    });
  });
});
