// Link recognition is a security boundary as much as a UX one: whatever
// `parseSongInput` calls a bilibili video becomes a network request and,
// eventually, a `source_key` in the database. So the table below spends most
// of its rows on the shapes that LOOK like bilibili and are not.

import { describe, expect, it, vi } from 'vitest';
import { InvalidSourceError, NormalizeFailedError } from '../errors.js';
import type { BilibiliClient } from './bilibili.js';
import { buildVideoUrl, normalizeSourceOnline, parseSongInput, resolveInput } from './link.js';

const BVID = 'BV1Ki4y1y7HC';

describe('parseSongInput — videos', () => {
  it('accepts a bare bvid', () => {
    expect(parseSongInput(BVID)).toEqual({
      kind: 'video',
      bvid: BVID,
      page: null,
      url: `https://www.bilibili.com/video/${BVID}`,
    });
  });

  it('accepts a watch URL and keeps ?p=', () => {
    const parsed = parseSongInput(`https://www.bilibili.com/video/${BVID}?p=3&t=12`);
    expect(parsed).toMatchObject({ kind: 'video', bvid: BVID, page: 3 });
  });

  it('reports page as null when ?p= is absent (auto-select stays open)', () => {
    expect(parseSongInput(`https://www.bilibili.com/video/${BVID}`)).toMatchObject({ page: null });
  });

  it('accepts the mobile host', () => {
    expect(parseSongInput(`https://m.bilibili.com/video/${BVID}`)).toMatchObject({ bvid: BVID });
  });

  it('rejects a non-positive or non-numeric ?p=', () => {
    for (const p of ['0', '-1', 'abc', '1.5', '']) {
      expect(() => parseSongInput(`https://www.bilibili.com/video/${BVID}?p=${p}`)).toThrow(
        InvalidSourceError,
      );
    }
  });

  // base58: no 0, I, O or l. A bvid that fails this is not a bvid.
  it('rejects bvids outside the base58 alphabet', () => {
    for (const bad of ['BV1Ki4y0y7HC', 'BV1Ki4yIy7HC', 'BV1Ki4yOy7HC', 'BV1Ki4yly7HC']) {
      expect(() => parseSongInput(`https://www.bilibili.com/video/${bad}`)).toThrow(
        InvalidSourceError,
      );
      // …and as bare text it is a keyword, not a video.
      expect(parseSongInput(bad)).toMatchObject({ kind: 'keyword' });
    }
  });

  it('rejects the wrong bvid length', () => {
    expect(() => parseSongInput('https://www.bilibili.com/video/BV1Ki4y1y7H')).toThrow();
    expect(() => parseSongInput('https://www.bilibili.com/video/BV1Ki4y1y7HCX')).toThrow();
  });

  it('names av numbers as unsupported instead of failing vaguely', () => {
    expect(() => parseSongInput('https://www.bilibili.com/video/av170001')).toThrow(/av 号/);
  });
});

describe('parseSongInput — lists', () => {
  it('recognises a favourites link', () => {
    expect(
      parseSongInput('https://space.bilibili.com/9666167/favlist?fid=96661672&ftype=create'),
    ).toMatchObject({ kind: 'favorites', media_id: '96661672' });
  });

  it('rejects a favourites link with no fid', () => {
    expect(() => parseSongInput('https://space.bilibili.com/9666167/favlist')).toThrow(/fid/);
  });

  it('recognises a collection link', () => {
    expect(
      parseSongInput('https://space.bilibili.com/229733301/lists/5981270?type=season'),
    ).toMatchObject({ kind: 'collection', mid: '229733301', season_id: '5981270' });
  });
});

describe('parseSongInput — rejections', () => {
  it('treats free text as a keyword', () => {
    expect(parseSongInput('  周杰伦 稻香  ')).toEqual({ kind: 'keyword', query: '周杰伦 稻香' });
  });

  it('rejects empty input', () => {
    expect(() => parseSongInput('   ')).toThrow(InvalidSourceError);
  });

  it('rejects a non-bilibili URL with an actionable message', () => {
    expect(() => parseSongInput('https://www.youtube.com/watch?v=x')).toThrow(/不是 B 站链接/);
  });

  // The four shapes that defeat a naive host check.
  it('rejects hosts that only look like bilibili', () => {
    const impostors = [
      'https://bilibili.com.evil.test/video/BV1Ki4y1y7HC',
      'https://notbilibili.com/video/BV1Ki4y1y7HC',
      'https://evil.test/?next=https://www.bilibili.com/video/BV1Ki4y1y7HC',
      'https://xxbilibili.com/video/BV1Ki4y1y7HC',
    ];
    for (const url of impostors) {
      expect(() => parseSongInput(url)).toThrow(/不是 B 站链接/);
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => parseSongInput(`https://user:pw@www.bilibili.com/video/${BVID}`)).toThrow(
      /用户名/,
    );
  });

  it('rejects an explicit port', () => {
    expect(() => parseSongInput(`https://www.bilibili.com:8443/video/${BVID}`)).toThrow(/端口/);
  });

  it('rejects non-https schemes', () => {
    expect(() => parseSongInput(`http://www.bilibili.com/video/${BVID}`)).toThrow(/https/);
    expect(() => parseSongInput('javascript:alert(1)')).toThrow();
    expect(() => parseSongInput('file:///etc/passwd')).toThrow();
  });

  it('rejects a bilibili URL that is not a video, favourites or collection', () => {
    expect(() => parseSongInput('https://www.bilibili.com/bangumi/play/ep123')).toThrow(/无法识别/);
  });
});

describe('resolveInput — b23.tv expansion', () => {
  const clientWith = (expand: (url: string) => Promise<string>): BilibiliClient =>
    ({ expandShortLink: (url: string) => expand(url) }) as unknown as BilibiliClient;

  it('classifies a short link only after one hop', async () => {
    const expand = vi.fn(async () => `https://www.bilibili.com/video/${BVID}?p=2`);
    const parsed = await resolveInput(clientWith(expand), 'https://b23.tv/abc123');
    expect(parsed).toMatchObject({ kind: 'video', bvid: BVID, page: 2 });
    expect(expand).toHaveBeenCalledOnce();
  });

  it('re-validates the target — a short link off bilibili is still refused', async () => {
    const client = clientWith(async () => 'https://evil.test/video/BV1Ki4y1y7HC');
    await expect(resolveInput(client, 'https://b23.tv/abc123')).rejects.toThrow(/不是 B 站链接/);
  });

  it('follows exactly one hop', async () => {
    const client = clientWith(async () => 'https://b23.tv/second');
    await expect(resolveInput(client, 'https://b23.tv/first')).rejects.toThrow(
      NormalizeFailedError,
    );
  });

  it('leaves non-short-link input untouched (no network)', async () => {
    const expand = vi.fn();
    const parsed = await resolveInput(clientWith(expand as never), BVID);
    expect(parsed).toMatchObject({ kind: 'video' });
    expect(expand).not.toHaveBeenCalled();
  });
});

describe('normalizeSourceOnline', () => {
  const pagesClient = (pages: { page: number; cid: number }[]): BilibiliClient =>
    ({
      pagelist: async () => pages.map((p) => ({ ...p, part: `P${p.page}`, duration: 100 })),
    }) as unknown as BilibiliClient;

  it('resolves p → cid and drops ?p=1 from the canonical url', async () => {
    const source = await normalizeSourceOnline(pagesClient([{ page: 1, cid: 550103819 }]), {
      bvid: BVID,
      page: null,
    });
    expect(source).toMatchObject({
      source_url: `https://www.bilibili.com/video/${BVID}`,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
      page: 1,
      cid: 550103819,
    });
  });

  it("keeps ?p= for a later part and keys on that part's cid", async () => {
    const source = await normalizeSourceOnline(
      pagesClient([
        { page: 1, cid: 111 },
        { page: 2, cid: 222 },
      ]),
      { bvid: BVID, page: 2 },
    );
    expect(source.source_url).toBe(`https://www.bilibili.com/video/${BVID}?p=2`);
    expect(source.source_key).toBe(`${BVID}:222`);
  });

  // The Go version silently downloaded p1 here — a different song than asked for.
  it('refuses an out-of-range page instead of falling back to p1', async () => {
    await expect(
      normalizeSourceOnline(pagesClient([{ page: 1, cid: 111 }]), { bvid: BVID, page: 5 }),
    ).rejects.toThrow(/越界/);
  });

  it('strips tracking parameters by rebuilding the url', async () => {
    const source = await normalizeSourceOnline(pagesClient([{ page: 1, cid: 111 }]), {
      ...(parseSongInput(
        `https://www.bilibili.com/video/${BVID}?spm_id_from=333.1007&vd_source=deadbeef`,
      ) as { bvid: string; page: number | null }),
    });
    expect(source.source_url).toBe(`https://www.bilibili.com/video/${BVID}`);
  });
});

describe('buildVideoUrl', () => {
  it('omits ?p=1 and keeps everything above it', () => {
    expect(buildVideoUrl(BVID, 1)).toBe(`https://www.bilibili.com/video/${BVID}`);
    expect(buildVideoUrl(BVID, 2)).toBe(`https://www.bilibili.com/video/${BVID}?p=2`);
  });
});
