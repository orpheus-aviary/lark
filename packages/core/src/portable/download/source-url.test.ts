// Criterion 60 (N4i-1): the six branches, where they now live.
//
// The daemon route these came from keeps its own tests
// (`routes/songs-download.test.ts`) and they were written BEFORE the move —
// that pair is what "zero behaviour change" is asserted against. What is added
// here is what a route test cannot reach cheaply: every branch, including the
// two that were only observable through a fake HTTP server, and the short-link
// hop as a decision rather than as a redirect.

import { describe, expect, it } from 'vitest';
import { InvalidSourceError, NormalizeFailedError } from '../errors.js';
import type { BilibiliClient } from './bilibili.js';
import { recognizeSourceUrl, resolveSourceUrl } from './source-url.js';

const BVID = 'BV1Ki4y1y7HC';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;
const FAVOURITES = 'https://space.bilibili.com/12345/favlist?fid=678&ftype=create';

interface Calls {
  expanded: string[];
  pagelists: string[];
  views: string[];
}

/** Two methods and a title is everything these two functions can reach. */
function client(options: { expandsTo?: string; expandFails?: boolean } = {}): {
  client: BilibiliClient;
  calls: Calls;
} {
  const calls: Calls = { expanded: [], pagelists: [], views: [] };
  return {
    calls,
    client: {
      expandShortLink: (url: string) => {
        calls.expanded.push(url);
        if (options.expandFails === true) {
          return Promise.reject(new NormalizeFailedError('b23 is down'));
        }
        return Promise.resolve(options.expandsTo ?? VIDEO_URL);
      },
      pagelist: (bvid: string) => {
        calls.pagelists.push(bvid);
        return Promise.resolve([{ cid: 550103819, page: 1, part: 'P1', duration: 100 }]);
      },
      view: (bvid: string) => {
        calls.views.push(bvid);
        return Promise.resolve({ title: '【私藏馆】周杰伦《稻香》' });
      },
    } as unknown as BilibiliClient,
  };
}

describe('resolveSourceUrl', () => {
  it('clears all three when there is no url', async () => {
    const { client: bili, calls } = client();
    for (const empty of [null, '']) {
      expect(await resolveSourceUrl(bili, empty)).toEqual({
        source_url: null,
        source_provider: null,
        source_key: null,
      });
    }
    // Clearing a link is not a question anyone needs to be asked.
    expect(calls).toEqual({ expanded: [], pagelists: [], views: [] });
  });

  it('normalises a bilibili video online, dropping what the URL carried', async () => {
    const { client: bili, calls } = client();
    expect(await resolveSourceUrl(bili, `${VIDEO_URL}?spm_id_from=333&vd_source=x`)).toEqual({
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
    });
    expect(calls.pagelists).toEqual([BVID]);
  });

  it('expands a short link once and judges what it expanded to', async () => {
    const { client: bili, calls } = client({ expandsTo: `${VIDEO_URL}?p=1` });
    expect(await resolveSourceUrl(bili, 'https://b23.tv/cfzPKZX')).toMatchObject({
      // The stored url is the target, never the short link: nothing downstream
      // should have to make that hop a second time.
      source_url: VIDEO_URL,
      source_key: `${BVID}:550103819`,
    });
    expect(calls.expanded).toEqual(['https://b23.tv/cfzPKZX']);
  });

  it('refuses a short link that expands into another short link', async () => {
    // The route this came from recursed here, which for a redirect loop meant
    // expanding forever. One hop is the rule the preflight already uses.
    const { client: bili } = client({ expandsTo: 'https://b23.tv/second' });
    await expect(resolveSourceUrl(bili, 'https://b23.tv/first')).rejects.toThrow(
      InvalidSourceError,
    );
  });

  it('keeps a favourites link as a url with no identity', async () => {
    const { client: bili, calls } = client();
    expect(await resolveSourceUrl(bili, FAVOURITES)).toEqual({
      source_url: FAVOURITES,
      source_provider: null,
      source_key: null,
    });
    expect(calls.pagelists).toEqual([]); // a list is not one song
  });

  it('keeps any other http(s) link the same way (R8)', async () => {
    const { client: bili } = client();
    expect(await resolveSourceUrl(bili, 'https://example.com/track')).toEqual({
      source_url: 'https://example.com/track',
      source_provider: null,
      source_key: null,
    });
  });

  it('refuses what is not a link at all', async () => {
    const { client: bili } = client();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y']) {
      await expect(resolveSourceUrl(bili, bad)).rejects.toThrow(InvalidSourceError);
    }
  });

  // CHARACTERIZATION of an oddity, not an endorsement (§8): free text has
  // always been stored as though it were a url — `parseSongInput` reads it as
  // a keyword, and a keyword is "not a video", which is the keep-it branch.
  // Recorded here so that changing it is a decision somebody makes on purpose.
  it('stores free text as a url, which is what the route has always done', async () => {
    const { client: bili } = client();
    expect(await resolveSourceUrl(bili, '稻香')).toEqual({
      source_url: '稻香',
      source_provider: null,
      source_key: null,
    });
  });

  it('propagates a failed expansion instead of storing the short link', async () => {
    // The one case where "keep it as a url" would be a lie: nothing was
    // recognised because the network broke, not because the link is plain.
    const { client: bili } = client({ expandFails: true });
    await expect(resolveSourceUrl(bili, 'https://b23.tv/cfzPKZX')).rejects.toThrow(
      NormalizeFailedError,
    );
  });
});

describe('recognizeSourceUrl', () => {
  it('answers with the triple and the title, and writes nothing', async () => {
    const { client: bili, calls } = client();
    expect(await recognizeSourceUrl(bili, VIDEO_URL)).toEqual({
      source_url: VIDEO_URL,
      source_provider: 'bilibili',
      source_key: `${BVID}:550103819`,
      video_title: '【私藏馆】周杰伦《稻香》',
    });
    expect(calls.views).toEqual([BVID]);
  });

  it('expands a short link first', async () => {
    const { client: bili, calls } = client();
    await expect(recognizeSourceUrl(bili, 'https://b23.tv/cfzPKZX')).resolves.toMatchObject({
      source_key: `${BVID}:550103819`,
    });
    expect(calls.expanded).toHaveLength(1);
  });

  it('refuses anything that is not one video — unlike the save path', async () => {
    // The asymmetry is the point: saving a plain url is a shrug, previewing
    // one has nothing to show.
    const { client: bili } = client();
    for (const notAVideo of [FAVOURITES, 'https://example.com/track', '稻香']) {
      await expect(recognizeSourceUrl(bili, notAVideo)).rejects.toThrow(InvalidSourceError);
    }
  });
});
