// Ranges run in display order and anchors go stale — the two ways a
// multi-selection silently grabs rows the user never pointed at.

import { describe, expect, it } from 'vitest';
import {
  isAllSelected,
  isPartiallySelected,
  pruneMissing,
  rangeBetween,
  toggleIn,
} from './selection.js';

const VIEW = ['a', 'b', 'c', 'd', 'e'];

describe('toggleIn', () => {
  it('appends in click order and removes on a second click', () => {
    expect(toggleIn(['b'], 'a')).toEqual(['b', 'a']);
    expect(toggleIn(['b', 'a'], 'b')).toEqual(['a']);
    expect(toggleIn([], 'a')).toEqual(['a']);
  });

  it('leaves the input untouched', () => {
    const ids = ['a'];
    toggleIn(ids, 'b');
    expect(ids).toEqual(['a']);
  });
});

describe('rangeBetween', () => {
  it('selects downward and upward alike, always in display order', () => {
    expect(rangeBetween(VIEW, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(VIEW, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('is just the target when anchor and target are the same row', () => {
    expect(rangeBetween(VIEW, 'c', 'c')).toEqual(['c']);
  });

  it('falls back to the target alone when the anchor is gone or absent', () => {
    // Selecting from the top instead would grab rows never pointed at.
    expect(rangeBetween(VIEW, 'deleted', 'c')).toEqual(['c']);
    expect(rangeBetween(VIEW, null, 'c')).toEqual(['c']);
  });

  it('selects nothing when the target is not in the view', () => {
    expect(rangeBetween(VIEW, 'a', 'zzz')).toEqual([]);
  });
});

describe('pruneMissing', () => {
  it('drops ids the library no longer has, keeping the rest in order', () => {
    expect(pruneMissing(['c', 'a', 'gone'], new Set(['a', 'b', 'c']))).toEqual(['c', 'a']);
    expect(pruneMissing([], new Set(['a']))).toEqual([]);
    expect(pruneMissing(['gone'], new Set())).toEqual([]);
  });
});

describe('header checkbox states', () => {
  it('is all-selected only when every visible row is in the selection', () => {
    expect(isAllSelected(VIEW, VIEW)).toBe(true);
    // Selection may hold ids outside the view (another playlist's rows).
    expect(isAllSelected(['a', 'b'], ['a', 'b', 'x'])).toBe(true);
    expect(isAllSelected(VIEW, ['a'])).toBe(false);
    expect(isAllSelected([], [])).toBe(false);
  });

  it('is partial when some — but not all — visible rows are selected', () => {
    expect(isPartiallySelected(VIEW, ['b', 'c'])).toBe(true);
    expect(isPartiallySelected(VIEW, VIEW)).toBe(false);
    expect(isPartiallySelected(VIEW, [])).toBe(false);
    // A selection that survived a view change but shares nothing with it.
    expect(isPartiallySelected(VIEW, ['x'])).toBe(false);
  });
});
