import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configureTransport, request, requestText } from './index.js';
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

  it('carries the envelope details through (M5-20)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      envelope(
        {
          success: false,
          message: 'the link already belongs to another song',
          error_code: 'SOURCE_KEY_CONFLICT',
          details: { conflicting_song_id: 'abc' },
        },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('PUT', '/songs/x', { source_url: 'u' })).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'SOURCE_KEY_CONFLICT',
      details: { conflicting_song_id: 'abc' },
    });
  });

  it('leaves details undefined when the envelope has none', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        envelope({ success: false, message: 'gone', error_code: 'NOT_FOUND' }, 404),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/songs/x')).rejects.toMatchObject({ details: undefined });
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

describe('request signal semantics (M4-13①)', () => {
  it('an AbortError never enters the GET retry loop', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await expect(request('GET', '/songs', undefined, { signal: controller.signal })).rejects.toBe(
      abortErr,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry despite GET budget
  });

  it('an abort during the backoff wait cuts the retry short', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      // First (and only) network failure schedules a backoff; abort during it.
      queueMicrotask(() => controller.abort());
      return Promise.reject(new TypeError('fetch failed'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      request('GET', '/songs', undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // aborted before the retry fired
  });

  it('passes the signal through to fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okEnvelope());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await request('GET', '/status', undefined, { signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('honours an explicit retries override', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('GET', '/songs', undefined, { retries: 0 })).rejects.toThrow(
      'fetch failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('requestText (M4-13②)', () => {
  it('returns the body text for a 2xx', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('[00:01.00]hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    configureTransport({
      baseUrl: () => BASE,
      getAuthHeaders: () => ({ Authorization: 'Bearer secret' }),
    });

    await expect(requestText('/lyrics/x')).resolves.toBe('[00:01.00]hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/lyrics/x`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('throws ApiError with the envelope code on a non-2xx — never delivers it as lyrics', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        envelope({ success: false, message: 'no lyrics', error_code: 'LYRICS_NOT_FOUND' }, 404),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestText('/lyrics/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      errorCode: 'LYRICS_NOT_FOUND',
    });
  });

  it('carries the envelope details through too (M5-20)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        envelope(
          { success: false, message: 'bad id', error_code: 'INVALID_ID', details: { path: 'id' } },
          400,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestText('/lyrics/x')).rejects.toMatchObject({ details: { path: 'id' } });
  });

  it('still throws an ApiError carrying the status when the error body is not JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestText('/lyrics/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      errorCode: 'INVALID_RESPONSE',
    });
  });

  it('retries the network layer like any GET', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('lrc', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestText('/lyrics/x')).resolves.toBe('lrc');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
