// N4e-1. The device half of criteria 26–30 needs a phone and a real provider;
// what can be settled here is everything underneath it — where the three
// fields live, what a library that has never been asked reads as, that the
// narrowed `api_format` domain (decision a) is actually narrow, and that a
// save is one act rather than three.

import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import {
  DEFAULT_LLM_API_FORMAT,
  LLM_API_FORMAT_KEY,
  LLM_MODEL_KEY,
  LLM_URL_KEY,
  LOCAL_LLM_API_FORMATS,
  type LlmEndpoint,
  readLlmEndpoint,
  writeLlmEndpoint,
} from './llm-config.js';
import type { StructuredLogger } from './logger.js';

let sqlite: BetterSqlite3.Database;

beforeEach(() => {
  ({ sqlite } = createDatabase({ dbPath: ':memory:' }));
});

afterEach(() => {
  sqlite.close();
});

const KEYS = [LLM_URL_KEY, LLM_MODEL_KEY, LLM_API_FORMAT_KEY];

const rows = () =>
  sqlite
    .prepare('SELECT key, value FROM local_metadata WHERE key IN (?, ?, ?) ORDER BY key')
    .all(...KEYS) as { key: string; value: string }[];

const put = (key: string, value: string) =>
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);

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
  it('a library that has never been asked reads as the empty endpoint', () => {
    expect(rows()).toHaveLength(0);
    expect(readLlmEndpoint(sqlite)).toEqual({ url: '', model: '', api_format: 'openai' });
    expect(DEFAULT_LLM_API_FORMAT).toBe('openai');
  });

  it('round-trips both formats through three rows', () => {
    for (const api_format of LOCAL_LLM_API_FORMATS) {
      writeLlmEndpoint(sqlite, { url: 'https://example.test/v1', model: 'm-1', api_format });
      expect(readLlmEndpoint(sqlite)).toEqual({
        url: 'https://example.test/v1',
        model: 'm-1',
        api_format,
      });
    }
    // Upsert, not append: a setting with two values is a setting with none.
    expect(rows()).toHaveLength(3);
  });

  it('names the three keys it will always name', () => {
    writeLlmEndpoint(sqlite, { url: 'u', model: 'm', api_format: 'anthropic' });
    expect(rows()).toEqual([
      { key: 'llm_api_format', value: 'anthropic' },
      { key: 'llm_model', value: 'm' },
      { key: 'llm_url', value: 'u' },
    ]);
  });

  it('reads a half-filled library without inventing the other half', () => {
    put(LLM_URL_KEY, 'https://example.test/v1');
    expect(readLlmEndpoint(sqlite)).toEqual({
      url: 'https://example.test/v1',
      model: '',
      api_format: 'openai',
    });
  });

  it('survives a reopen — this is the library, not process state', () => {
    writeLlmEndpoint(sqlite, {
      url: 'https://example.test/v1',
      model: 'm-1',
      api_format: 'openai',
    });
    expect(
      sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(LLM_MODEL_KEY),
    ).toEqual({ value: 'm-1' });
  });
});

describe('a format this build does not understand', () => {
  // `''` heads the list on purpose: it is a value the DESKTOP considers valid
  // (follow aviary), and the whole of decision a is that it means nothing here.
  for (const junk of ['', 'OpenAI', ' openai', 'ollama', 'anthropic ', 'true']) {
    it(`reads \`${junk}\` as the default and leaves the row alone`, () => {
      put(LLM_API_FORMAT_KEY, junk);
      expect(readLlmEndpoint(sqlite, recorder).api_format).toBe(DEFAULT_LLM_API_FORMAT);
      expect(rows()).toEqual([{ key: LLM_API_FORMAT_KEY, value: junk }]);
    });
  }

  it('says so once, with the value it could not use', () => {
    put(LLM_API_FORMAT_KEY, 'ollama');
    readLlmEndpoint(sqlite, recorder);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ key: LLM_API_FORMAT_KEY, stored: 'ollama' });
  });

  it('stays quiet on the paths that are not surprising', () => {
    readLlmEndpoint(sqlite, recorder);
    writeLlmEndpoint(sqlite, { url: 'u', model: 'm', api_format: 'anthropic' });
    readLlmEndpoint(sqlite, recorder);
    expect(warnings).toHaveLength(0);
  });

  it('reads without a logger at all — a boot path may not have one yet', () => {
    put(LLM_API_FORMAT_KEY, 'nonsense');
    expect(readLlmEndpoint(sqlite).api_format).toBe(DEFAULT_LLM_API_FORMAT);
  });
});

describe('writing the endpoint', () => {
  it('trims what a keyboard added to the url and the model', () => {
    writeLlmEndpoint(sqlite, {
      url: '  https://example.test/v1  ',
      model: ' m-1 ',
      api_format: 'openai',
    });
    expect(readLlmEndpoint(sqlite)).toEqual({
      url: 'https://example.test/v1',
      model: 'm-1',
      api_format: 'openai',
    });
  });

  it('stores an emptied field as empty rather than deleting the row', () => {
    writeLlmEndpoint(sqlite, { url: 'u', model: 'm', api_format: 'anthropic' });
    writeLlmEndpoint(sqlite, { url: '', model: '', api_format: 'openai' });
    expect(readLlmEndpoint(sqlite)).toEqual({ url: '', model: '', api_format: 'openai' });
    expect(rows()).toHaveLength(3);
  });

  it('is all three or none of them', () => {
    writeLlmEndpoint(sqlite, { url: 'old', model: 'old-m', api_format: 'openai' });
    // A value SQLite cannot bind, reached on the third statement — so the two
    // upserts before it have already run when it throws.
    const bad = {
      url: 'new',
      model: 'new-m',
      api_format: Symbol('nope'),
    } as unknown as LlmEndpoint;
    expect(() => writeLlmEndpoint(sqlite, bad)).toThrow();
    expect(readLlmEndpoint(sqlite)).toEqual({ url: 'old', model: 'old-m', api_format: 'openai' });
  });
});

describe('the identity domain it belongs to', () => {
  it('is local, not synced: saving an endpoint emits no sync_changes row', () => {
    const changes = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number }).n;
    const before = changes();
    writeLlmEndpoint(sqlite, {
      url: 'https://example.test/v1',
      model: 'm-1',
      api_format: 'openai',
    });
    expect(changes()).toBe(before);
  });
});
