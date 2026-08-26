// Criterion 104 (N7a). What is on trial is a one-way move: the six settings
// leave the library, nothing else in `local_metadata` is disturbed, and the
// boot after the first one does no work at all.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { CACHE_LIMIT_KEY, readCacheLimitMb } from './cache-limit.js';
import {
  DEVICE_SETTING_KEYS,
  adoptDeviceSettings,
  createMemoryDeviceSettings,
} from './device-settings.js';
import { LLM_MODEL_KEY, LLM_URL_KEY, readLlmEndpoint } from './llm-config.js';
import { PLAY_MODE_KEY, readPlayMode } from './play-mode.js';
import { readSyncAllowInsecure } from './sync-insecure.js';

let sqlite: BetterSqlite3.Database;
/** What a freshly created library already keeps in there, none of it ours. */
let baseline: Record<string, string>;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
  baseline = metadata();
});

afterEach(() => {
  sqlite.close();
});

const put = (key: string, value: string) =>
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);

const metadata = () =>
  Object.fromEntries(
    (
      sqlite.prepare('SELECT key, value FROM local_metadata').all() as {
        key: string;
        value: string;
      }[]
    ).map((row) => [row.key, row.value]),
  );

/** One of each, so "a value one short" is a failure this test can see. */
const ALL: Record<string, string> = {
  cache_limit_mb: '2048',
  llm_url: 'https://example.test/v1',
  llm_model: 'm-1',
  llm_api_format: 'anthropic',
  now_playing_mode: 'lyrics',
  play_mode: 'shuffle',
  naming_mode: 'original',
  sync_allow_insecure: '1',
};

describe('the list itself', () => {
  it('covers the six settings §4 calls the device’s, and nothing else', () => {
    expect([...DEVICE_SETTING_KEYS].sort()).toEqual(Object.keys(ALL).sort());
  });
});

describe('a library that still holds them', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ALL)) put(key, value);
  });

  it('hands every value over, to the byte', async () => {
    const settings = createMemoryDeviceSettings();
    const result = await adoptDeviceSettings(sqlite, settings);

    expect([...result.adopted].sort()).toEqual(Object.keys(ALL).sort());
    for (const [key, value] of Object.entries(ALL)) expect(settings.get(key)).toBe(value);
    // And through the readers, which is what the app actually calls.
    expect(readCacheLimitMb(settings)).toBe(2048);
    expect(readPlayMode(settings)).toBe('shuffle');
    expect(readSyncAllowInsecure(settings)).toBe(true);
    expect(readLlmEndpoint(settings)).toEqual({
      url: 'https://example.test/v1',
      model: 'm-1',
      api_format: 'anthropic',
    });
  });

  it('stops holding them', async () => {
    await adoptDeviceSettings(sqlite, createMemoryDeviceSettings());
    expect(metadata()).toEqual(baseline);
  });

  it('leaves everything that really is the library’s alone', async () => {
    put('device_uuid', 'a-uuid');
    put('skybridge_device_id', 'dev-1');
    put('audio_migration_pending', '0');
    put('last_playback', '{"song_id":"x"}');

    await adoptDeviceSettings(sqlite, createMemoryDeviceSettings());

    expect(metadata()).toEqual({
      ...baseline,
      device_uuid: 'a-uuid',
      skybridge_device_id: 'dev-1',
      audio_migration_pending: '0',
      last_playback: '{"song_id":"x"}',
    });
  });

  it('is not a change anyone syncs', async () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    await adoptDeviceSettings(sqlite, createMemoryDeviceSettings());
    expect(changes()).toBe(before);
  });

  it('does nothing the second time — and the second time is every boot after', async () => {
    const settings = createMemoryDeviceSettings();
    await adoptDeviceSettings(sqlite, settings);

    const again = await adoptDeviceSettings(sqlite, settings);
    expect(again).toEqual({ adopted: [], cleared: 0 });
    for (const [key, value] of Object.entries(ALL)) expect(settings.get(key)).toBe(value);
  });
});

describe('a device that already has an answer', () => {
  it('keeps its own and still clears the rows', async () => {
    put(CACHE_LIMIT_KEY, '2048');
    put(PLAY_MODE_KEY, 'shuffle');
    const settings = createMemoryDeviceSettings({ [CACHE_LIMIT_KEY]: '512' });

    const result = await adoptDeviceSettings(sqlite, settings);

    // The second library this device opens was written by somebody else — a
    // converged restore, or the other account's copy — and the person in front
    // of the phone chose 512.
    expect(settings.get(CACHE_LIMIT_KEY)).toBe('512');
    expect(settings.get(PLAY_MODE_KEY)).toBe('shuffle');
    expect(result.adopted).toEqual([PLAY_MODE_KEY]);
    expect(metadata()).toEqual(baseline);
  });
});

describe('crash between the two stores', () => {
  it('resumes from the file rather than from the rows', async () => {
    put(LLM_URL_KEY, 'https://old.test/v1');
    put(LLM_MODEL_KEY, 'm-old');
    const settings = createMemoryDeviceSettings();

    // The write landed; the delete did not.
    const failing = {
      get: settings.get,
      set: async (entries: Readonly<Record<string, string>>) => {
        await settings.set(entries);
        throw new Error('killed after the file was replaced');
      },
    };
    await expect(adoptDeviceSettings(sqlite, failing)).rejects.toThrow();
    expect(metadata()).toEqual({
      ...baseline,
      llm_url: 'https://old.test/v1',
      llm_model: 'm-old',
    });

    // Next boot: the values are already the device's, so nothing is adopted a
    // second time and the rows finally go.
    const result = await adoptDeviceSettings(sqlite, settings);
    expect(result).toEqual({ adopted: [], cleared: 2 });
    expect(settings.get(LLM_URL_KEY)).toBe('https://old.test/v1');
    expect(metadata()).toEqual(baseline);
  });
});

describe('a library that never held them', () => {
  it('does no work and touches neither store', async () => {
    put('device_uuid', 'a-uuid');
    const settings = createMemoryDeviceSettings();
    expect(await adoptDeviceSettings(sqlite, settings)).toEqual({ adopted: [], cleared: 0 });
    expect(metadata()).toEqual({ ...baseline, device_uuid: 'a-uuid' });
  });
});
