import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configureTransport, request } from './index.js';
import type { StatusData } from './types.js';

const BASE = 'http://127.0.0.1:47100';

const STATUS: StatusData = { status: 'ok', pid: 42, uptime: 1.5, version: '0.1.0' };

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okEnvelope(): Response {
  return envelope({ success: true, data: STATUS });
}

beforeEach(() => {
  configureTransport({ baseUrl: () => BASE });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request retries', () => {
  it('retries a GET that fails at the network layer, then succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okEnvelope());
    vi.stubGlobal('fetch', fetchMock);

    const res = await request<StatusData>('GET', '/status');

    expect(res.data).toEqual(STATUS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the GET retry budget is exhausted', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/status')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry a POST — a committed write must not be replayed (M0-7)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('POST', '/playlists', { name: 'x' })).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('request error handling', () => {
  it('throws ApiError on 401 without retrying — a response IS an answer', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        envelope({ success: false, message: 'token required', error_code: 'TOKEN_REQUIRED' }, 401),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/songs')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      errorCode: 'TOKEN_REQUIRED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError on a 5xx envelope without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelope({ success: false, message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/songs')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError on a non-JSON body without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>proxy error</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/songs')).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('transport configuration', () => {
  it('prefixes the configured base URL and attaches host auth headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okEnvelope());
    vi.stubGlobal('fetch', fetchMock);
    configureTransport({
      baseUrl: () => BASE,
      getAuthHeaders: () => ({ Authorization: 'Bearer secret' }),
    });

    await request<StatusData>('GET', '/status');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/status`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });
});
