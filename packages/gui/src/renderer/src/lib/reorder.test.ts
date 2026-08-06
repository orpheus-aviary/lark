// The half of drag-and-drop that jsdom CAN judge (plan §8.4): given a drop,
// which two members does the song end up between?

import { describe, expect, it } from 'vitest';
import { planReorder } from './reorder.js';

const LIST = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);

describe('planReorder', () => {
  it('moves a song down and anchors it between its new neighbours', () => {
    const plan = planReorder(LIST, 'a', 'c');

    expect(plan).not.toBeNull();
    expect(ids(plan?.next ?? [])).toEqual(['b', 'c', 'a', 'd']);
    expect(plan?.anchors).toEqual({
      song_id: 'a',
      after_song_id: 'c',
      before_song_id: 'd',
    });
  });

  it('moves a song up', () => {
    const plan = planReorder(LIST, 'd', 'b');

    expect(ids(plan?.next ?? [])).toEqual(['a', 'd', 'b', 'c']);
    expect(plan?.anchors).toEqual({
      song_id: 'd',
      after_song_id: 'a',
      before_song_id: 'b',
    });
  });

  it('sends only `before` at the head and only `after` at the tail', () => {
    expect(planReorder(LIST, 'c', 'a')?.anchors).toEqual({
      song_id: 'c',
      before_song_id: 'a',
    });
    expect(planReorder(LIST, 'a', 'd')?.anchors).toEqual({
      song_id: 'a',
      after_song_id: 'd',
    });
  });

  it('handles a two-item list, where every move is an edge', () => {
    const pair = [{ id: 'a' }, { id: 'b' }];
    expect(planReorder(pair, 'b', 'a')?.anchors).toEqual({ song_id: 'b', before_song_id: 'a' });
    expect(planReorder(pair, 'a', 'b')?.anchors).toEqual({ song_id: 'a', after_song_id: 'b' });
  });

  it('plans nothing for a no-op or an unknown id', () => {
    expect(planReorder(LIST, 'a', 'a')).toBeNull();
    expect(planReorder(LIST, 'a', 'zzz')).toBeNull();
    expect(planReorder(LIST, 'zzz', 'a')).toBeNull();
    expect(planReorder([], 'a', 'b')).toBeNull();
  });

  it('leaves the input untouched', () => {
    const input = [...LIST];
    planReorder(input, 'a', 'c');
    expect(ids(input)).toEqual(['a', 'b', 'c', 'd']);
  });
});
