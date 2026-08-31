// The parts of one multi-part video, as the picker sees them (0.5.1 §7.3).

import type { DownloadPartsData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { partItems, partRows } from './parts';

const data: DownloadPartsData = {
  bvid: 'BV1',
  title: '【司夏　古风歌曲合集】分集',
  parts: [
    { page: 1, part: '烟雨行舟', duration: 215 },
    { page: 2, part: '半壶纱', duration: null },
    { page: 3, part: '', duration: 0 },
  ],
};

describe('partRows', () => {
  it('keys by the page, because that is what goes back as ?p=', () => {
    expect(partRows(data).map((row) => row.key)).toEqual(['1', '2', '3']);
  });

  it('labels a part with its own title', () => {
    expect(partRows(data)[0]?.label).toBe('烟雨行舟');
  });

  // A part with no title of its own still has to be tickable, and 「P3」 is
  // the only name it has.
  it('names an untitled part after its number', () => {
    expect(partRows(data)[2]?.label).toBe('P3');
  });

  // `null` rather than 0:00 — bilibili's "unknown" is 0, and a row claiming a
  // three-part collection is all zero-length is worse than one saying nothing.
  it('says nothing about a duration bilibili did not give', () => {
    expect(partRows(data).map((row) => row.note)).toEqual(['3:35', null, null]);
  });

  // A part is already in the video's own page list, so unlike a pasted line it
  // can never be un-tickable.
  it('never refuses a row', () => {
    expect(partRows(data).every((row) => row.reason === null)).toBe(true);
  });
});

describe('partItems', () => {
  it('sends the page and no title, under one naming answer', () => {
    const rows = partRows(data).filter((row) => row.page !== 2);
    expect(partItems('BV1', rows, 'clean')).toEqual([
      // 🔴 `title: null` on every one: the pipeline reads the part's own title
      // out of the page list it fetches anyway (§7.4), and two sources for one
      // string drift. The desktop and the CLI send exactly this.
      { kind: 'video', bvid: 'BV1', page: 1, title: null, naming: 'clean' },
      { kind: 'video', bvid: 'BV1', page: 3, title: null, naming: 'clean' },
    ]);
  });
});
