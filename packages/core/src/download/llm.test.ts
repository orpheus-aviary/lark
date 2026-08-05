// The LLM client is tested entirely through an injected `fetchImpl` — no
// network, and the assertions are on the REQUEST as much as the response,
// because the two formats differ in ways a happy-path test cannot see (an
// Anthropic call with a Bearer header and `system` in `messages` fails with a
// 400 that looks like a config problem).

import type { LlmConfig } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import { LlmNotConfiguredError, LlmRequestError } from '../errors.js';
import { chatCompletion, cleanLlmJson, isLlmConfigured, stripThink } from './llm.js';

const OPENAI: LlmConfig = {
  url: 'https://api.example.com/v1',
  model: 'gpt-test',
  api_key: 'sk-secret',
  api_format: 'openai',
};

const ANTHROPIC: LlmConfig = {
  url: 'https://api.anthropic.com',
  model: 'claude-test',
  api_key: 'sk-ant-secret',
  api_format: 'anthropic',
};

/** A fetch stub that records its call and answers a fixed JSON body. */
function stubFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(init.text ?? JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const openAiReply = (content: string) => ({ choices: [{ message: { content } }] });

describe('isLlmConfigured', () => {
  it('needs url and model, but not a key (local endpoints have none)', () => {
    expect(isLlmConfigured(OPENAI)).toBe(true);
    expect(isLlmConfigured({ ...OPENAI, api_key: '' })).toBe(true);
    expect(isLlmConfigured({ ...OPENAI, url: '' })).toBe(false);
    expect(isLlmConfigured({ ...OPENAI, model: '  ' })).toBe(false);
  });
});

describe('chatCompletion — openai format', () => {
  it('posts to /chat/completions with a Bearer header and system+user messages', async () => {
    const { impl, calls } = stubFetch(openAiReply('hello'));
    const out = await chatCompletion(OPENAI, 'SYS', 'USR', { fetchImpl: impl });

    expect(out).toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-secret');
    expect(headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USR' },
      ],
    });
  });

  it('omits the auth header entirely when there is no key', async () => {
    const { impl, calls } = stubFetch(openAiReply('ok'));
    await chatCompletion({ ...OPENAI, api_key: '' }, 's', 'u', { fetchImpl: impl });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('trims trailing slashes off the base url', async () => {
    const { impl, calls } = stubFetch(openAiReply('ok'));
    await chatCompletion({ ...OPENAI, url: 'https://api.example.com/v1//' }, 's', 'u', {
      fetchImpl: impl,
    });
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('treats an unknown api_format as openai (the config field is open)', async () => {
    const { impl, calls } = stubFetch(openAiReply('ok'));
    await chatCompletion({ ...OPENAI, api_format: 'deepseek' }, 's', 'u', { fetchImpl: impl });
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
  });
});

describe('chatCompletion — anthropic format', () => {
  const reply = (blocks: unknown[]) => ({ content: blocks });

  it('posts to /v1/messages with x-api-key and a top-level system field', async () => {
    const { impl, calls } = stubFetch(reply([{ type: 'text', text: 'hi' }]));
    const out = await chatCompletion(ANTHROPIC, 'SYS', 'USR', { fetchImpl: impl });

    expect(out).toBe('hi');
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.system).toBe('SYS');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'USR' }]);
  });

  // A pasted `.../v1` base plus the hard-coded `/v1/messages` would become
  // `/v1/v1/messages` — a 404 that reads like a wrong API key.
  it('does not double the /v1 when the configured url already ends in it', async () => {
    const { impl, calls } = stubFetch(reply([{ type: 'text', text: 'hi' }]));
    await chatCompletion({ ...ANTHROPIC, url: 'https://api.anthropic.com/v1/' }, 's', 'u', {
      fetchImpl: impl,
    });
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('concatenates every text block and ignores non-text ones', async () => {
    const { impl } = stubFetch(
      reply([
        { type: 'thinking', thinking: 'ignore me' },
        { type: 'text', text: 'part one ' },
        { type: 'text', text: 'part two' },
      ]),
    );
    expect(await chatCompletion(ANTHROPIC, 's', 'u', { fetchImpl: impl })).toBe(
      'part one part two',
    );
  });

  it('rejects a response with no text block at all', async () => {
    const { impl } = stubFetch(reply([{ type: 'thinking', thinking: 'only this' }]));
    await expect(chatCompletion(ANTHROPIC, 's', 'u', { fetchImpl: impl })).rejects.toThrow(
      LlmRequestError,
    );
  });
});

describe('chatCompletion — failure modes', () => {
  it('refuses to call anything when no LLM is configured', async () => {
    const impl = vi.fn();
    await expect(
      chatCompletion({ url: '', model: '', api_key: '', api_format: 'openai' }, 's', 'u', {
        fetchImpl: impl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(LlmNotConfiguredError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('maps a non-2xx to LlmRequestError and keeps the provider message', async () => {
    const { impl } = stubFetch(null, { status: 404, text: '{"error":"model not found"}' });
    await expect(chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl })).rejects.toThrow(
      /HTTP 404.*model not found/,
    );
  });

  it('maps a non-JSON 200 (gateway HTML) to LlmRequestError', async () => {
    const { impl } = stubFetch(null, { text: '<html>bad gateway</html>' });
    await expect(chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl })).rejects.toThrow(/not JSON/);
  });

  it('maps a transport failure to LlmRequestError with the cause attached', async () => {
    const boom = new Error('ECONNREFUSED');
    const impl = (async () => {
      throw boom;
    }) as unknown as typeof fetch;
    await expect(chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl })).rejects.toMatchObject({
      name: 'LlmRequestError',
      cause: boom,
    });
  });

  it('passes a composed signal through, so an external abort cancels the call', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const impl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      controller.abort(new Error('cancelled by task'));
      throw new Error('aborted');
    }) as unknown as typeof fetch;

    await expect(
      chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl, signal: controller.signal }),
    ).rejects.toThrow(LlmRequestError);
    expect(seen?.aborted).toBe(true);
  });

  it('honours its own timeout even without a caller signal', async () => {
    const impl = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      })) as unknown as typeof fetch;

    await expect(
      chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl, timeoutMs: 10 }),
    ).rejects.toThrow(LlmRequestError);
  });

  // The one thing that must never leak.
  it('never puts the api key in an error message', async () => {
    const { impl } = stubFetch(null, { status: 401, text: 'unauthorized' });
    await expect(chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl })).rejects.not.toThrow(
      /sk-secret/,
    );
  });
});

describe('output cleaning', () => {
  it('strips think blocks and surrounding whitespace', () => {
    expect(stripThink('<think>\nreasoning\n</think>\n  answer  ')).toBe('answer');
    expect(stripThink('a<think>x</think>b<think>y</think>c')).toBe('abc');
    expect(stripThink('plain')).toBe('plain');
  });

  it('unwraps json fences', () => {
    expect(cleanLlmJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(cleanLlmJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(cleanLlmJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('leaves a fenced-looking string that is not fenced alone', () => {
    expect(cleanLlmJson('{"a":"```"}')).toBe('{"a":"```"}');
  });

  it('strips think blocks before the fence is looked at', async () => {
    const { impl } = stubFetch(openAiReply('<think>hmm</think>\n```json\n{"ok":true}\n```'));
    const raw = await chatCompletion(OPENAI, 's', 'u', { fetchImpl: impl });
    expect(cleanLlmJson(raw)).toBe('{"ok":true}');
  });
});
