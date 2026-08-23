// The picker's arithmetic (N4f-1, criterion 33's logic half).
//
// Everything a 5000-row list has to get right without a device: what "全选"
// means, what the count on the button is, and when a selection is too big to
// submit at all. The device half of criterion 31 is whether the rows on screen
// are the rows that end up in the playlist; this is whether the model behind
// them can be.

import { DOWNLOAD_BATCH_ITEMS_MAX } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import {
  allChosen,
  chooseAll,
  chosenVideos,
  overItemLimit,
  pickable,
  toggleEvery,
  toggleOne,
} from './selection';

const video = (n: number) => ({ bvid: `BV${n}`, title: `第 ${n} 首`, duration: 100 });
const three = [video(1), video(2), video(3)];

describe('rows', () => {
  it('keeps list order', () => {
    expect(pickable(three).map((v) => v.bvid)).toEqual(['BV1', 'BV2', 'BV3']);
  });

  it('collapses a video that appears twice in one list', () => {
    // The engine would merge them onto one task anyway (`#mergeInto`), so two
    // rows would promise a download that cannot happen — and `FlatList` would
    // have two rows under one key.
    const rows = pickable([video(1), video(2), video(1)]);
    expect(rows.map((v) => v.bvid)).toEqual(['BV1', 'BV2']);
  });
});

describe('ticking', () => {
  it('starts with everything chosen (decision e)', () => {
    expect(chooseAll(three)).toEqual(new Set(['BV1', 'BV2', 'BV3']));
  });

  it('toggles one row without touching the others', () => {
    const after = toggleOne(chooseAll(three), 'BV2');
    expect([...after].sort()).toEqual(['BV1', 'BV3']);
    expect(toggleOne(after, 'BV2')).toEqual(new Set(['BV1', 'BV2', 'BV3']));
  });

  it('hands back a NEW set every time — React compares by identity', () => {
    const before = chooseAll(three);
    expect(toggleOne(before, 'BV1')).not.toBe(before);
    expect([...before]).toHaveLength(3);
  });

  it('is 全不选 when everything is ticked and 全选 otherwise', () => {
    const all = chooseAll(three);
    expect(allChosen(all, three)).toBe(true);
    expect(toggleEvery(all, three)).toEqual(new Set());

    const partial = toggleOne(all, 'BV2');
    expect(allChosen(partial, three)).toBe(false);
    expect(toggleEvery(partial, three)).toEqual(all);
  });

  it('counts fullness against the rows, not against the set', () => {
    // A set carrying a bvid this list does not have must not make a complete
    // selection look partial forever.
    const stale = new Set(['BV1', 'BV2', 'BV3', 'BV99']);
    expect(allChosen(stale, three)).toBe(true);
    expect(chosenVideos(three, stale).map((v) => v.bvid)).toEqual(['BV1', 'BV2', 'BV3']);
  });

  it('submits the ticked rows in the list’s own order', () => {
    const chosen = new Set(['BV3', 'BV1']);
    expect(chosenVideos(three, chosen).map((v) => v.bvid)).toEqual(['BV1', 'BV3']);
  });
});

describe('the ceiling (decision d)', () => {
  it('says nothing at all up to the limit', () => {
    expect(overItemLimit(0)).toBeNull();
    expect(overItemLimit(DOWNLOAD_BATCH_ITEMS_MAX)).toBeNull();
  });

  it('names the limit AND the current count one past it', () => {
    const said = overItemLimit(DOWNLOAD_BATCH_ITEMS_MAX + 1);
    expect(said).toContain(`${DOWNLOAD_BATCH_ITEMS_MAX}`);
    expect(said).toContain(`${DOWNLOAD_BATCH_ITEMS_MAX + 1}`);
    // The desktop's sentence, verbatim — one ceiling, one wording.
    expect(said).toBe(`一次最多 ${DOWNLOAD_BATCH_ITEMS_MAX} 个视频（当前 1001），请分批提交`);
  });
});
