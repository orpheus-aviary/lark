// The shape a multi-part video takes on the wire (2026-08-31 对齐, 判据 1/2/4).
//
// These assertions exist because BOTH ends used to answer this question and
// gave different answers. They are here, in portable, rather than in either
// front end: the phone's vitest whitelist excludes anything that imports
// react-native, so a rule that lives in `parts-picker.tsx` has no test at all
// — which is exactly how the two drifted.

import { describe, expect, it } from 'vitest';
import { partsGroupPayload } from './batch-groups.js';

describe('partsGroupPayload', () => {
  // 判据 1. A group creates its own playlist — that is what makes it a group,
  // and it is the half the phone got wrong (it submitted into whatever the
  // 「存到」 picker was showing).
  it('creates a playlist of its own, named by the caller', () => {
    const group = partsGroupPayload('BV1xx', '钢琴曲集', [1, 3], 'original');

    expect(group.target).toEqual({ kind: 'new', name: '钢琴曲集' });
  });

  // 判据 2. Every row is a PAGE of one video, and none of them carries a
  // title: the pipeline reads the part's own name out of the page list it
  // fetches anyway (§7.4). A title sent from here is a second source for one
  // string.
  it('sends one page per row, all on the same bvid, none of them titled', () => {
    const group = partsGroupPayload('BV1xx', '钢琴曲集', [1, 3], 'clean');

    expect(group.items).toEqual([
      { kind: 'video', bvid: 'BV1xx', page: 1, title: null, naming: 'clean' },
      { kind: 'video', bvid: 'BV1xx', page: 3, title: null, naming: 'clean' },
    ]);
  });

  // 判据 4. A video is not a list. `source` is what a download record repeats
  // forever, so inventing a list identity here is a lie with a long life.
  it('claims no list identity', () => {
    const group = partsGroupPayload('BV1xx', '钢琴曲集', [1], 'original');

    expect(group.source).toBeUndefined();
  });

  // One answer for the whole group, on every row — a batch item carries its
  // own mode on the wire, so "one group, one naming" is a property of what is
  // built here rather than something the engine enforces.
  it('carries the naming answer onto every row', () => {
    const group = partsGroupPayload('BV1xx', '合集', [1, 2, 5], 'original');

    expect(group.items.map((item) => (item.kind === 'video' ? item.naming : null))).toEqual([
      'original',
      'original',
      'original',
    ]);
  });

  // Not a guard, an observation worth pinning: nothing is picked is a group
  // with no items, and it is the CALLER (the picker's submit button) that
  // refuses it. This function does not invent a refusal of its own.
  it('produces an empty group when nothing was picked', () => {
    const group = partsGroupPayload('BV1xx', '合集', [], 'original');

    expect(group.items).toEqual([]);
    expect(group.target).toEqual({ kind: 'new', name: '合集' });
  });
});
