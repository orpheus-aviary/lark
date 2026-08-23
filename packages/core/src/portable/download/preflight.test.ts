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

import { describe, expect, it } from 'vitest';
import { InvalidSourceError, LlmNotConfiguredError } from '../errors.js';
import type { BilibiliClient } from './bilibili.js';
import { preflightSingle } from './preflight.js';

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
    ).rejects.toThrow('这个视频有 2 个分P');
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

  it('does not fire once there is a model — the model picks the part', async () => {
    await expect(
      preflightSingle({ client: client(2), hasLlm: true }, video(null), 'original'),
    ).resolves.toMatchObject({ page: null });
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
