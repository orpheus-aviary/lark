import type { SongData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT, SORT_CYCLE, type SortState, nextSort, sortSongs } from './song-sort.js';

function song(partial: Partial<SongData> & { id: string }): SongData {
  return {
    name: '',
    artist: '',
    source_url: null,
    source_provider: null,
    source_key: null,
    file_origin: 'imported',
    lyrics_offset: 0,
    duration: 0,
    pinned: false,
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

describe('sort cycle', () => {
  it('walks the seven Go states and returns to default', () => {
    let sort = DEFAULT_SORT;
    const seen: string[] = [];
    for (let i = 0; i < SORT_CYCLE.length; i++) {
      seen.push(`${sort.field}-${sort.order}`);
      sort = nextSort(sort);
    }
    expect(seen).toEqual([
      'default-asc',
      'name-asc',
      'name-desc',
      'artist-asc',
      'artist-desc',
      'created_at-asc',
      'created_at-desc',
    ]);
    expect(sort).toEqual(DEFAULT_SORT);
  });

  it('treats default as directionless — a stored default/desc still steps to name', () => {
    expect(nextSort({ field: 'default', order: 'desc' })).toEqual({ field: 'name', order: 'asc' });
  });

  it('restarts at default for a state outside the cycle', () => {
    expect(nextSort({ field: 'nonsense', order: 'asc' } as unknown as SortState)).toEqual(
      DEFAULT_SORT,
    );
  });
});

describe('sortSongs', () => {
  it('leaves the daemon order untouched for `default`', () => {
    const songs = [song({ id: 'b', name: '乙' }), song({ id: 'a', name: '甲' })];
    expect(sortSongs(songs, DEFAULT_SORT)).toBe(songs);
  });

  it('orders Chinese names by pinyin, not code point', () => {
    // Code-point order would be 张 (5F20) < 王 (738B) < 陈 (9648).
    const songs = [
      song({ id: '1', name: '陈' }),
      song({ id: '2', name: '张' }),
      song({ id: '3', name: '王' }),
    ];
    const names = sortSongs(songs, { field: 'name', order: 'asc' }).map((s) => s.name);
    expect(names).toEqual(['陈', '王', '张']);
  });

  it('reverses on desc', () => {
    const songs = [song({ id: '1', artist: 'b' }), song({ id: '2', artist: 'a' })];
    expect(sortSongs(songs, { field: 'artist', order: 'desc' }).map((s) => s.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('compares created_at numerically (D5)', () => {
    // As strings, '10000' sorts before '9000' — the Go version's bug.
    const songs = [song({ id: 'new', created_at: 10000 }), song({ id: 'old', created_at: 9000 })];
    expect(sortSongs(songs, { field: 'created_at', order: 'asc' }).map((s) => s.id)).toEqual([
      'old',
      'new',
    ]);
  });

  it('keeps equal keys in the daemon order (stable)', () => {
    const songs = [
      song({ id: 'first', name: '同' }),
      song({ id: 'second', name: '同' }),
      song({ id: 'third', name: '同' }),
    ];
    expect(sortSongs(songs, { field: 'name', order: 'asc' }).map((s) => s.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
