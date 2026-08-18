// A one-shot completion client, deliberately small (M3-4).
//
// This is NOT an agent client: no streaming, no tools, no conversation, no
// retries. Every caller in lark asks one question and parses one answer, and
// every answer is either usable or falls back to a deterministic path — a
// retry would only double the latency of a failure the caller already handles.
//
// Two request shapes, because "OpenAI-compatible" stops being true for
// Anthropic: different path, different auth header, different response
// envelope. Everything else (the `<think>` stripping reasoning models need,
// the ```json fences most models add) is shared.
//
// `api_key` exists in exactly one place in this file — the request header. It
// is never logged, never put in an error message, and never returned.

import type { LlmConfig } from '@lark/shared';
import { LlmNotConfiguredError, LlmRequestError } from '../errors.js';
import { DEFAULT_TIMEOUTS, withTimeout } from './timeouts.js';

export interface ChatOptions {
  /** Cancellation from the owning task / request. Composed with the timeout. */
  signal?: AbortSignal;
  /** Test seam — a fake upstream. Production uses the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Is there enough config to make a call at all?
 *
 * url + model only: a local llama.cpp / ollama endpoint legitimately has no
 * key, and demanding one would make "no LLM configured" fire on a working
 * setup. `resolveLlmConfig` has already applied the aviary fallback by the
 * time a config gets here, so this answers for the effective config, not for
 * lark's own file.
 */
export function isLlmConfigured(config: LlmConfig): boolean {
  return config.url.trim() !== '' && config.model.trim() !== '';
}

/**
 * One system+user completion. Throws `LlmNotConfiguredError` when there is
 * nothing to call and `LlmRequestError` for every other failure — callers
 * distinguish "you never set this up" (fix your config) from "it broke"
 * (retry or fall back).
 */
export async function chatCompletion(
  config: LlmConfig,
  system: string,
  user: string,
  options: ChatOptions = {},
): Promise<string> {
  if (!isLlmConfigured(config)) throw new LlmNotConfiguredError();

  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = withTimeout(options.timeoutMs ?? DEFAULT_TIMEOUTS.llm, options.signal);
  const anthropic = config.api_format.trim().toLowerCase() === 'anthropic';
  const request = anthropic
    ? anthropicRequest(config, system, user)
    : openAiRequest(config, system, user);

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (err) {
    // An aborted fetch lands here too; the caller's own signal tells it apart
    // from a genuine network failure.
    throw new LlmRequestError(err instanceof Error ? err.message : String(err), { cause: err });
  }

  const text = await response.text();
  if (!response.ok) {
    // The body can carry the provider's own explanation ("model not found"),
    // which is the single most useful thing to show. Bounded, since some
    // gateways answer with an HTML error page.
    throw new LlmRequestError(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LlmRequestError(`response is not JSON: ${text.slice(0, 200)}`, { cause: err });
  }

  const content = anthropic ? readAnthropicContent(parsed) : readOpenAiContent(parsed);
  if (content === null) {
    throw new LlmRequestError(`response carried no completion: ${text.slice(0, 200)}`);
  }
  return stripThink(content);
}

// ─── Request shapes ────────────────────────────────────

interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Anthropic's Messages API. `system` is a top-level field, not a message —
 * putting it in `messages` is a 400. The base URL is normalised by stripping
 * a trailing `/v1` as well as slashes, because users paste both
 * `https://api.anthropic.com` and `https://api.anthropic.com/v1` and only one
 * of them survives naive concatenation.
 */
function anthropicRequest(config: LlmConfig, system: string, user: string): PreparedRequest {
  const base = config.url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    url: `${base}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: config.model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    },
  };
}

/** Everything else. `api_format` is an open string and falls back to here. */
function openAiRequest(config: LlmConfig, system: string, user: string): PreparedRequest {
  const base = config.url.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A keyless local endpoint must not receive `Bearer ` with nothing after it.
  if (config.api_key !== '') headers.authorization = `Bearer ${config.api_key}`;
  return {
    url: `${base}/chat/completions`,
    headers,
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  };
}

// ─── Response readers ──────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOpenAiContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) return null;
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === 'string' ? content : null;
}

/**
 * Anthropic answers a content ARRAY. A reasoning model puts its thinking in a
 * sibling block, so taking `content[0]` can return the wrong one entirely —
 * every `text` block is concatenated instead.
 */
function readAnthropicContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.content)) return null;
  const parts: string[] = [];
  for (const block of body.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

// ─── Output cleaning ───────────────────────────────────

/** Drop `<think>…</think>` blocks reasoning models emit before the answer. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Unwrap a ```json fence. Models add one however firmly the prompt says not
 * to, so this runs on every JSON-shaped answer. Go-version behaviour, kept
 * exactly: outermost fence only, no attempt to find JSON inside prose.
 */
export function cleanLlmJson(text: string): string {
  let out = text.trim();
  if (out.startsWith('```json')) out = out.slice('```json'.length);
  else if (out.startsWith('```')) out = out.slice('```'.length);
  if (out.endsWith('```')) out = out.slice(0, -3);
  return out.trim();
}
