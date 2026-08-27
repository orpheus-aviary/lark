// `PATCH /config` from the renderer (M5-1): the response body is the new
// truth, and a rejection must reach the caller with its `details` intact —
// that is how the settings page marks the offending field (M5-20).

import type { PublicLarkConfig } from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfig } from './config.js';

function publicConfig(overrides: Partial<PublicLarkConfig> = {}): PublicLarkConfig {
  return {
    llm: { url: '', model: '', api_format: '', has_api_key: false },
    window: { width: 1024, height: 768 },
    theme: { mode: 'system' },
    font: { global_font_size: 14, lyrics_font_size: 14 },
    log: { level: 'info', max_size_mb: 10, max_backups: 5 },
    storage: { cache_limit_mb: 0 },
    playback: { auto_download_next: true },
    sync: { interval_min: 5 },
    ...overrides,
  };
}

function envelope(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  useConfig.setState({ config: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useConfig.patch', () => {
  it('sends the patch and adopts the response body', async () => {
    const next = publicConfig({ theme: { mode: 'dark' } });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelope({ success: true, data: next }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(useConfig.getState().patch({ theme: { mode: 'dark' } })).resolves.toEqual(next);
    expect(useConfig.getState().config).toEqual(next);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:47100/config');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ theme: { mode: 'dark' } }));
  });

  it('propagates a 400 with its details and leaves the mirror alone', async () => {
    const current = publicConfig();
    useConfig.setState({ config: current });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        envelope(
          {
            success: false,
            message: 'log.level must be one of: trace, debug, info, warn, error, fatal',
            error_code: 'INVALID_CONFIG',
            details: { path: 'log.level' },
          },
          400,
        ),
      ),
    );

    await expect(useConfig.getState().patch({ log: { level: 'info' } })).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'INVALID_CONFIG',
      details: { path: 'log.level' },
    });
    expect(useConfig.getState().config).toEqual(current);
  });
});
