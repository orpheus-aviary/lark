import { describe, expect, it, vi } from 'vitest';
import {
  MEDIA_PASSTHROUGH_HEADERS,
  createMediaRequestHandler,
  songIdFromMediaUrl,
} from './media-handler.js';

const SONG_ID = '9e107d9d-372b-4e39-a3ee-8b2f3d1c4a5b';
const ORIGIN = 'http://127.0.0.1:47100';

function handler(overrides: Partial<Parameters<typeof createMediaRequestHandler>[0]> = {}) {
  return createMediaRequestHandler({
    daemonOrigin: ORIGIN,
    readToken: () => 'tok-1',
    fetchUpstream: async () => new Response('x', { status: 200 }),
    ...overrides,
  });
}

describe('songIdFromMediaUrl', () => {
  it('accepts exactly lark-media://song/<uuid-v4>', () => {
    expect(songIdFromMediaUrl(`lark-media://song/${SONG_ID}`)).toBe(SONG_ID);
  });

  it.each([
    ['not a url', 'nonsense'],
    ['wrong scheme', `https://song/${SONG_ID}`],
    ['wrong host', `lark-media://songs/${SONG_ID}`],
    ['not a uuid', 'lark-media://song/not-a-uuid'],
    ['uppercase uuid', `lark-media://song/${SONG_ID.toUpperCase()}`],
    ['uuid v1', 'lark-media://song/9e107d9d-372b-1e39-a3ee-8b2f3d1c4a5b'],
    ['extra segment', `lark-media://song/${SONG_ID}/extra`],
    ['query', `lark-media://song/${SONG_ID}?x=1`],
    ['fragment', `lark-media://song/${SONG_ID}#f`],
    ['port', `lark-media://song:47100/${SONG_ID}`],
    ['credentials', `lark-media://user:pw@song/${SONG_ID}`],
    ['empty path', 'lark-media://song/'],
    ['traversal', 'lark-media://song/../etc'],
  ])('rejects %s', (_label, url) => {
    expect(songIdFromMediaUrl(url)).toBeNull();
  });
});

describe('createMediaRequestHandler', () => {
  it('answers 400 for an invalid url without touching token or upstream', async () => {
    const readToken = vi.fn(() => 'tok');
    const fetchUpstream = vi.fn();
    const res = await handler({ readToken, fetchUpstream })(
      new Request('lark-media://song/not-a-uuid'),
    );
    expect(res.status).toBe(400);
    expect(readToken).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('answers 503 when the token file is unreadable', async () => {
    const fetchUpstream = vi.fn();
    const res = await handler({
      readToken: () => {
        throw new Error('ENOENT');
      },
      fetchUpstream,
    })(new Request(`lark-media://song/${SONG_ID}`));
    expect(res.status).toBe(503);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('answers 502 when the upstream fetch rejects', async () => {
    const res = await handler({
      fetchUpstream: async () => {
        throw new TypeError('fetch failed');
      },
    })(new Request(`lark-media://song/${SONG_ID}`));
    expect(res.status).toBe(502);
  });

  it('forwards the inbound Range verbatim and attaches a fresh Bearer per request', async () => {
    const tokens = ['tok-a', 'tok-b'];
    const readToken = vi.fn(() => tokens.shift() as string);
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchUpstream = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response('x', { status: 206 });
    });
    const handle = handler({ readToken, fetchUpstream });

    await handle(
      new Request(`lark-media://song/${SONG_ID}`, { headers: { Range: 'bytes=100-1023' } }),
    );
    await handle(new Request(`lark-media://song/${SONG_ID}`));

    expect(seen[0]?.url).toBe(`${ORIGIN}/audio/${SONG_ID}`);
    expect(seen[0]?.headers).toEqual({
      Authorization: 'Bearer tok-a',
      Range: 'bytes=100-1023',
    });
    // Second request: fresh token read, and NO Range key when none came in.
    expect(seen[1]?.headers).toEqual({ Authorization: 'Bearer tok-b' });
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it.each([200, 206, 404, 416])('passes upstream status %d through untouched', async (status) => {
    const res = await handler({
      // 204/304-style bodies are not in play; every audio status carries one.
      fetchUpstream: async () => new Response('body', { status }),
    })(new Request(`lark-media://song/${SONG_ID}`));
    expect(res.status).toBe(status);
  });

  it('forwards exactly the five passthrough headers and drops everything else', async () => {
    const upstreamHeaders: Record<string, string> = {
      'content-type': 'audio/mpeg',
      'content-length': '4',
      'content-range': 'bytes 0-3/100',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'set-cookie': 'sid=leak',
      'x-internal': 'leak',
    };
    const res = await handler({
      fetchUpstream: async () => new Response('body', { status: 206, headers: upstreamHeaders }),
    })(new Request(`lark-media://song/${SONG_ID}`, { headers: { Range: 'bytes=0-3' } }));

    for (const name of MEDIA_PASSTHROUGH_HEADERS) {
      expect(res.headers.get(name)).toBe(upstreamHeaders[name]);
    }
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
  });

  it('streams the upstream body through', async () => {
    const res = await handler({
      fetchUpstream: async () => new Response('payload-bytes', { status: 200 }),
    })(new Request(`lark-media://song/${SONG_ID}`));
    expect(await res.text()).toBe('payload-bytes');
  });
});
