// What a group becomes on the wire (0.5.1「格式也和合集完全统一」).

import { partsGroupPayload } from '@lark/core/portable';
import { describe, expect, it } from 'vitest';
import { type BatchGroup, checkedRows, groupPayload } from './batch-groups.js';

const list: BatchGroup = {
  kind: 'list',
  id: 'favorites:1',
  query: { type: 'favorites', media_id: '1' },
  source: { kind: 'favorites', media_id: '1', url: 'https://x/1' },
  title: '我的收藏夹',
  useOriginalTitle: true,
  rows: [
    { key: 'BV1', label: '第一首', checked: true },
    { key: 'BV2', label: '第二首', checked: false },
  ],
  loading: false,
  error: null,
};

const parts: BatchGroup = {
  kind: 'parts',
  id: 'parts:BV9',
  bvid: 'BV9',
  title: '古风合集',
  useOriginalTitle: false,
  rows: [
    { key: '1', label: '烟雨行舟', checked: true },
    { key: '3', label: '半壶纱', checked: true },
    { key: '2', label: '不要这首', checked: false },
  ],
  loading: false,
  error: null,
};

describe('groupPayload', () => {
  it('gives every group a playlist of its own, named after it', () => {
    expect(groupPayload(list).target).toEqual({ kind: 'new', name: '我的收藏夹' });
    expect(groupPayload(parts).target).toEqual({ kind: 'new', name: '古风合集' });
  });

  it('sends only what is ticked', () => {
    expect(groupPayload(list).items).toHaveLength(1);
    expect(checkedRows(parts)).toHaveLength(2);
  });

  // 🔴 The one thing that differs between the two, and the reason it does.
  it('carries the list title on a list row, and no title on a part', () => {
    expect(groupPayload(list).items).toEqual([
      // `original` here: the list's own title is the better of the two, and it
      // is also what `clean` would read a song name out of.
      { kind: 'video', bvid: 'BV1', page: null, title: '第一首', naming: 'original' },
    ]);
    expect(groupPayload(parts).items).toEqual([
      // `title: null`: the pipeline reads the part's own title out of the page
      // list it fetches anyway (§7.4). Two sources for one string drift.
      { kind: 'video', bvid: 'BV9', page: 1, title: null, naming: 'clean' },
      { kind: 'video', bvid: 'BV9', page: 3, title: null, naming: 'clean' },
    ]);
  });

  // A list says where its songs came from; a video is not a list, and
  // inventing an identity is a lie the download record repeats forever.
  it('names the source of a list and nothing for a video', () => {
    expect(groupPayload(list).source).toEqual({
      list: 'favorites',
      title: '我的收藏夹',
      url: 'https://x/1',
    });
    expect(groupPayload(parts).source).toBeUndefined();
  });

  // 判据 3（2026-08-31 对齐）. Not "the two look similar" — the SAME function
  // produced both, and this is what goes red the day somebody writes a second
  // copy of the parts branch here. That is the whole failure this batch fixes:
  // the phone had its own copy and it disagreed.
  it('builds a parts group out of the same function the phone uses', () => {
    expect(groupPayload(parts)).toEqual(partsGroupPayload('BV9', '古风合集', [1, 3], 'clean'));
  });

  it('turns the 原标题 tick into the naming mode, per group', () => {
    expect(groupPayload({ ...list, useOriginalTitle: false }).items[0]).toEqual({
      kind: 'video',
      bvid: 'BV1',
      page: null,
      title: '第一首',
      naming: 'clean',
    });
    expect(groupPayload({ ...parts, useOriginalTitle: true }).items[0]).toEqual({
      kind: 'video',
      bvid: 'BV9',
      page: 1,
      title: null,
      naming: 'original',
    });
  });
});
