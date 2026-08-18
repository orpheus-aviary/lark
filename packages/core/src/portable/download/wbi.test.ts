// WBI is the one place where "it runs" and "it is correct" come apart: a wrong
// mixin key or a mis-ordered query still produces a 32-char hex string, and
// bilibili just answers -403. So the signing half is pinned to the fixed
// vector published in bilibili-API-collect, and the nav reader is tested
// against the response shape observed live (envelope code -101, keys present).

import { describe, expect, it } from 'vitest';
import { BilibiliApiError } from '../errors.js';
import { fetchBuvid, fetchWbiKeys, getMixinKey, randomBuvid3, signWbiParams } from './wbi.js';

const KEYS = {
  imgKey: '7cd084941338484aae1ad9425b84077c',
  subKey: '4932caff0ff746eab6f01bf08b70ac45',
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('mixin key derivation', () => {
  it('matches the published vector', () => {
    expect(getMixinKey(KEYS.imgKey, KEYS.subKey)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('always produces 32 chars', () => {
    expect(getMixinKey(KEYS.imgKey, KEYS.subKey)).toHaveLength(32);
  });
});

describe('signWbiParams', () => {
  it('matches the published signature vector', () => {
    const signed = signWbiParams({ foo: '114', bar: '514', zab: 1919810 }, KEYS, 1702204169);
    expect(signed).toBe(
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    );
  });

  it('sorts parameters by key regardless of insertion order', () => {
    const a = signWbiParams({ zab: 1919810, foo: '114', bar: '514' }, KEYS, 1702204169);
    const b = signWbiParams({ bar: '514', zab: 1919810, foo: '114' }, KEYS, 1702204169);
    expect(a).toBe(b);
  });

  // bilibili's own client strips these from values before hashing; keeping
  // them would sign a different string than the server verifies.
  it("strips !'()* from values before hashing", () => {
    const withPunct = signWbiParams({ keyword: "a!b'c(d)e*f" }, KEYS, 1);
    const without = signWbiParams({ keyword: 'abcdef' }, KEYS, 1);
    expect(withPunct).toBe(without);
  });

  it('percent-encodes the rest, including CJK keywords', () => {
    const signed = signWbiParams({ keyword: '周杰伦 稻香' }, KEYS, 1);
    expect(signed).toContain('keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6%20%E7%A8%BB%E9%A6%99');
  });

  it('folds wts into the signed set, not just onto the end', () => {
    const early = signWbiParams({ aaa: '1' }, KEYS, 100);
    const late = signWbiParams({ aaa: '1' }, KEYS, 200);
    expect(early).not.toBe(late);
    expect(early).toContain('aaa=1&wts=100&w_rid=');
  });
});

describe('fetchWbiKeys', () => {
  const navBody = (imgUrl: string, subUrl: string, code = -101) => ({
    code,
    message: code === -101 ? '账号未登录' : '0',
    data: { wbi_img: { img_url: imgUrl, sub_url: subUrl } },
  });

  // The live behaviour: anonymous nav answers -101 AND carries the keys.
  // Treating the envelope code as authoritative here fails on a healthy setup.
  it('accepts the keys even though the envelope says "not logged in"', async () => {
    const impl = (async () =>
      jsonResponse(
        navBody(
          `https://i0.hdslb.com/bfs/wbi/${KEYS.imgKey}.png`,
          `https://i0.hdslb.com/bfs/wbi/${KEYS.subKey}.png`,
        ),
      )) as unknown as typeof fetch;
    expect(await fetchWbiKeys(impl, {}, AbortSignal.timeout(1000))).toEqual(KEYS);
  });

  it('rejects a response with no wbi_img', async () => {
    const impl = (async () => jsonResponse({ code: 0, data: {} })) as unknown as typeof fetch;
    await expect(fetchWbiKeys(impl, {}, AbortSignal.timeout(1000))).rejects.toThrow(
      BilibiliApiError,
    );
  });

  it('rejects an HTML body (risk-control page in front of nav)', async () => {
    const impl = (async () => new Response('<html>no</html>')) as unknown as typeof fetch;
    await expect(fetchWbiKeys(impl, {}, AbortSignal.timeout(1000))).rejects.toThrow(/non-JSON/);
  });
});

describe('fetchBuvid', () => {
  it('uses the pair spi issues', async () => {
    const impl = (async () =>
      jsonResponse({ code: 0, data: { b_3: 'B3', b_4: 'B4' } })) as unknown as typeof fetch;
    expect(await fetchBuvid(impl, {}, AbortSignal.timeout(1000))).toEqual({
      buvid3: 'B3',
      buvid4: 'B4',
    });
  });

  // Losing search because the identity endpoint blipped would be a bad trade:
  // a locally generated buvid3 still works everywhere it is only a cookie.
  it('falls back to a generated buvid3 when spi fails', async () => {
    const impl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const buvid = await fetchBuvid(impl, {}, AbortSignal.timeout(1000));
    expect(buvid.buvid3).toMatch(/^[0-9A-F]{32}infoc$/);
    expect(buvid.buvid4).toBe('');
  });

  it('falls back when spi answers a non-zero envelope', async () => {
    const impl = (async () => jsonResponse({ code: -412, data: null })) as unknown as typeof fetch;
    const buvid = await fetchBuvid(impl, {}, AbortSignal.timeout(1000));
    expect(buvid.buvid3).toMatch(/infoc$/);
  });

  it('generates a distinct buvid3 each time', () => {
    expect(randomBuvid3()).not.toBe(randomBuvid3());
  });
});
