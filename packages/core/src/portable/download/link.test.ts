// Link recognition is a security boundary as much as a UX one: whatever
// `parseSongInput` calls a bilibili video becomes a network request and,
// eventually, a `source_key` in the database. So the table below spends most
// of its rows on the shapes that LOOK like bilibili and are not.

import { describe, expect, it, vi } from 'vitest';
import { InvalidSourceError } from '../errors.js';
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

  // Copying out of an address bar drops the scheme, and without the repair the
  // whole URL becomes a search query.
  it('repairs a scheme-less paste of a known bilibili host', () => {
    for (const host of ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']) {
      expect(parseSongInput(`${host}/video/${BVID}?p=2`)).toMatchObject({
        kind: 'video',
        bvid: BVID,
        page: 2,
      });
    }
    expect(parseSongInput('space.bilibili.com/9666167/favlist?fid=96661672')).toMatchObject({
      kind: 'favorites',
    });
    expect(parseSongInput('b23.tv/abc123')).toMatchObject({ kind: 'short_link' });
  });

  // The trailing slash in the prefix is what makes the repair safe.
  it('does not repair a host that merely starts with bilibili.com', () => {
    expect(parseSongInput(`bilibili.com.evil.test/video/${BVID}`)).toMatchObject({
      kind: 'keyword',
    });
    expect(parseSongInput(`notbilibili.com/video/${BVID}`)).toMatchObject({ kind: 'keyword' });
  });

  it('leaves a sentence that happens to start with a host alone', () => {
    expect(parseSongInput('bilibili.com/video 上那首歌')).toMatchObject({ kind: 'keyword' });
  });

  it('still applies the path and host checks after repairing', () => {
    expect(() => parseSongInput('www.bilibili.com/bangumi/play/ep1')).toThrow(/无法识别/);
    expect(() => parseSongInput('www.bilibili.com/video/BV1Ki4y0y7HC')).toThrow(/BV 号/);
  });

  // A port or credentials cannot reach the repair at all: `new URL` reads
  // everything before the first `:` as a scheme, so these parse "successfully"
  // as a bogus scheme and die at the https check. Asserted so a future change
  // to the repair order has to keep them rejected.
  it('rejects a scheme-less string carrying a port or credentials', () => {
    expect(() => parseSongInput(`www.bilibili.com:8443/video/${BVID}`)).toThrow(InvalidSourceError);
    expect(() => parseSongInput(`user:pw@www.bilibili.com/video/${BVID}`)).toThrow(
      InvalidSourceError,
    );
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

  // A target that is still a short link is a bad input (InvalidSourceError →
  // 400), not a normalize failure (502): the daemon route has always answered
  // 400 here, and the extracted preflight keeps that (§1.2).
  it('follows exactly one hop', async () => {
    const client = clientWith(async () => 'https://b23.tv/second');
    await expect(resolveInput(client, 'https://b23.tv/first')).rejects.toThrow(InvalidSourceError);
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
