// N4e-1. The device half of criteria 26–30 needs a phone and a real provider;
// what can be settled here is everything underneath it — where the three
// fields live, what a device that has never been asked reads as, that the
// narrowed `api_format` domain (decision a) is actually narrow, and that a
// save is one act rather than three.

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDeviceSettings } from './device-settings.js';
import {
  DEFAULT_LLM_API_FORMAT,
  LLM_API_FORMAT_KEY,
  LLM_MODEL_KEY,
  LLM_URL_KEY,
  LOCAL_LLM_API_FORMATS,
  readLlmEndpoint,
  writeLlmEndpoint,
} from './llm-config.js';
import type { StructuredLogger } from './logger.js';
import type { DeviceSettingsPort } from './ports/device-settings.js';

let settings: DeviceSettingsPort;

beforeEach(() => {
  settings = createMemoryDeviceSettings();
});

/** A store that fails loudly if a read path writes to it. */
const readOnly = (stored: Record<string, string>): DeviceSettingsPort => ({
  get: (key) => stored[key],
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

describe('reading the endpoint', () => {
  it('a device that has never been asked reads as the empty endpoint', () => {
    expect(readLlmEndpoint(settings)).toEqual({ url: '', model: '', api_format: 'openai' });
    expect(DEFAULT_LLM_API_FORMAT).toBe('openai');
  });

  it('round-trips both formats', async () => {
    for (const api_format of LOCAL_LLM_API_FORMATS) {
      await writeLlmEndpoint(settings, {
        url: 'https://example.test/v1',
        model: 'm-1',
        api_format,
      });
      expect(readLlmEndpoint(settings)).toEqual({
        url: 'https://example.test/v1',
        model: 'm-1',
        api_format,
      });
    }
  });

  it('names the three keys it will always name', async () => {
    await writeLlmEndpoint(settings, { url: 'u', model: 'm', api_format: 'anthropic' });
    expect(settings.get(LLM_URL_KEY)).toBe('u');
    expect(settings.get(LLM_MODEL_KEY)).toBe('m');
    expect(settings.get(LLM_API_FORMAT_KEY)).toBe('anthropic');
  });

  it('reads a half-filled device without inventing the other half', () => {
    expect(readLlmEndpoint(readOnly({ [LLM_URL_KEY]: 'https://example.test/v1' }))).toEqual({
      url: 'https://example.test/v1',
      model: '',
      api_format: 'openai',
    });
  });
});

describe('a format this build does not understand', () => {
  // `''` heads the list on purpose: it is a value the DESKTOP considers valid
  // (follow aviary), and the whole of decision a is that it means nothing here.
  for (const junk of ['', 'OpenAI', ' openai', 'ollama', 'anthropic ', 'true']) {
    it(`reads \`${junk}\` as the default and leaves it alone`, () => {
      const store = readOnly({ [LLM_API_FORMAT_KEY]: junk });
      expect(readLlmEndpoint(store, recorder).api_format).toBe(DEFAULT_LLM_API_FORMAT);
      expect(store.get(LLM_API_FORMAT_KEY)).toBe(junk);
    });
  }

  it('says so once, with the value it could not use', () => {
    readLlmEndpoint(readOnly({ [LLM_API_FORMAT_KEY]: 'ollama' }), recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: LLM_API_FORMAT_KEY, stored: 'ollama' });
  });

  it('stays quiet on the paths that are not surprising', async () => {
    readLlmEndpoint(settings, recorder);
    await writeLlmEndpoint(settings, { url: 'u', model: 'm', api_format: 'anthropic' });
    readLlmEndpoint(settings, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    expect(readLlmEndpoint(readOnly({ [LLM_API_FORMAT_KEY]: 'nonsense' })).api_format).toBe(
      DEFAULT_LLM_API_FORMAT,
    );
  });
});

describe('writing the endpoint', () => {
  it('trims what a keyboard added to the url and the model', async () => {
    await writeLlmEndpoint(settings, {
      url: '  https://example.test/v1  ',
      model: ' m-1 ',
      api_format: 'openai',
    });
    expect(readLlmEndpoint(settings)).toEqual({
      url: 'https://example.test/v1',
      model: 'm-1',
      api_format: 'openai',
    });
  });

  it('stores an emptied field as empty rather than dropping it', async () => {
    await writeLlmEndpoint(settings, { url: 'u', model: 'm', api_format: 'anthropic' });
    await writeLlmEndpoint(settings, { url: '', model: '', api_format: 'openai' });
    expect(readLlmEndpoint(settings)).toEqual({ url: '', model: '', api_format: 'openai' });
    expect(settings.get(LLM_URL_KEY)).toBe('');
    expect(settings.get(LLM_MODEL_KEY)).toBe('');
  });

  it('is all three or none of them — one `set`, which the port makes atomic', async () => {
    const calls: Readonly<Record<string, string>>[] = [];
    const recording: DeviceSettingsPort = {
      get: () => undefined,
      set: async (entries) => {
        calls.push(entries);
      },
    };
    await writeLlmEndpoint(recording, { url: 'u', model: 'm', api_format: 'anthropic' });
    // Three loose writes would be three chances to be interrupted between a new
    // url and an old model — a configuration nobody typed.
    expect(calls).toEqual([
      { [LLM_URL_KEY]: 'u', [LLM_MODEL_KEY]: 'm', [LLM_API_FORMAT_KEY]: 'anthropic' },
    ]);
  });
});
