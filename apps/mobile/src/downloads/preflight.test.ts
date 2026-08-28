// Criteria 21 and 25's logic halves, plus the arm/settle bracket (N4d-2).
//
// Everything on trial here is a decision, not a screen: which inputs need a
// network hop before anything can be said about them (21), what a line lark
// does not support is TOLD (25), and that the gesture arms the foreground
// service before the first packet and settles it whatever happens (§1.5). The
// device is left with the parts only it can answer — that a real b23.tv link
// expands, and that the download lands.
//
// The client is a fake with two methods because those are the only two the
// preflight can reach: one hop for a short link, one page list for the
// multi-part gate.

import type { BilibiliClient } from '@lark/core/portable';
import { DOWNLOAD_BATCH_ITEMS_MAX } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ForegroundController } from './foreground';
import {
  type VideoItem,
  expandList,
  listLabel,
  recognise,
  submitBatch,
  submitDownload,
  submitListBatch,
} from './preflight';

const BVID = 'BV1LtgV6ZE2U';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;

/** Only the methods a shell in this file can reach; the rest would be theatre. */
function client(
  overrides: {
    expandShortLink?: (url: string) => Promise<string>;
    pagelist?: (bvid: string) => Promise<{ cid: number; page: number; part: string }[]>;
    favoritesPage?: BilibiliClient['favoritesPage'];
    collectionPage?: BilibiliClient['collectionPage'];
  } = {},
): BilibiliClient {
  const unreachable = (name: string) => () => Promise.reject(new Error(`${name} is not reachable`));
  return {
    expandShortLink: overrides.expandShortLink ?? (() => Promise.resolve(VIDEO_URL)),
    pagelist: overrides.pagelist ?? (() => Promise.resolve([{ cid: 1, page: 1, part: 'P1' }])),
    search: unreachable('search'),
    view: unreachable('view'),
    audioStream: unreachable('audioStream'),
    favoritesPage: overrides.favoritesPage ?? unreachable('favoritesPage'),
    collectionPage: overrides.collectionPage ?? unreachable('collectionPage'),
    openAudio: unreachable('openAudio'),
    describeAudioRequest: unreachable('describeAudioRequest'),
  } as unknown as BilibiliClient;
}

const noLlm = (over: Partial<Parameters<typeof recognise>[0]> = {}) => ({
  client: client(),
  hasLlm: () => false,
  ...over,
});

describe('what settles offline (criterion 21: 「正在解析」 exists only where a hop does)', () => {
  it('recognises a bare bvid with no network at all', async () => {
    const onResolving = vi.fn();
    const seen = await recognise(noLlm(), BVID, { onResolving });

    expect(seen).toMatchObject({ kind: 'video', extracted: false, expandedFrom: null });
    expect(onResolving).not.toHaveBeenCalled();
  });

  it('recognises a video URL with no network at all', async () => {
    const onResolving = vi.fn();
    const seen = await recognise(noLlm(), `${VIDEO_URL}?p=2`, { onResolving });

    expect(seen).toMatchObject({ kind: 'video' });
    if (seen.kind === 'video') expect(seen.item.page).toBe(2);
    expect(onResolving).not.toHaveBeenCalled();
  });

  it('announces the hop BEFORE it happens, and only for a short link', async () => {
    const order: string[] = [];
    const deps = {
      client: client({
        expandShortLink: () => {
          order.push('hop');
          return Promise.resolve(VIDEO_URL);
        },
      }),
      hasLlm: () => false,
    };

    const seen = await recognise(deps, 'https://b23.tv/cfzPKZX', {
      onResolving: () => order.push('resolving'),
    });

    // The whole criterion: the state is announced first, so a screen can show
    // it while the request is in flight rather than after it lands.
    expect(order).toEqual(['resolving', 'hop']);
    expect(seen).toMatchObject({ kind: 'video', expandedFrom: 'https://b23.tv/cfzPKZX' });
    if (seen.kind === 'video') expect(seen.item.bvid).toBe(BVID);
  });

  it('refuses a short link that expands into another one', async () => {
    const deps = {
      client: client({ expandShortLink: () => Promise.resolve('https://b23.tv/second') }),
      hasLlm: () => false,
    };
    const seen = await recognise(deps, 'https://b23.tv/first');
    expect(seen).toMatchObject({ kind: 'refused' });
    if (seen.kind === 'refused') expect(seen.message).toContain('展开后仍是短链');
  });
});

describe('the link inside a share (N0b-4c measured this text)', () => {
  const SHARED = '莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才 https://b23.tv/cfzPKZX';

  it('finds the short link in a line that also carries a title', async () => {
    const onResolving = vi.fn();
    const seen = await recognise(noLlm(), SHARED, { onResolving });

    expect(seen).toMatchObject({ kind: 'video', extracted: true });
    // Without extraction this whole line is free text, so a real share would
    // hit the keyword gate and 「正在解析」 would never appear (criterion 22).
    expect(onResolving).toHaveBeenCalledTimes(1);
  });

  it('finds a plain video URL in a line that also carries a title', async () => {
    const seen = await recognise(noLlm(), `看这个 ${VIDEO_URL} 挺好听`, {});
    expect(seen).toMatchObject({ kind: 'video', extracted: true, expandedFrom: null });
  });

  it('leaves a bare link alone — extraction is the fallback, not the path', async () => {
    const seen = await recognise(noLlm(), VIDEO_URL);
    expect(seen).toMatchObject({ kind: 'video', extracted: false });
  });

  it('prefers explaining the URL it refused over the keyword gate', async () => {
    const seen = await recognise(noLlm(), '看这个 https://www.youtube.com/watch?v=x');
    expect(seen).toMatchObject({ kind: 'refused' });
    // "youtube 不是 B 站链接" says more than "keyword search needs an LLM".
    if (seen.kind === 'refused') expect(seen.message).toContain('不是 B 站链接');
  });
});

describe('what v1 says no to (criterion 25)', () => {
  it('refuses a non-bilibili link and says what IS supported', async () => {
    const seen = await recognise(noLlm(), 'https://www.youtube.com/watch?v=x');
    expect(seen).toMatchObject({ kind: 'refused' });
    if (seen.kind === 'refused') {
      expect(seen.message).toContain('不是 B 站链接');
      expect(seen.message).toContain('bilibili.com');
    }
  });

  it("refuses free text with portable's own words, not a paraphrase", async () => {
    const seen = await recognise(noLlm(), '莫愁乡');
    expect(seen).toMatchObject({ kind: 'refused' });
    // The exact sentence `preflightSingle` throws — never rewritten here.
    if (seen.kind === 'refused') {
      expect(seen.message).toBe('关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接');
    }
  });

  it('is empty on an empty box rather than refusing it', async () => {
    expect(await recognise(noLlm(), '   ')).toEqual({ kind: 'empty' });
  });
});

describe('submitting (§1.5: arm before the first packet, settle whatever happens)', () => {
  const item: VideoItem = { kind: 'video', bvid: BVID, page: null, url: VIDEO_URL };

  function harness(over: { pagelist?: () => Promise<never> } = {}) {
    const order: string[] = [];
    const foreground = {
      arm: () => {
        order.push('arm');
        return Promise.resolve();
      },
      settle: () => order.push('settle'),
    } as unknown as ForegroundController;
    const enqueued: unknown[] = [];
    return {
      order,
      enqueued,
      deps: {
        client: client({
          pagelist:
            over.pagelist ??
            (() => {
              order.push('pagelist');
              return Promise.resolve([{ cid: 1, page: 1, part: 'P1' }]);
            }),
        }),
        hasLlm: () => false,
        foreground,
        engine: {
          enqueueDownload: (input: unknown) => {
            order.push('enqueue');
            enqueued.push(input);
            return { id: 't1' } as never;
          },
        },
      },
    };
  }

  it('arms before any network and settles after the enqueue', async () => {
    const h = harness();
    await submitDownload(h.deps, { item, namingMode: 'original', playlistIds: [] });

    // `arm` first is the whole point: N4c-3 measured that a foreground service
    // asked for after the gesture is neither refused nor started.
    expect(h.order).toEqual(['arm', 'pagelist', 'enqueue', 'settle']);
  });

  it('settles even when the preflight throws — nothing was enqueued', async () => {
    const h = harness({ pagelist: () => Promise.reject(new Error('网络断了')) });

    await expect(
      submitDownload(h.deps, { item, namingMode: 'original', playlistIds: [] }),
    ).rejects.toThrow('网络断了');
    // Without this the service sits `arming` over an empty queue for good.
    expect(h.order).toEqual(['arm', 'settle']);
    expect(h.enqueued).toEqual([]);
  });

  it('carries the pasted URL and the chosen playlist into the task', async () => {
    const h = harness();
    await submitDownload(h.deps, {
      item: { ...item, page: 2 },
      namingMode: 'original',
      playlistIds: ['p1'],
    });

    expect(h.enqueued).toEqual([
      {
        target: { kind: 'video', bvid: BVID, page: 2, title: null, naming: 'original' },
        playlistIds: ['p1'],
        url: VIDEO_URL,
      },
    ]);
    // `page: 2` skips the page list: the episode is already chosen.
    expect(h.order).toEqual(['arm', 'enqueue', 'settle']);
  });

  it('omits playlistIds entirely when the target is 仅曲库', async () => {
    const h = harness();
    await submitDownload(h.deps, {
      item: { ...item, page: 1 },
      namingMode: 'original',
      playlistIds: [],
    });
    expect(h.enqueued[0]).not.toHaveProperty('playlistIds');
  });

  it('refuses 清洗命名 with no model, before any network', async () => {
    const h = harness();
    await expect(
      submitDownload(h.deps, { item, namingMode: 'clean', playlistIds: [] }),
    ).rejects.toThrow('清洗命名需要配置 LLM');
    expect(h.order).toEqual(['arm', 'settle']);
  });

  it('explains a multi-part video instead of guessing an episode', async () => {
    const h = harness();
    h.deps.client = client({
      pagelist: () =>
        Promise.resolve([
          { cid: 1, page: 1, part: 'P1' },
          { cid: 2, page: 2, part: 'P2' },
        ]),
    });
    await expect(
      submitDownload(h.deps, { item, namingMode: 'original', playlistIds: [] }),
    ).rejects.toThrow('这个视频有 2 个分P');
  });
});

// ─── criterion 26: a song by name (N4e-2) ──────────────

describe('a keyword, before and after there is a model', () => {
  const KEYWORD = 'Yesterday Once More Carpenters';

  it('is refused in portable’s own words when there is no model', async () => {
    const seen = await recognise(noLlm(), KEYWORD);

    expect(seen).toEqual({
      kind: 'refused',
      message: '关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接',
    });
  });

  // The regression this file exists to hold: until N4e-2 the branch treated
  // `preflightSingle` NOT throwing — the gate being open — as a refusal, and
  // answered with a placeholder about a batch that had already happened.
  it('is a submittable recognition once a model is configured', async () => {
    const seen = await recognise(noLlm({ hasLlm: () => true }), KEYWORD);

    expect(seen).toEqual({ kind: 'keyword', item: { kind: 'keyword', query: KEYWORD } });
  });

  it('submits with no naming mode and no url', async () => {
    const enqueued: { target: unknown; url?: string }[] = [];
    const deps = {
      client: client(),
      hasLlm: () => true,
      foreground: { arm: () => Promise.resolve(), settle: () => undefined },
      engine: {
        enqueueDownload: (input: { target: unknown; url?: string }) => {
          enqueued.push(input);
          return { id: 'k1' } as never;
        },
      },
    } as unknown as Parameters<typeof submitDownload>[0];

    await submitDownload(deps, {
      item: { kind: 'keyword', query: KEYWORD },
      namingMode: undefined,
      playlistIds: [],
    });

    expect(enqueued).toEqual([{ target: { kind: 'keyword', query: KEYWORD } }]);
    // Not `url: undefined` — `exactOptionalPropertyTypes` aside, a task list
    // row showing an empty link is a row that looks broken.
    expect('url' in (enqueued[0] as object)).toBe(false);
  });
});

// ─── N4f: a whole list, before you download it ─────────

const FAV_URL = 'https://space.bilibili.com/123/favlist?fid=456&ftype=create';
const COLLECTION_URL = 'https://space.bilibili.com/123/lists/789';

const listVideo = (n: number) => ({
  key: `BV${n}`,
  bvid: `BV${n}`,
  title: `第 ${n} 首`,
  label: `第 ${n} 首`,
  note: null,
  reason: null,
  duration: 100,
});

describe('recognising a list (the door N4f opens)', () => {
  it('recognises a favourites link OFFLINE — nothing is fetched yet', async () => {
    // The client refuses every list call, so reaching one here fails the test.
    // That is the point: expanding on recognition would fire a request per
    // debounce, because this page re-recognises on every keystroke (§2.2).
    const seen = await recognise(noLlm(), FAV_URL);

    expect(seen).toMatchObject({ kind: 'list' });
    if (seen.kind === 'list') {
      expect(seen.item).toMatchObject({ kind: 'favorites', media_id: '456' });
      expect(listLabel(seen.item)).toBe('收藏夹');
    }
  });

  it('recognises a collection link the same way', async () => {
    const seen = await recognise(noLlm(), COLLECTION_URL);

    expect(seen).toMatchObject({ kind: 'list' });
    if (seen.kind === 'list') {
      expect(seen.item).toMatchObject({ kind: 'collection', mid: '123', season_id: '789' });
      expect(listLabel(seen.item)).toBe('合集');
    }
  });

  // The regression this batch is named after (§1.2). Until N4f-1 a list link
  // came back `refused` with a sentence about 「下一批」 — the same shape N4e-2
  // found in front of keyword search, where the gate was open and the shell
  // was still answering with a placeholder.
  it('does not refuse a list, with or without a model', async () => {
    for (const hasLlm of [false, true]) {
      const seen = await recognise(noLlm({ hasLlm: () => hasLlm }), FAV_URL);
      expect(seen.kind).toBe('list');
    }
  });

  it('finds a list link inside a shared line, like any other link', async () => {
    const seen = await recognise(noLlm(), `我的收藏夹 ${FAV_URL} 你看看`);
    expect(seen).toMatchObject({ kind: 'list' });
  });
});

describe('expanding a list (criterion 32: the shell does not edit the truth)', () => {
  it('asks for the folder the link named, and hands back the videos', async () => {
    const asked: { mediaId: string; page: number }[] = [];
    const result = await expandList(
      {
        client: client({
          favoritesPage: (mediaId, page) => {
            asked.push({ mediaId, page });
            return Promise.resolve({
              title: '我的收藏',
              videos: [listVideo(1), listVideo(2)],
              hasMore: false,
            });
          },
        }),
      },
      { kind: 'favorites', media_id: '456', url: FAV_URL },
    );

    expect(asked).toEqual([{ mediaId: '456', page: 1 }]);
    expect(result.title).toBe('我的收藏');
    expect(result.videos).toHaveLength(2);
    expect(result.error).toBeNull();
  });

  it('asks for the collection by mid and season, not by media id', async () => {
    const asked: { mid: string; seasonId: string }[] = [];
    await expandList(
      {
        client: client({
          collectionPage: (mid, seasonId) => {
            asked.push({ mid, seasonId });
            return Promise.resolve({ title: '合集', videos: [listVideo(1)], total: 1 });
          },
        }),
      },
      { kind: 'collection', mid: '123', season_id: '789', url: COLLECTION_URL },
    );

    expect(asked).toEqual([{ mid: '123', seasonId: '789' }]);
  });

  it('passes a partial-success message through WORD FOR WORD', async () => {
    const result = await expandList(
      {
        client: client({
          favoritesPage: (_id, page) =>
            page === 1
              ? Promise.resolve({ title: '我的收藏', videos: [listVideo(1)], hasMore: true })
              : Promise.reject(new Error('网络断了')),
        }),
      },
      { kind: 'favorites', media_id: '456', url: FAV_URL },
    );

    // Not summarised, not prefixed, not swallowed: a list shown without its own
    // warning is a truncated list presented as the whole thing.
    expect(result.error).toBe('网络断了');
    expect(result.videos).toHaveLength(1);
  });

  it('throws when nothing came back at all — that is a refusal, not a list', async () => {
    await expect(
      expandList(
        { client: client({ favoritesPage: () => Promise.reject(new Error('收藏夹不存在')) }) },
        { kind: 'favorites', media_id: '456', url: FAV_URL },
      ),
    ).rejects.toThrow('收藏夹不存在');
  });

  it('carries the page’s signal down to the request', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await expandList(
      {
        client: client({
          favoritesPage: (_id, _page, options) => {
            seen = options?.signal;
            return Promise.resolve({ title: '我的收藏', videos: [listVideo(1)], hasMore: false });
          },
        }),
      },
      { kind: 'favorites', media_id: '456', url: FAV_URL },
      { signal: controller.signal },
    );

    // Leaving the picker aborts a walk that may be two hundred requests long.
    expect(seen).toBe(controller.signal);
  });
});

describe('submitting a list (criterion 33: admission is one answer, execution is another)', () => {
  function harness(hasLlm = false) {
    const order: string[] = [];
    const groups: unknown[] = [];
    return {
      order,
      groups,
      deps: {
        client: client(),
        hasLlm: () => hasLlm,
        foreground: {
          arm: () => {
            order.push('arm');
            return Promise.resolve();
          },
          settle: () => order.push('settle'),
        } as unknown as ForegroundController,
        engine: {
          enqueueBatches: (input: unknown) => {
            order.push('enqueue');
            groups.push(input);
            return [];
          },
        },
      },
    };
  }

  const videos = [listVideo(1), listVideo(2)];
  const favourites = {
    kind: 'favorites',
    media_id: '123',
    url: 'https://space.bilibili.com/1/favlist?fid=123',
  } as const;

  it('sends ONE group targeting a new playlist, with the list’s own titles', async () => {
    const h = harness();
    await submitListBatch(h.deps, {
      item: favourites,
      name: '我的收藏',
      videos,
      namingMode: 'original',
    });

    expect(h.groups).toEqual([
      [
        {
          target: { kind: 'new', name: '我的收藏' },
          // ④ — the same group shape the desktop sends, down to the field.
          source: {
            list: 'favorites',
            title: '我的收藏',
            url: 'https://space.bilibili.com/1/favlist?fid=123',
          },
          items: [
            { kind: 'video', bvid: 'BV1', page: null, title: '第 1 首', naming: 'original' },
            { kind: 'video', bvid: 'BV2', page: null, title: '第 2 首', naming: 'original' },
          ],
        },
      ],
    ]);
    expect(h.order).toEqual(['arm', 'enqueue', 'settle']);
  });

  // ④'s other half: pasted lines have no list identity, and inventing one
  // would put「（1/12）」 on a heap in every record forever.
  it('sends no source for pasted lines', async () => {
    const h = harness();
    await submitBatch(h.deps, {
      target: { kind: 'all' },
      items: [{ kind: 'video', bvid: 'BV1', page: 2, title: null, naming: 'original' }],
    });

    expect(h.groups[0]).toEqual([
      {
        target: { kind: 'all' },
        items: [{ kind: 'video', bvid: 'BV1', page: 2, title: null, naming: 'original' }],
      },
    ]);
  });

  it('gives the whole group one naming mode (decision c)', async () => {
    const h = harness(true);
    await submitListBatch(h.deps, {
      item: favourites,
      name: '我的收藏',
      videos,
      namingMode: 'clean',
    });

    const items = (h.groups[0] as { items: { naming: string }[] }[])[0]?.items ?? [];
    expect(items.every((item) => item.naming === 'clean')).toBe(true);
  });

  it('refuses 清洗命名 with no model, before arming anything', async () => {
    const h = harness();
    await expect(
      submitListBatch(h.deps, { item: favourites, name: '我的收藏', videos, namingMode: 'clean' }),
    ).rejects.toThrow('批量里有条目要清洗命名');

    // Nothing queued AND no notification raised for a submission that never
    // happened: the gate is arithmetic, so there is nothing to protect yet.
    expect(h.order).toEqual([]);
    expect(h.groups).toEqual([]);
  });

  it('refuses an empty selection instead of creating an empty playlist', async () => {
    const h = harness();
    await expect(
      submitListBatch(h.deps, {
        item: favourites,
        name: '我的收藏',
        videos: [],
        namingMode: 'original',
      }),
    ).rejects.toThrow('还没有勾选任何视频');
    expect(h.order).toEqual([]);
    expect(h.groups).toEqual([]);
  });

  it('refuses more than the batch ceiling in the desktop’s own words', async () => {
    const h = harness();
    const many = Array.from({ length: DOWNLOAD_BATCH_ITEMS_MAX + 1 }, (_, i) => listVideo(i));

    await expect(
      submitListBatch(h.deps, {
        item: favourites,
        name: '大收藏夹',
        videos: many,
        namingMode: 'original',
      }),
    ).rejects.toThrow(`一次最多 ${DOWNLOAD_BATCH_ITEMS_MAX} 个视频`);
    expect(h.order).toEqual([]);
    expect(h.groups).toEqual([]);
  });

  it('lets an admission refusal out of the engine, and still settles', async () => {
    const h = harness();
    h.deps.engine = {
      enqueueBatches: () => {
        h.order.push('enqueue');
        throw new Error('新歌单名称不能为空');
      },
    };

    await expect(
      submitListBatch(h.deps, { item: favourites, name: '   ', videos, namingMode: 'original' }),
    ).rejects.toThrow('新歌单名称不能为空');

    // The engine is the authority on its own admission rules — this shell does
    // not pre-empt the blank name, it just must not swallow the answer. And a
    // service left `arming` over an empty queue would hold the process up.
    expect(h.order).toEqual(['arm', 'enqueue', 'settle']);
  });
});
