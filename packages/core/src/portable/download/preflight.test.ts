// The three LLM gates, where they are decided (N4e-3).
//
// They had no direct test until now: the daemon reached them through a route
// and the phone through a shell, so what was pinned was always something
// wrapped around them. That mattered on 2026-08-23, when the mobile shell was
// found reading "the gate did not throw" as a refusal — a bug about the gate's
// SUCCESS, which nothing was watching.
//
// This is also where the multi-part counter-test lives now. It used to be a
// device procedure — edit portable, rebuild, install, watch it go red, revert,
// rebuild — two builds and a phone for one boolean. Deleting the `pages.length
// > 1` branch turns the case below red in under a second, which is the same
// information at a thousandth of the cost.

import { FETCH_LIST_ITEMS_MAX, FETCH_LIST_PAGES_MAX } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { InvalidSourceError, LlmNotConfiguredError } from '../errors.js';
import type { BilibiliClient } from './bilibili.js';
import { fetchList, preflightSingle } from './preflight.js';

const BVID = 'BV1LtgV6ZE2U';

/** `pagelist` is the only method the single-input preflight can reach. */
function client(parts: number): BilibiliClient {
  const pages = Array.from({ length: parts }, (_, i) => ({
    cid: 1000 + i,
    page: i + 1,
    part: `P${i + 1}`,
    duration: 100,
  }));
  return { pagelist: () => Promise.resolve(pages) } as unknown as BilibiliClient;
}

const video = (page: number | null) =>
  ({ kind: 'video', bvid: BVID, page, url: `https://b.tv/${BVID}` }) as const;

describe('the keyword gate', () => {
  it('refuses without a model, and says what would fix it', async () => {
    await expect(
      preflightSingle(
        { client: client(1), hasLlm: false },
        { kind: 'keyword', query: 'x' },
        undefined,
      ),
    ).rejects.toThrow(LlmNotConfiguredError);
  });

  it('RETURNS a keyword target once there is one — the gate opening is a result', async () => {
    const target = await preflightSingle(
      { client: client(1), hasLlm: true },
      { kind: 'keyword', query: 'Yesterday Once More' },
      undefined,
    );
    expect(target).toEqual({ kind: 'keyword', query: 'Yesterday Once More' });
  });
});

describe('the clean-naming gate', () => {
  it('refuses without a model', async () => {
    await expect(
      preflightSingle({ client: client(1), hasLlm: false }, video(1), 'clean'),
    ).rejects.toThrow(LlmNotConfiguredError);
  });

  it('lets `original` through without one', async () => {
    await expect(
      preflightSingle({ client: client(1), hasLlm: false }, video(1), 'original'),
    ).resolves.toEqual({ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' });
  });

  it('is a caller bug, not a user error, when a video arrives with no mode', async () => {
    await expect(
      preflightSingle({ client: client(1), hasLlm: false }, video(1), undefined),
    ).rejects.toThrow(InvalidSourceError);
  });
});

describe('the multi-part gate (criterion 28, and its counter-test)', () => {
  it('refuses a multi-part video with no ?p= and no model, naming the count', async () => {
    await expect(
      preflightSingle({ client: client(2), hasLlm: false }, video(null), 'original'),
    ).rejects.toMatchObject({
      code: 'MULTI_PART_UNRESOLVED',
      message: expect.stringContaining('这个视频有 2 个分P'),
    });
  });

  // The two cases that make the one above meaningful: delete the gate and this
  // file still passes them, so they are what says the refusal is NARROW.
  it('does not fire when the link carries ?p=', async () => {
    await expect(
      preflightSingle({ client: client(2), hasLlm: false }, video(2), 'original'),
    ).resolves.toMatchObject({ page: 2 });
  });

  it('does not fire on a single-part video', async () => {
    await expect(
      preflightSingle({ client: client(1), hasLlm: false }, video(null), 'original'),
    ).resolves.toMatchObject({ page: null });
  });

  // 🔴 INVERTED IN 0.5.1 (§7.3-e). It used to assert that a configured model
  // made the refusal go away, because the model picked the part — and answered
  // "1" whenever it could not tell. Nothing guesses now, so a model changes
  // nothing here, and this is the test that says so.
  it('fires even with a model configured — nothing guesses a part any more', async () => {
    await expect(
      preflightSingle({ client: client(2), hasLlm: true }, video(null), 'original'),
    ).rejects.toMatchObject({ code: 'MULTI_PART_UNRESOLVED' });
  });
});

describe('what a phone cannot submit at all', () => {
  it('sends a favourites link to the list route instead', async () => {
    await expect(
      preflightSingle(
        { client: client(1), hasLlm: true },
        { kind: 'favorites', media_id: '1', url: 'https://b.tv/fav' },
        undefined,
      ),
    ).rejects.toThrow(InvalidSourceError);
  });
});

// ─── criterion 32: a list that came back short says so ──
//
// `fetchList` never fails a walk that got somewhere: it returns what it has and
// puts the reason in `error`, and a caller showing a truncated list as the
// whole thing is exactly what that field exists to prevent. Truncation rides
// the SAME field as a mid-walk failure, which is what makes the mobile shell's
// job "pass `error` through untouched" rather than "decide whether this was bad
// enough to mention".
//
// COUNTER-TEST (N4f-1, run on 2026-08-23): deleting the `error === null &&
// truncated` step in `fetchList` turns the two truncation cases below red and
// nothing else — the failure path keeps its message, so only the guardrail's
// own sentence is at stake. That is the whole of what the reverse test used to
// be asked of a device.

const listVideo = (n: number) => ({ bvid: `BV${n}`, title: `第 ${n} 首`, duration: 100 });

function listClient(over: {
  favoritesPage?: BilibiliClient['favoritesPage'];
  collectionPage?: BilibiliClient['collectionPage'];
}): BilibiliClient {
  return over as unknown as BilibiliClient;
}

describe('fetchList: partial success is the contract', () => {
  it('walks a favourites folder to the end and reports no error', async () => {
    const pages = [
      { title: '我的收藏', videos: [listVideo(1), listVideo(2)], hasMore: true },
      { title: '我的收藏', videos: [listVideo(3)], hasMore: false },
    ];
    const result = await fetchList(
      listClient({ favoritesPage: (_id, page) => Promise.resolve(pages[page - 1] ?? pages[1]) }),
      { type: 'favorites', media_id: '456' },
    );

    expect(result.title).toBe('我的收藏');
    expect(result.videos.map((v) => v.bvid)).toEqual(['BV1', 'BV2', 'BV3']);
    expect(result.error).toBeNull();
  });

  it('stops a collection at the total the API declares', async () => {
    let calls = 0;
    const result = await fetchList(
      listClient({
        collectionPage: () => {
          calls++;
          return Promise.resolve({ title: '合集·练习曲', videos: [listVideo(calls)], total: 2 });
        },
      }),
      { type: 'collection', mid: '1', season_id: '2' },
    );

    expect(calls).toBe(2);
    expect(result.videos).toHaveLength(2);
    expect(result.error).toBeNull();
  });

  it('keeps what it got when a page fails, and says why it stopped', async () => {
    const result = await fetchList(
      listClient({
        favoritesPage: (_id, page) =>
          page === 1
            ? Promise.resolve({ title: '我的收藏', videos: [listVideo(1)], hasMore: true })
            : Promise.reject(new Error('网络断了')),
      }),
      { type: 'favorites', media_id: '456' },
    );

    expect(result.videos).toHaveLength(1);
    expect(result.error).toBe('网络断了');
  });

  it('refuses — rather than returning an empty list — when nothing came back', async () => {
    // The one case that throws. "This link does not work" is not a list with a
    // warning on it, and a picker that opened on zero rows would be asking
    // somebody to choose from nothing.
    await expect(
      fetchList(listClient({ favoritesPage: () => Promise.reject(new Error('收藏夹不存在')) }), {
        type: 'favorites',
        media_id: '456',
      }),
    ).rejects.toThrow('收藏夹不存在');
  });

  it('names both guardrails when the page cap stops the walk', async () => {
    let calls = 0;
    const result = await fetchList(
      listClient({
        favoritesPage: () => {
          calls++;
          return Promise.resolve({ title: '大收藏夹', videos: [listVideo(calls)], hasMore: true });
        },
      }),
      { type: 'favorites', media_id: '456' },
    );

    expect(calls).toBe(FETCH_LIST_PAGES_MAX);
    expect(result.videos).toHaveLength(FETCH_LIST_PAGES_MAX);
    // The numbers are IN the sentence: "只取回了前 N 条" without them reads as
    // a complete list of N.
    expect(result.error).toContain(`${FETCH_LIST_PAGES_MAX} 页`);
    expect(result.error).toContain(`${FETCH_LIST_ITEMS_MAX} 条`);
  });

  it('names both guardrails when the item cap stops the walk', async () => {
    const page = {
      title: '大收藏夹',
      videos: Array.from({ length: 1000 }, (_, i) => listVideo(i)),
      hasMore: true,
    };
    const result = await fetchList(listClient({ favoritesPage: () => Promise.resolve(page) }), {
      type: 'favorites',
      media_id: '456',
    });

    expect(result.videos).toHaveLength(FETCH_LIST_ITEMS_MAX);
    expect(result.error).toContain(`${FETCH_LIST_ITEMS_MAX} 条`);
  });
});
