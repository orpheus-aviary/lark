import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT,
  SORT_FIELDS,
  isValidSort,
  sortSongs,
  toggleOrder,
  withField,
} from './song-sort.js';
import type { SongData } from './types.js';

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

describe('the two sort axes', () => {
  it('offers five fields, default first', () => {
    expect(SORT_FIELDS).toEqual(['default', 'name', 'artist', 'duration', 'created_at']);
  });

  it('flips the direction of the current field', () => {
    expect(toggleOrder({ field: 'name', order: 'asc' })).toEqual({ field: 'name', order: 'desc' });
    expect(toggleOrder({ field: 'name', order: 'desc' })).toEqual({ field: 'name', order: 'asc' });
  });

  it('leaves `default` alone — the daemon order has no direction', () => {
    expect(toggleOrder(DEFAULT_SORT)).toEqual(DEFAULT_SORT);
    expect(toggleOrder({ field: 'default', order: 'desc' })).toEqual(DEFAULT_SORT);
  });

  it('keeps the direction when the field changes, and starts ascending from default', () => {
    expect(withField({ field: 'name', order: 'desc' }, 'duration')).toEqual({
      field: 'duration',
      order: 'desc',
    });
    expect(withField(DEFAULT_SORT, 'created_at')).toEqual({ field: 'created_at', order: 'asc' });
    expect(withField({ field: 'name', order: 'desc' }, 'default')).toEqual(DEFAULT_SORT);
  });

  it('refuses a stored sort naming a field this build does not have', () => {
    expect(isValidSort({ field: 'name', order: 'asc' })).toBe(true);
    expect(isValidSort({ field: 'nonsense', order: 'asc' })).toBe(false);
    expect(isValidSort({ field: 'name', order: 'sideways' })).toBe(false);
    expect(isValidSort(null)).toBe(false);
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

  it('orders by duration numerically', () => {
    const songs = [song({ id: 'long', duration: 245.5 }), song({ id: 'short', duration: 61 })];
    expect(sortSongs(songs, { field: 'duration', order: 'asc' }).map((s) => s.id)).toEqual([
      'short',
      'long',
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
