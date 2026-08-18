// The client is driven through an injected fetch that answers from a URL →
// response table, so each test states exactly what bilibili returned. Response
// bodies are trimmed copies of what `just probe-bilibili` saw live on
// 2026-08-05 — when the real API drifts, the probe is what catches it, and
// these fixtures are what get updated.

import { describe, expect, it } from 'vitest';
import { BilibiliApiError, BilibiliRiskControlError, NormalizeFailedError } from '../errors.js';
import { cleanSearchTitle, createBilibiliClient, parseClockDuration } from './bilibili.js';

const BVID = 'BV1Ki4y1y7HC';

interface Route {
  match: string;
  body?: unknown;
  /** Raw text + content-type, for the non-JSON cases. */
  raw?: { text: string; contentType?: string; status?: number; headers?: Record<string, string> };
}

/** Answer by first matching substring; unmatched URLs are a test bug, not a 404. */
function routedFetch(routes: Route[]) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    const route = routes.find((r) => href.includes(r.match));
    if (route === undefined) throw new Error(`unrouted request: ${href}`);
    if (route.raw !== undefined) {
      return new Response(route.raw.text, {
        status: route.raw.status ?? 200,
        headers: {
          'content-type': route.raw.contentType ?? 'text/html; charset=utf-8',
          ...route.raw.headers,
        },
      });
    }
    void init;
    return new Response(JSON.stringify(route.body), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SPI = { match: '/finger/spi', body: { code: 0, data: { b_3: 'B3', b_4: 'B4' } } };
const NAV = {
  match: '/web-interface/nav',
  body: {
    code: -101,
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  },
};

const client = (routes: Route[]) => {
  const { impl, calls } = routedFetch([SPI, NAV, ...routes]);
  return { client: createBilibiliClient({ fetchImpl: impl }), calls };
};

describe('search', () => {
  const searchBody = {
    code: 0,
    data: {
      result: [
        {
          bvid: BVID,
          title: '【私藏馆】周杰伦《<em class="keyword">稻香</em>》超治愈神作',
          author: '音乐私藏馆',
          mid: 229733301,
          duration: '3:43',
          description: 'desc',
        },
        { bvid: '', title: 'no bvid', author: '', mid: 0, duration: '1:00', description: '' },
      ],
    },
  };

  it('signs the request and carries the buvid cookie', async () => {
    const { client: c, calls } = client([{ match: '/wbi/search/type', body: searchBody }]);
    await c.search('稻香');
    const searchCall = calls.find((u) => u.includes('/wbi/search/type')) ?? '';
    expect(searchCall).toMatch(/w_rid=[0-9a-f]{32}/);
    expect(searchCall).toMatch(/wts=\d+/);
  });

  it('strips <em> highlight markup out of titles', async () => {
    const { client: c } = client([{ match: '/wbi/search/type', body: searchBody }]);
    const [first] = await c.search('稻香');
    expect(first?.title).toBe('【私藏馆】周杰伦《稻香》超治愈神作');
  });

  it('parses mm:ss durations and drops results with no bvid', async () => {
    const { client: c } = client([{ match: '/wbi/search/type', body: searchBody }]);
    const results = await c.search('稻香');
    expect(results).toHaveLength(1);
    expect(results[0]?.duration).toBe(223);
  });

  it('caches the wbi keys across calls', async () => {
    const { client: c, calls } = client([{ match: '/wbi/search/type', body: searchBody }]);
    await c.search('a');
    await c.search('b');
    expect(calls.filter((u) => u.includes('/web-interface/nav'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/finger/spi'))).toHaveLength(1);
  });

  it('re-fetches the wbi keys once the cache window passes', async () => {
    const { impl, calls } = routedFetch([
      SPI,
      NAV,
      { match: '/wbi/search/type', body: searchBody },
    ]);
    let clock = 0;
    const c = createBilibiliClient({ fetchImpl: impl, now: () => clock });
    await c.search('a');
    clock += 31 * 60_000;
    await c.search('b');
    expect(calls.filter((u) => u.includes('/web-interface/nav'))).toHaveLength(2);
  });

  it('returns an empty list rather than throwing when there are no hits', async () => {
    const { client: c } = client([
      { match: '/wbi/search/type', body: { code: 0, data: { result: null } } },
    ]);
    expect(await c.search('nothing')).toEqual([]);
  });
});

describe('risk control classification', () => {
  // HTTP 200 + HTML is exactly how the Go version's search "succeeded" while
  // returning nothing.
  it('treats an HTML body under HTTP 200 as risk control', async () => {
    const { client: c } = client([
      { match: '/wbi/search/type', raw: { text: '<!DOCTYPE HTML><html>…' } },
    ]);
    await expect(c.search('稻香')).rejects.toThrow(BilibiliRiskControlError);
  });

  it('treats envelope -412 as risk control, not a generic API error', async () => {
    const { client: c } = client([
      { match: '/player/pagelist', body: { code: -412, message: '请求被拦截' } },
    ]);
    await expect(c.pagelist(BVID)).rejects.toThrow(BilibiliRiskControlError);
  });

  it('keeps ordinary envelope errors distinguishable', async () => {
    const { client: c } = client([
      { match: '/player/pagelist', body: { code: -404, message: '啥都木有' } },
    ]);
    await expect(c.pagelist(BVID)).rejects.toMatchObject({
      name: 'BilibiliApiError',
      apiCode: -404,
    });
  });
});

describe('pagelist / view', () => {
  it('reads the page list', async () => {
    const { client: c } = client([
      {
        match: '/player/pagelist',
        body: { code: 0, data: [{ page: 1, part: '正片', duration: 223, cid: 550103819 }] },
      },
    ]);
    expect(await c.pagelist(BVID)).toEqual([
      { page: 1, part: '正片', duration: 223, cid: 550103819 },
    ]);
  });

  it('reads title / owner / pages off view', async () => {
    const { client: c } = client([
      {
        match: '/web-interface/view',
        body: {
          code: 0,
          data: {
            bvid: BVID,
            title: '稻香',
            duration: 223,
            videos: 1,
            owner: { mid: 229733301, name: '音乐私藏馆' },
            pages: [{ page: 1, part: '正片', duration: 223, cid: 550103819 }],
          },
        },
      },
    ]);
    const view = await c.view(BVID);
    expect(view).toMatchObject({ title: '稻香', ownerName: '音乐私藏馆', videos: 1 });
    expect(view.pages).toHaveLength(1);
  });

  // §7 F10: `view` was the ONE title path that did not decode entities, and
  // 0.3.0 made it visible — `original` naming stores this string verbatim.
  it('decodes entities in the title and the uploader name', async () => {
    const { client: c } = client([
      {
        match: '/web-interface/view',
        body: {
          code: 0,
          data: {
            bvid: BVID,
            title: 'R&amp;B 现场 &quot;live&quot;',
            duration: 223,
            videos: 1,
            owner: { mid: 1, name: 'A&amp;B 音乐' },
            pages: [{ page: 1, part: '正片', duration: 223, cid: 1 }],
          },
        },
      },
    ]);
    const view = await c.view(BVID);
    expect(view.title).toBe('R&B 现场 "live"');
    expect(view.ownerName).toBe('A&B 音乐');
  });

  it('rejects a view with no title rather than storing an empty song name', async () => {
    const { client: c } = client([{ match: '/web-interface/view', body: { code: 0, data: {} } }]);
    await expect(c.view(BVID)).rejects.toThrow(BilibiliApiError);
  });
});

describe('audioStream', () => {
  const playurl = (audio: unknown[]) => ({
    match: '/player/playurl',
    body: { code: 0, data: { dash: { audio } } },
  });

  const aac = (id: number, bandwidth: number, url: string) => ({
    id,
    bandwidth,
    baseUrl: url,
    mimeType: 'audio/mp4',
    codecs: 'mp4a.40.2',
  });

  it('picks the highest bandwidth tier', async () => {
    const { client: c } = client([
      playurl([
        aac(30216, 67144, 'https://cdn/64k'),
        aac(30280, 319076, 'https://cdn/192k'),
        aac(30232, 131898, 'https://cdn/132k'),
      ]),
    ]);
    expect(await c.audioStream(BVID, 550103819)).toMatchObject({
      url: 'https://cdn/192k',
      id: 30280,
      codecs: 'mp4a.40.2',
      isAac: true,
    });
  });

  // Canonical audio is AAC in an MP4, so an AAC stream is copied byte for byte
  // and anything else is re-encoded (D17). A fatter non-AAC tier is therefore
  // the worse choice: the extra bitrate does not survive the encoder.
  it('prefers AAC over a higher-bandwidth stream in another codec', async () => {
    const { client: c } = client([
      playurl([
        {
          id: 30250,
          bandwidth: 1_000_000,
          baseUrl: 'https://cdn/dolby',
          mimeType: 'audio/mp4',
          codecs: 'ec-3',
        },
        aac(30232, 131898, 'https://cdn/132k'),
      ]),
    ]);
    expect(await c.audioStream(BVID, 1)).toMatchObject({ url: 'https://cdn/132k', isAac: true });
  });

  it('falls back to the best stream there is when none declares AAC', async () => {
    const { client: c } = client([
      playurl([
        { id: 30251, bandwidth: 900_000, baseUrl: 'https://cdn/flac', codecs: 'fLaC' },
        { id: 30250, bandwidth: 1_000_000, baseUrl: 'https://cdn/dolby', codecs: 'ec-3' },
      ]),
    ]);
    // Desktop transcodes it (mobile will refuse — D17); either way the probe
    // of the downloaded bytes, not this field, decides what ffmpeg is told.
    expect(await c.audioStream(BVID, 1)).toMatchObject({ url: 'https://cdn/dolby', isAac: false });
  });

  // Old responses (and the odd edge case) omit `codecs` entirely. Guessing
  // "AAC" there would claim a copy the file might not support; guessing the
  // other way costs a transcode that the probe will avoid anyway if the bytes
  // turn out to be AAC.
  it('treats a missing codecs field as not-AAC and still picks by bandwidth', async () => {
    const { client: c } = client([
      playurl([
        { id: 30216, bandwidth: 67144, baseUrl: 'https://cdn/64k', mimeType: 'audio/mp4' },
        { id: 30280, bandwidth: 319076, baseUrl: 'https://cdn/192k', mimeType: 'audio/mp4' },
      ]),
    ]);
    expect(await c.audioStream(BVID, 1)).toMatchObject({
      url: 'https://cdn/192k',
      codecs: '',
      isAac: false,
    });
  });

  it('reports a members-only video as an API error, not an empty result', async () => {
    const { client: c } = client([playurl([])]);
    await expect(c.audioStream(BVID, 1)).rejects.toThrow(/no audio stream/);
  });
});

describe('list endpoints', () => {
  it('reads a favourites page and trusts has_more over the page size', async () => {
    const { client: c } = client([
      {
        match: '/fav/resource/list',
        body: {
          code: 0,
          data: {
            info: { title: '默认收藏夹' },
            // 15 items for a ps=20 request — observed live; the short page does
            // NOT mean the list ended.
            medias: Array.from({ length: 15 }, (_, i) => ({
              bvid: `BV1Ki4y1y7H${'ABCDEFGHJKLMNPQ'[i]}`,
              title: `t${i}`,
              duration: 100,
            })),
            has_more: true,
          },
        },
      },
    ]);
    const page = await c.favoritesPage('96661672', 1);
    expect(page.title).toBe('默认收藏夹');
    expect(page.videos).toHaveLength(15);
    expect(page.hasMore).toBe(true);
  });

  it('reports a private favourites folder (code 0 + null data) as an error', async () => {
    const { client: c } = client([
      { match: '/fav/resource/list', body: { code: 0, message: 'OK', data: null } },
    ]);
    await expect(c.favoritesPage('22', 1)).rejects.toThrow(/private or does not exist/);
  });

  it('reads a collection page with its total', async () => {
    const { client: c } = client([
      {
        match: '/seasons_archives_list',
        body: {
          code: 0,
          data: {
            meta: { name: '合集·音乐私藏馆' },
            archives: [{ bvid: BVID, title: '稻香', duration: 223 }],
            page: { total: 9 },
          },
        },
      },
    ]);
    expect(await c.collectionPage('229733301', '5981270', 1)).toMatchObject({
      title: '合集·音乐私藏馆',
      total: 9,
    });
  });
});

describe('expandShortLink', () => {
  it('reads Location without following it', async () => {
    const { impl } = routedFetch([
      {
        match: 'b23.tv',
        raw: {
          text: '',
          status: 302,
          headers: { location: `https://www.bilibili.com/video/${BVID}` },
        },
      },
    ]);
    const c = createBilibiliClient({ fetchImpl: impl });
    expect(await c.expandShortLink('https://b23.tv/abc')).toBe(
      `https://www.bilibili.com/video/${BVID}`,
    );
  });

  it('fails clearly when there is no redirect', async () => {
    const { impl } = routedFetch([{ match: 'b23.tv', raw: { text: 'ok', status: 200 } }]);
    const c = createBilibiliClient({ fetchImpl: impl });
    await expect(c.expandShortLink('https://b23.tv/abc')).rejects.toThrow(NormalizeFailedError);
  });
});

describe('helpers', () => {
  it('decodes entities after removing markup, without double-decoding &amp;', () => {
    expect(cleanSearchTitle('<em class="keyword">a</em> &amp;quot;b&amp;quot;')).toBe(
      'a &quot;b&quot;',
    );
    expect(cleanSearchTitle('R&amp;B &quot;live&quot;')).toBe('R&B "live"');
  });

  it('parses clock durations, including the hour form', () => {
    expect(parseClockDuration('3:43')).toBe(223);
    expect(parseClockDuration('1:02:03')).toBe(3723);
    expect(parseClockDuration('')).toBeNull();
    expect(parseClockDuration('223')).toBeNull();
    expect(parseClockDuration('a:b')).toBeNull();
  });
});
