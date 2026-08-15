// A real HTTP server standing in for bilibili, the three lyrics platforms and
// the LLM (M3-12 ②).
//
// A real server rather than a fetch stub, because the parts most likely to be
// wrong are the ones a stub cannot exercise: streaming a body to disk,
// aborting mid-transfer, and a slow response outliving its deadline. The
// response bodies are trimmed copies of what `just probe-bilibili` observed
// live, so when the real API drifts the probe reports it and these fixtures
// are what get updated.
//
// Everything is mutable after start: a test flips `state.pages` or makes the
// audio hang, and the next request sees it.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePage {
  page: number;
  part: string;
  duration: number;
  cid: number;
}

export interface FakeVideo {
  title: string;
  owner: string;
  ownerMid: number;
  duration: number;
  pages: FakePage[];
}

export interface FakeSearchHit {
  bvid: string;
  title: string;
  author: string;
  mid: number;
  duration: string;
}

export interface FakeLyricsHit {
  name: string;
  artist: string;
  lrc: string;
}

export interface FakeUpstreamState {
  /** bvid → video. Anything absent answers bilibili's "not found" envelope. */
  videos: Map<string, FakeVideo>;
  searchResults: FakeSearchHit[];
  /** Raw bytes served for the audio stream — real m4a in the engine tests. */
  audio: Buffer;
  /**
   * Serve the audio in chunks of this size, with NO `content-length` — what a
   * transfer of unknown size looks like. `null` sends it in one write with the
   * length declared, which is the ordinary case.
   */
  audioChunkBytes: number | null;
  /** Answer an LLM completion. `null` makes the endpoint fail with a 500. */
  llm: ((system: string, user: string) => string) | null;
  lyrics: {
    netease: FakeLyricsHit[];
    qq: FakeLyricsHit[];
    kugou: FakeLyricsHit[];
  };
  favorites: { title: string; pages: { bvid: string; title: string; duration: number }[][] };
  collection: {
    title: string;
    total: number;
    pages: { bvid: string; title: string; duration: number }[][];
  };
  /** Delay every response by this many ms — for deadline and abort tests. */
  delayMs: number;
  /** Never answer the audio request, so the caller has to abort it. */
  hangAudio: boolean;
  /** Fail keyword search with a risk-control page. */
  riskControlSearch: boolean;
}

export interface FakeUpstream {
  readonly baseUrl: string;
  readonly state: FakeUpstreamState;
  /** Every path requested, in order — assert what was and was not called. */
  readonly requests: string[];
  /** Origins bag for the lyrics sources: every platform on this one server. */
  lyricsOrigins(): Record<string, string>;
  /** The `llm.url` a config should carry to reach this server. */
  llmUrl(): string;
  close(): Promise<void>;
}

const DEFAULT_LRC = '[00:00.00]第一行\n[00:12.34]第二行\n[03:40.00]最后一行';

export function defaultState(): FakeUpstreamState {
  return {
    videos: new Map([
      [
        'BV1Ki4y1y7HC',
        {
          title: '【私藏馆】周杰伦《稻香》',
          owner: '音乐私藏馆',
          ownerMid: 229733301,
          duration: 223,
          pages: [{ page: 1, part: '正片', duration: 223, cid: 550103819 }],
        },
      ],
    ]),
    searchResults: [
      {
        bvid: 'BV1Ki4y1y7HC',
        title: '【私藏馆】周杰伦《<em class="keyword">稻香</em>》',
        author: '音乐私藏馆',
        mid: 229733301,
        duration: '3:43',
      },
    ],
    audio: Buffer.alloc(0),
    audioChunkBytes: null,
    llm: null,
    lyrics: {
      netease: [{ name: '稻香', artist: '周杰伦', lrc: DEFAULT_LRC }],
      qq: [],
      kugou: [],
    },
    favorites: {
      title: '默认收藏夹',
      pages: [[{ bvid: 'BV1Ki4y1y7HC', title: '稻香', duration: 223 }]],
    },
    collection: {
      title: '合集·音乐私藏馆',
      total: 1,
      pages: [[{ bvid: 'BV1Ki4y1y7HC', title: '稻香', duration: 223 }]],
    },
    delayMs: 0,
    hangAudio: false,
    riskControlSearch: false,
  };
}

export async function startFakeUpstream(
  overrides: Partial<FakeUpstreamState> = {},
): Promise<FakeUpstream> {
  const state: FakeUpstreamState = { ...defaultState(), ...overrides };
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);

    const respond = async () => {
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      await route(url, req, res, state);
    };
    void respond().catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    state,
    requests,
    lyricsOrigins: () => ({
      netease: baseUrl,
      qq: baseUrl,
      kugouSearch: baseUrl,
      kugouKrc: baseUrl,
      kugouLyrics: baseUrl,
    }),
    llmUrl: () => baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ─── Routing ───────────────────────────────────────────

type Req = IncomingMessage;
type Res = ServerResponse;

async function route(url: URL, req: Req, res: Res, state: FakeUpstreamState): Promise<void> {
  const path = url.pathname;

  // ── bilibili ──
  if (path === '/x/frontend/finger/spi') {
    return json(res, { code: 0, data: { b_3: 'FAKE_B3', b_4: 'FAKE_B4' } });
  }
  if (path === '/x/web-interface/nav') {
    return json(res, {
      code: -101,
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        },
      },
    });
  }
  if (path === '/x/web-interface/wbi/search/type') {
    if (state.riskControlSearch) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE HTML><html>risk control</html>');
      return;
    }
    return json(res, { code: 0, data: { result: state.searchResults } });
  }
  if (path === '/x/player/pagelist') {
    const video = state.videos.get(url.searchParams.get('bvid') ?? '');
    if (video === undefined) return json(res, { code: -404, message: '啥都木有' });
    return json(res, { code: 0, data: video.pages });
  }
  if (path === '/x/web-interface/view') {
    const bvid = url.searchParams.get('bvid') ?? '';
    const video = state.videos.get(bvid);
    if (video === undefined) return json(res, { code: -404, message: '啥都木有' });
    return json(res, {
      code: 0,
      data: {
        bvid,
        title: video.title,
        duration: video.duration,
        videos: video.pages.length,
        owner: { mid: video.ownerMid, name: video.owner },
        pages: video.pages,
      },
    });
  }
  if (path === '/x/player/playurl') {
    return json(res, {
      code: 0,
      data: {
        dash: {
          audio: [
            {
              id: 30216,
              bandwidth: 67144,
              baseUrl: `${origin(req)}/media/low.m4a`,
              mimeType: 'audio/mp4',
              codecs: 'mp4a.40.2',
            },
            {
              id: 30280,
              bandwidth: 319076,
              baseUrl: `${origin(req)}/media/best.m4a`,
              mimeType: 'audio/mp4',
              codecs: 'mp4a.40.2',
            },
          ],
        },
      },
    });
  }
  if (path.startsWith('/media/')) {
    if (state.hangAudio) return; // never responds: the caller must abort
    // Chunked: no `content-length`, delivered in pieces — a real transfer for
    // anything that watches bytes arrive, and the only way to reach the
    // "size unknown" half of the progress contract (§3.5).
    if (state.audioChunkBytes !== null) {
      res.writeHead(200, { 'content-type': 'audio/mp4' });
      for (let at = 0; at < state.audio.length; at += state.audioChunkBytes) {
        res.write(state.audio.subarray(at, at + state.audioChunkBytes));
      }
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'audio/mp4',
      'content-length': String(state.audio.length),
    });
    res.end(state.audio);
    return;
  }
  if (path === '/x/v3/fav/resource/list') {
    const pn = Number(url.searchParams.get('pn') ?? '1');
    const page = state.favorites.pages[pn - 1] ?? [];
    return json(res, {
      code: 0,
      data: {
        info: { title: state.favorites.title },
        medias: page,
        has_more: pn < state.favorites.pages.length,
      },
    });
  }
  if (path === '/x/polymer/web-space/seasons_archives_list') {
    const pn = Number(url.searchParams.get('page_num') ?? '1');
    return json(res, {
      code: 0,
      data: {
        meta: { name: state.collection.title },
        archives: state.collection.pages[pn - 1] ?? [],
        page: { total: state.collection.total },
      },
    });
  }

  // ── LLM ──
  if (path === '/chat/completions' || path === '/v1/messages') {
    const body = JSON.parse(await readBody(req)) as {
      system?: string;
      messages?: { role: string; content: string }[];
    };
    if (state.llm === null) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no llm configured in the fake upstream' }));
      return;
    }
    const system = body.system ?? body.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    const answer = state.llm(system, user);
    return json(
      res,
      path === '/v1/messages'
        ? { content: [{ type: 'text', text: answer }] }
        : { choices: [{ message: { content: answer } }] },
    );
  }

  // ── lyrics ──
  if (path === '/api/search/get') {
    return json(res, {
      result: {
        songs: state.lyrics.netease.map((hit, index) => ({
          id: index + 1,
          name: hit.name,
          artists: [{ name: hit.artist }],
        })),
      },
    });
  }
  if (path === '/api/song/lyric') {
    const hit = state.lyrics.netease[Number(url.searchParams.get('id') ?? '1') - 1];
    return json(res, { lrc: { lyric: hit?.lrc ?? '' } });
  }
  if (path === '/soso/fcgi-bin/client_search_cp') {
    return json(res, {
      data: {
        song: {
          list: state.lyrics.qq.map((hit, index) => ({
            songmid: `QQ${index}`,
            songname: hit.name,
            singer: [{ name: hit.artist }],
          })),
        },
      },
    });
  }
  if (path === '/lyric/fcgi-bin/fcg_query_lyric_new.fcg') {
    const index = Number((url.searchParams.get('songmid') ?? 'QQ0').slice(2));
    const hit = state.lyrics.qq[index];
    return json(res, { lyric: Buffer.from(hit?.lrc ?? '', 'utf-8').toString('base64') });
  }
  if (path === '/api/v3/search/song') {
    return json(res, {
      data: {
        info: state.lyrics.kugou.map((hit, index) => ({
          hash: `HASH${index}`,
          songname: hit.name,
          singername: hit.artist,
          duration: 223,
        })),
      },
    });
  }
  if (path === '/search') {
    const hash = url.searchParams.get('hash') ?? 'HASH0';
    return json(res, { candidates: [{ id: hash.slice(4), accesskey: 'KEY' }] });
  }
  if (path === '/download') {
    const hit = state.lyrics.kugou[Number(url.searchParams.get('id') ?? '0')];
    return json(res, { content: Buffer.from(hit?.lrc ?? '', 'utf-8').toString('base64') });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: -404, message: `fake upstream has no route for ${path}` }));
}

function json(res: Res, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function origin(req: Req): string {
  return `http://${req.headers.host ?? '127.0.0.1'}`;
}

async function readBody(req: Req): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}
