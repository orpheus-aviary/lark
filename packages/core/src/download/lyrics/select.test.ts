// Selection is where "no LLM configured" has to stay a working path, so the
// heuristic gets the same scrutiny as the LLM one — including the cases where
// they disagree.

import type { LlmConfig } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import type { LyricsCandidate, LyricsPlatform } from './lrc.js';
import {
  collectLyricsCandidates,
  diceSimilarity,
  normalizeForMatch,
  pickByHeuristic,
  scoreCandidate,
  selectLyricsCandidate,
} from './select.js';
import type { LyricsQuery } from './shared.js';

const QUERY: LyricsQuery = { name: '稻香', artist: '周杰伦', duration: 223 };

const LLM: LlmConfig = {
  url: 'https://api.example.com/v1',
  model: 'm',
  api_key: 'k',
  api_format: 'openai',
};

function candidate(
  platform: LyricsPlatform,
  songName: string,
  artist: string,
  endSeconds: number | null,
): LyricsCandidate {
  return {
    platform,
    songName,
    artist,
    lrc: '[00:00.00]x',
    preview: 'x',
    tailPreview: 'x',
    endTime: endSeconds === null ? '' : `${Math.floor(endSeconds / 60)}:00`,
    endSeconds,
  };
}

const llmAnswering = (content: string) =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

describe('normalizeForMatch', () => {
  it('folds width, case, whitespace and punctuation', () => {
    expect(normalizeForMatch('Ｄａｏ Xiang!')).toBe('daoxiang');
    expect(normalizeForMatch('稻香 (Live)')).toBe('稻香live');
    expect(normalizeForMatch('R&B — mix')).toBe('rbmix');
  });
});

describe('diceSimilarity', () => {
  it('is 1 for the same string and 0 for disjoint ones', () => {
    expect(diceSimilarity('稻香 周杰伦', '稻香 周杰伦')).toBe(1);
    expect(diceSimilarity('abcd', 'wxyz')).toBe(0);
  });

  it('handles single-character strings, where there are no bigrams', () => {
    expect(diceSimilarity('a', 'a')).toBe(1);
    expect(diceSimilarity('a', 'b')).toBe(0);
  });

  it('scores a partial overlap between the extremes', () => {
    const partial = diceSimilarity('稻香 周杰伦', '稻香 群星');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});

describe('the frozen heuristic', () => {
  it('prefers the closer title', () => {
    const best = pickByHeuristic(
      [candidate('netease', '晴天', '周杰伦', 223), candidate('qq', '稻香', '周杰伦', 223)],
      QUERY,
    );
    expect(best?.platform).toBe('qq');
  });

  // A 30s TV edit scores 1.0 on title similarity. Only the timestamp catches it.
  it('penalises a title-perfect candidate whose lyrics end far from the audio', () => {
    const best = pickByHeuristic(
      [candidate('netease', '稻香', '周杰伦', 30), candidate('qq', '稻香', '周杰伦', 220)],
      QUERY,
    );
    expect(best?.endSeconds).toBe(220);
  });

  it('caps the penalty at half a point, so duration never outweighs a wrong song', () => {
    const rightSongFarOff = scoreCandidate(candidate('netease', '稻香', '周杰伦', 3000), QUERY);
    const wrongSongPerfectLength = scoreCandidate(candidate('qq', '晴天', '五月天', 223), QUERY);
    expect(rightSongFarOff).toBeGreaterThan(wrongSongPerfectLength);
  });

  it('applies no penalty when the audio duration is unknown', () => {
    const noDuration = { ...QUERY, duration: 0 };
    expect(scoreCandidate(candidate('netease', '稻香', '周杰伦', 9999), noDuration)).toBe(
      scoreCandidate(candidate('netease', '稻香', '周杰伦', 220), noDuration),
    );
  });

  it('applies no penalty when the candidate has no timestamps', () => {
    expect(scoreCandidate(candidate('netease', '稻香', '周杰伦', null), QUERY)).toBe(
      diceSimilarity('稻香 周杰伦', '稻香 周杰伦'),
    );
  });

  // Platform order, then arrival order — a stable answer for a stable input.
  it('breaks ties by platform order', () => {
    const tied = [
      candidate('netease', '稻香', '周杰伦', 223),
      candidate('qq', '稻香', '周杰伦', 223),
      candidate('kugou', '稻香', '周杰伦', 223),
    ];
    expect(pickByHeuristic(tied, QUERY)?.platform).toBe('netease');
    expect(pickByHeuristic([...tied].reverse(), QUERY)?.platform).toBe('kugou');
  });

  it('returns null for an empty pool', () => {
    expect(pickByHeuristic([], QUERY)).toBeNull();
  });
});

describe('selectLyricsCandidate', () => {
  // Same title and artist on both, so the ONLY thing separating them is the
  // duration penalty: the heuristic picks qq (ends at 220s, ~audio length) and
  // never the 30s edit that happens to be first. That makes "fell back to the
  // heuristic" and "took candidate zero" distinguishable outcomes.
  const pool = [candidate('netease', '稻香', '周杰伦', 30), candidate('qq', '稻香', '周杰伦', 220)];

  it('short-circuits a single candidate without calling the LLM', async () => {
    const fetchImpl = vi.fn();
    const only = candidate('kugou', 'whatever', '', null);
    expect(
      await selectLyricsCandidate([only], QUERY, {
        llmConfig: LLM,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBe(only);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Deliberately the candidate the heuristic would NOT pick, so a green here
  // means the LLM's answer was used rather than coincidentally agreed with.
  it('uses the LLM answer when it is a valid 1-based index', async () => {
    const best = await selectLyricsCandidate(pool, QUERY, {
      llmConfig: LLM,
      fetchImpl: llmAnswering('1'),
    });
    expect(best?.platform).toBe('netease');
  });

  it('falls back to the heuristic — not to candidate zero — on a junk answer', async () => {
    for (const answer of ['NONE', '0', '99', 'the second one']) {
      const best = await selectLyricsCandidate(pool, QUERY, {
        llmConfig: LLM,
        fetchImpl: llmAnswering(answer),
      });
      // Go took candidates[0] here, which is the 30s edit.
      expect(best?.platform).toBe('qq');
    }
  });

  it('falls back to the heuristic when the LLM call fails', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const best = await selectLyricsCandidate(pool, QUERY, { llmConfig: LLM, fetchImpl: failing });
    expect(best?.platform).toBe('qq');
  });

  it('uses the heuristic with no LLM configured at all', async () => {
    expect((await selectLyricsCandidate(pool, QUERY))?.platform).toBe('qq');
  });

  it('sends the previews and end_time, but not the full lyrics, to the LLM', async () => {
    let body = '';
    const impl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '1' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await selectLyricsCandidate(pool, QUERY, { llmConfig: LLM, fetchImpl: impl });
    expect(body).toContain('tail_preview');
    expect(body).toContain('end_time');
    expect(body).toContain('音频时长=3:43');
    expect(body).not.toContain('[00:00.00]');
  });

  it('returns null for an empty pool', async () => {
    expect(await selectLyricsCandidate([], QUERY)).toBeNull();
  });
});

describe('collectLyricsCandidates', () => {
  /** All three platforms answer from one fake upstream. */
  const upstream = (options: { neteaseFails?: boolean } = {}) =>
    (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('music.163.com')) {
        if (options.neteaseFails) throw new Error('netease down');
        if (href.includes('/api/search/get')) {
          return json({
            result: { songs: [{ id: 1, name: '稻香', artists: [{ name: '周杰伦' }] }] },
          });
        }
        return json({ lrc: { lyric: '[00:00.00]a\n[03:40.00]b' } });
      }
      if (href.includes('c.y.qq.com')) {
        if (href.includes('client_search_cp')) {
          return json({
            data: {
              song: { list: [{ songmid: 'M', songname: '稻香', singer: [{ name: '周杰伦' }] }] },
            },
          });
        }
        return json({ lyric: Buffer.from('[00:00.00]a\n[03:39.00]b').toString('base64') });
      }
      // kugou: no lyrics for this song
      if (href.includes('/api/v3/search/song')) return json({ data: { info: [] } });
      return json({});
    }) as unknown as typeof fetch;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('pools candidates from every platform that answered', async () => {
    const { candidates, failures } = await collectLyricsCandidates(QUERY, {
      fetchImpl: upstream(),
    });
    expect(candidates.map((c) => c.platform)).toEqual(['netease', 'qq']);
    expect(failures).toEqual([]);
  });

  // The reason for allSettled: one platform's outage must not cost the others.
  it('keeps the other platforms when one throws, and records the failure', async () => {
    const { candidates, failures } = await collectLyricsCandidates(QUERY, {
      fetchImpl: upstream({ neteaseFails: true }),
    });
    expect(candidates.map((c) => c.platform)).toEqual(['qq']);
    expect(failures).toEqual([{ platform: 'netease', message: 'netease down' }]);
  });

  it('reports an empty pool rather than throwing when nothing matched', async () => {
    const empty = (async () => json({})) as unknown as typeof fetch;
    const { candidates } = await collectLyricsCandidates(QUERY, { fetchImpl: empty });
    expect(candidates).toEqual([]);
  });
});
