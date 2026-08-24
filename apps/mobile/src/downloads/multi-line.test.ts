// A paste with more than one line in it (N4h-1, criteria 47 and 48).
//
// Everything here is a decision about a paste, not about a screen: which lines
// are the same line, which of them cost a network hop and when, what happens to
// the ones nobody can download, and what the batch finally carries. The device
// is left with the parts only it can answer — that a real short link expands
// and that the tasks land.

import type { BilibiliClient } from '@lark/core/portable';
import { DOWNLOAD_PARSE_LINES_MAX } from '@lark/shared';
import { describe, expect, it, vi } from 'vitest';
import { eligible, expandLines, lineItems, readLines } from './multi-line';

const BVID = 'BV1LtgV6ZE2U';
const OTHER = 'BV1xx411c7mD';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;
const SHORT = 'https://b23.tv/cfzPKZX';

function client(expand: (url: string) => Promise<string> = () => Promise.resolve(VIDEO_URL)) {
  return { expandShortLink: (url: string) => expand(url) } as unknown as BilibiliClient;
}

const paste = (...lines: string[]) => lines.join('\n');

describe('reading a paste (offline, zero packets)', () => {
  it('settles links, keywords and gibberish line by line', () => {
    const seen = readLines(paste(VIDEO_URL, '莫愁乡', 'https://www.youtube.com/watch?v=x'));

    expect(seen.total).toBe(3);
    expect(seen.ready).toBe(1);
    expect(seen.keywords).toBe(1);
    expect(seen.unusable).toBe(1);
    expect(seen.lines[2]?.refusal).toContain('不是 B 站链接');
  });

  it('does not count blank lines as lines', () => {
    // A paste out of a notes app is full of them, and 「17 行」 in front of
    // somebody who pasted six links is a lie about their input.
    const seen = readLines(paste('', VIDEO_URL, '   ', BVID, ''));
    expect(seen.total).toBe(2);
  });

  it('finds the link inside a shared line, like the single-line box does', () => {
    const seen = readLines(
      paste('莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才 https://b23.tv/cfzPKZX'),
    );
    expect(seen.ready).toBe(1);
    expect(seen.lines[0]?.parsed?.kind).toBe('short_link');
  });

  it('collapses the same submission written twice', () => {
    const seen = readLines(paste(VIDEO_URL, BVID, `${VIDEO_URL}?p=1`, SHORT, SHORT));

    // bvid and full URL are one video; `?p=1` is a different submission (the
    // engine keys them apart too); the repeated short link costs no hop.
    expect(seen.lines).toHaveLength(3);
    expect(seen.lines.map((line) => line.parsed?.kind)).toEqual(['video', 'video', 'short_link']);
  });

  it('refuses a favourites link in a paste, and says where it belongs', () => {
    const seen = readLines(paste(VIDEO_URL, 'https://space.bilibili.com/123/favlist?fid=456'));
    expect(seen.unusable).toBe(1);
    expect(seen.lines[1]?.refusal).toContain('单独粘一条');
  });

  it('refuses the whole paste past the line ceiling, naming both numbers', () => {
    const many = Array.from({ length: DOWNLOAD_PARSE_LINES_MAX + 1 }, () => BVID);
    const seen = readLines(paste(...many));

    // Before any parsing: this is about the size of the request, not its
    // contents. Counter-test: drop the check and this case is the only red.
    expect(seen.refusal).toContain(`${DOWNLOAD_PARSE_LINES_MAX}`);
    expect(seen.refusal).toContain(`${DOWNLOAD_PARSE_LINES_MAX + 1}`);
    expect(seen.lines).toEqual([]);
  });
});

describe('expanding the short links (criterion 48)', () => {
  it('hops only the short links, and at most three at a time', async () => {
    let live = 0;
    let peak = 0;
    const hop = async (url: string): Promise<string> => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return `https://www.bilibili.com/video/BV1${url.slice(-3)}xxxxxxx`;
    };
    const lines = readLines(
      paste(VIDEO_URL, ...Array.from({ length: 6 }, (_, i) => `https://b23.tv/aa${i}`)),
    ).lines;

    const progress = vi.fn();
    const rows = await expandLines({ client: client(hop), hasLlm: false }, lines, {
      onProgress: progress,
    });

    expect(peak).toBeLessThanOrEqual(3);
    // Six hops, one per short link — the video line cost nothing.
    expect(progress).toHaveBeenCalledTimes(6);
    expect(rows).toHaveLength(7);
  });

  it('keeps a line that failed to expand, with the reason on it', async () => {
    const lines = readLines(paste(VIDEO_URL, SHORT)).lines;
    const rows = await expandLines(
      { client: client(() => Promise.reject(new Error('短链失效了'))), hasLlm: false },
      lines,
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]?.reason).toBe('短链失效了');
    expect(rows[1]?.item).toBeNull();
    // Not dropped: somebody who pasted six lines and got five rows would spend
    // the afternoon looking for the one that vanished (decision d).
    expect(eligible(rows)).toHaveLength(1);
  });

  it('collapses two short links that turn out to be the same video', async () => {
    const lines = readLines(paste('https://b23.tv/aaa', 'https://b23.tv/bbb')).lines;
    expect(lines).toHaveLength(2); // different links, so no hop was saved

    const rows = await expandLines({ client: client(), hasLlm: false }, lines);
    // Only the hop could tell. The loser is dropped rather than refused — the
    // paste was not wrong, it was the same song twice.
    expect(rows).toHaveLength(1);
  });

  it('greys out a keyword line with no model, and ticks it with one', async () => {
    const lines = readLines(paste(VIDEO_URL, '莫愁乡')).lines;

    const without = await expandLines({ client: client(), hasLlm: false }, lines);
    expect(without[1]?.item).toBeNull();
    expect(without[1]?.reason).toContain('需要模型');
    expect(eligible(without)).toHaveLength(1);

    const with_ = await expandLines({ client: client(), hasLlm: true }, lines);
    expect(with_[1]?.item).toMatchObject({ kind: 'keyword', query: '莫愁乡' });
    expect(eligible(with_)).toHaveLength(2);
  });

  it('passes the page down the line', async () => {
    const lines = readLines(paste(`${VIDEO_URL}?p=3`)).lines;
    const rows = await expandLines({ client: client(), hasLlm: false }, lines);
    expect(rows[0]?.item).toMatchObject({ kind: 'video', page: 3 });
    expect(rows[0]?.label).toContain('第 3 P');
  });
});

describe('what the batch carries', () => {
  it('gives every video the mode and no title, and the keyword neither', async () => {
    const lines = readLines(
      paste(VIDEO_URL, `https://www.bilibili.com/video/${OTHER}`, '莫愁乡'),
    ).lines;
    const rows = await expandLines({ client: client(), hasLlm: true }, lines);

    expect(lineItems(rows, 'clean')).toEqual([
      { kind: 'video', bvid: BVID, page: null, title: null, naming: 'clean' },
      { kind: 'video', bvid: OTHER, page: null, title: null, naming: 'clean' },
      // No naming mode at all: portable refuses a keyword that carries one.
      { kind: 'keyword', query: '莫愁乡' },
    ]);
  });

  it('leaves out the rows nobody can download', async () => {
    const lines = readLines(paste(VIDEO_URL, 'https://www.youtube.com/watch?v=x', '莫愁乡')).lines;
    const rows = await expandLines({ client: client(), hasLlm: false }, lines);

    // Three rows on screen, one submission: the refusals are shown, not sent.
    expect(rows).toHaveLength(3);
    expect(lineItems(rows, 'original')).toEqual([
      { kind: 'video', bvid: BVID, page: null, title: null, naming: 'original' },
    ]);
  });
});
