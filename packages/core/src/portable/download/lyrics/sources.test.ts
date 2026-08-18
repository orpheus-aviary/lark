// Each platform is driven through an injected fetch answering from a URL →
// body table. What matters is the parse (three different JSON shapes, two of
// them base64) and the tolerance: a hit with no lyrics, a hop that fails, or a
// platform that is down must cost that ONE candidate, never the run.

import { describe, expect, it, vi } from 'vitest';
import { searchKugou } from './kugou.js';
import { searchNetease } from './netease.js';
import { searchQq } from './qq.js';
import type { LyricsQuery } from './shared.js';

const QUERY: LyricsQuery = { name: '稻香', artist: '周杰伦', duration: 223 };

const LRC = '[00:00.00]稻香\n[00:12.34]对这个世界\n[03:40.00]家是唯一的城堡';
const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');

interface Route {
  match: string;
  body?: unknown;
  status?: number;
}

function routedFetch(routes: Route[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });
    const route = routes.find((r) => href.includes(r.match));
    if (route === undefined) throw new Error(`unrouted request: ${href}`);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('netease', () => {
  const searchBody = (ids: number[]) => ({
    result: { songs: ids.map((id) => ({ id, name: '稻香', artists: [{ name: '周杰伦' }] })) },
  });

  it('reads a candidate and its artist', async () => {
    const { impl } = routedFetch([
      { match: '/api/search/get', body: searchBody([1]) },
      { match: '/api/song/lyric', body: { lrc: { lyric: LRC } } },
    ]);
    const [candidate] = await searchNetease(QUERY, { fetchImpl: impl });
    expect(candidate).toMatchObject({ platform: 'netease', songName: '稻香', artist: '周杰伦' });
  });

  it('posts the query form-encoded', async () => {
    const { impl, calls } = routedFetch([{ match: '/api/search/get', body: searchBody([]) }]);
    await searchNetease(QUERY, { fetchImpl: impl });
    expect(calls[0]?.init.method).toBe('POST');
    expect(String(calls[0]?.init.body)).toContain(
      's=%E7%A8%BB%E9%A6%99+%E5%91%A8%E6%9D%B0%E4%BC%A6',
    );
  });

  it('drops hits whose lyrics have no timestamps, keeping the good ones', async () => {
    let call = 0;
    const impl = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/api/search/get')) {
        return new Response(JSON.stringify(searchBody([1, 2])));
      }
      call++;
      // First hit: plain text. Second: real LRC.
      return new Response(JSON.stringify({ lrc: { lyric: call === 1 ? 'plain text' : LRC } }));
    }) as unknown as typeof fetch;

    const candidates = await searchNetease(QUERY, { fetchImpl: impl });
    expect(candidates).toHaveLength(1);
  });

  it('caps at three candidates however many hits come back', async () => {
    const { impl } = routedFetch([
      { match: '/api/search/get', body: searchBody([1, 2, 3, 4, 5, 6]) },
      { match: '/api/song/lyric', body: { lrc: { lyric: LRC } } },
    ]);
    expect(await searchNetease(QUERY, { fetchImpl: impl })).toHaveLength(3);
  });

  it('survives a lyric fetch that fails outright', async () => {
    const impl = (async (url: string | URL) => {
      if (String(url).includes('/api/search/get')) {
        return new Response(JSON.stringify(searchBody([1])));
      }
      throw new Error('connection reset');
    }) as unknown as typeof fetch;
    expect(await searchNetease(QUERY, { fetchImpl: impl })).toEqual([]);
  });
});

describe('qq', () => {
  const searchBody = (mids: string[]) => ({
    data: {
      song: {
        list: mids.map((songmid) => ({ songmid, songname: '稻香', singer: [{ name: '周杰伦' }] })),
      },
    },
  });

  it('base64-decodes the lyric payload', async () => {
    const { impl } = routedFetch([
      { match: '/soso/fcgi-bin/client_search_cp', body: searchBody(['MID1']) },
      { match: '/fcg_query_lyric_new.fcg', body: { lyric: b64(LRC) } },
    ]);
    const [candidate] = await searchQq(QUERY, { fetchImpl: impl });
    expect(candidate?.lrc).toContain('家是唯一的城堡');
  });

  it('drops a hit whose payload is not decodable', async () => {
    const { impl } = routedFetch([
      { match: '/soso/fcgi-bin/client_search_cp', body: searchBody(['MID1']) },
      { match: '/fcg_query_lyric_new.fcg', body: { lyric: '' } },
    ]);
    expect(await searchQq(QUERY, { fetchImpl: impl })).toEqual([]);
  });
});

describe('kugou', () => {
  const searchBody = {
    data: {
      info: [{ hash: 'HASH1', songname: '稻香', singername: '周杰伦', duration: 223 }],
    },
  };

  it('walks all three hops and decodes the download', async () => {
    const { impl, calls } = routedFetch([
      { match: '/api/v3/search/song', body: searchBody },
      { match: 'krcs', body: { candidates: [{ id: '165166985', accesskey: 'KEY' }] } },
      { match: 'lyrics.kugou', body: { content: b64(LRC) } },
    ]);
    const [candidate] = await searchKugou(QUERY, { fetchImpl: impl });
    expect(candidate).toMatchObject({ platform: 'kugou', songName: '稻香' });

    // Every hop is https — the Go version used plain http for the last two.
    for (const call of calls) expect(call.url.startsWith('https://')).toBe(true);
  });

  // Without hash + duration the lyric search answers `candidates: []` even for
  // a song it has, so this is the difference between "no lyrics" and "asked wrong".
  it('sends the hash and duration in milliseconds to the lyric search', async () => {
    const { impl, calls } = routedFetch([
      { match: '/api/v3/search/song', body: searchBody },
      { match: 'krcs', body: { candidates: [] } },
    ]);
    await searchKugou(QUERY, { fetchImpl: impl });
    const krc = calls.find((c) => c.url.includes('krcs'))?.url ?? '';
    expect(krc).toContain('hash=HASH1');
    expect(krc).toContain('duration=223000');
  });

  it('gives up on a song with no lyric candidates without failing the platform', async () => {
    const { impl } = routedFetch([
      { match: '/api/v3/search/song', body: searchBody },
      { match: 'krcs', body: { candidates: [] } },
    ]);
    expect(await searchKugou(QUERY, { fetchImpl: impl })).toEqual([]);
  });
});

describe('origins', () => {
  it('are overridable, which is how the fake upstream is wired', async () => {
    const { impl, calls } = routedFetch([{ match: 'localhost', body: { result: { songs: [] } } }]);
    await searchNetease(QUERY, { fetchImpl: impl, origins: { netease: 'http://localhost:9999' } });
    expect(calls[0]?.url).toBe('http://localhost:9999/api/search/get');
  });

  it('carries a caller signal into the request', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({ result: { songs: [] } }));
    }) as unknown as typeof fetch;

    await searchNetease(QUERY, { fetchImpl: impl, signal: controller.signal });
    controller.abort();
    expect(seen[0]?.aborted).toBe(true);
  });

  it('stops a platform that hangs forever', async () => {
    const impl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const timeouts = { ...(await import('../timeouts.js')).DEFAULT_TIMEOUTS, lyricsPlatform: 10 };
    await expect(searchNetease(QUERY, { fetchImpl: impl, timeouts })).rejects.toThrow();
  });
});

describe('query building', () => {
  it('drops the artist from the search term when there is none', async () => {
    const { impl, calls } = routedFetch([{ match: 'client_search_cp', body: {} }]);
    await searchQq({ name: '稻香', artist: '', duration: 0 }, { fetchImpl: impl });
    expect(calls[0]?.url).toContain('w=%E7%A8%BB%E9%A6%99&');
  });

  it('does not call a platform more than needed for the cap', async () => {
    const lyric = vi.fn(async () => new Response(JSON.stringify({ lrc: { lyric: LRC } })));
    const impl = (async (url: string | URL) => {
      if (String(url).includes('/api/search/get')) {
        return new Response(
          JSON.stringify({
            result: { songs: [1, 2, 3, 4, 5].map((id) => ({ id, name: 'n', artists: [] })) },
          }),
        );
      }
      return lyric();
    }) as unknown as typeof fetch;

    await searchNetease(QUERY, { fetchImpl: impl });
    expect(lyric).toHaveBeenCalledTimes(3);
  });
});
