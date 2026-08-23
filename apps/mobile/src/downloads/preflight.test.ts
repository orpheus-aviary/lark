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
import { describe, expect, it, vi } from 'vitest';
import type { ForegroundController } from './foreground';
import { type VideoItem, recognise, submitDownload } from './preflight';

const BVID = 'BV1LtgV6ZE2U';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;

/** Only the two methods the preflight can reach; the rest would be theatre. */
function client(
  overrides: {
    expandShortLink?: (url: string) => Promise<string>;
    pagelist?: (bvid: string) => Promise<{ cid: number; page: number; part: string }[]>;
  } = {},
): BilibiliClient {
  const unreachable = (name: string) => () => Promise.reject(new Error(`${name} is not reachable`));
  return {
    expandShortLink: overrides.expandShortLink ?? (() => Promise.resolve(VIDEO_URL)),
    pagelist: overrides.pagelist ?? (() => Promise.resolve([{ cid: 1, page: 1, part: 'P1' }])),
    search: unreachable('search'),
    view: unreachable('view'),
    audioStream: unreachable('audioStream'),
    favoritesPage: unreachable('favoritesPage'),
    collectionPage: unreachable('collectionPage'),
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

  it('refuses a favourites link in words that name a phone, not two HTTP routes', async () => {
    const seen = await recognise(
      noLlm(),
      'https://space.bilibili.com/123/favlist?fid=456&ftype=create',
    );
    expect(seen).toMatchObject({ kind: 'refused' });
    if (seen.kind === 'refused') {
      expect(seen.message).toContain('收藏夹和合集');
      expect(seen.message).not.toContain('/download/');
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
