// Client-side list ordering (D5). Sorting stays in the renderer even though
// the daemon accepts `?sort=`: SQLite has no Chinese collation, so `名` vs
// `曲` would come back in code-point order. `localeCompare('zh-CN')` is the
// only thing that puts a Chinese library in the order a user expects.

import type { SongData, SongSortField, SortOrder } from '@lark/shared';

/** `default` = whatever order the daemon returned (rank / creation order). */
export type SortField = 'default' | SongSortField;

export interface SortState {
  field: SortField;
  order: SortOrder;
}

export const DEFAULT_SORT: SortState = { field: 'default', order: 'asc' };

/**
 * The seven states the split button cycles through, Go order: default, then
 * each field ascending followed by descending.
 */
export const SORT_CYCLE: readonly SortState[] = [
  { field: 'default', order: 'asc' },
  { field: 'name', order: 'asc' },
  { field: 'name', order: 'desc' },
  { field: 'artist', order: 'asc' },
  { field: 'artist', order: 'desc' },
  { field: 'created_at', order: 'asc' },
  { field: 'created_at', order: 'desc' },
];

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  default: '默认',
  name: '歌名',
  artist: '歌手',
  created_at: '时间',
};

export function sortLabel(sort: SortState): string {
  const field = SORT_FIELD_LABELS[sort.field];
  if (sort.field === 'default') return field;
  return `${field} ${sort.order === 'asc' ? '↑' : '↓'}`;
}

/** Next state in the cycle; an unknown state restarts at `default`. */
export function nextSort(current: SortState): SortState {
  const index = SORT_CYCLE.findIndex(
    (s) => s.field === current.field && (s.field === 'default' || s.order === current.order),
  );
  return SORT_CYCLE[(index + 1) % SORT_CYCLE.length] ?? DEFAULT_SORT;
}

export function isSameSort(a: SortState, b: SortState): boolean {
  if (a.field !== b.field) return false;
  return a.field === 'default' || a.order === b.order;
}

const collator = new Intl.Collator('zh-CN');

/**
 * Order a list for display. `created_at` compares NUMERICALLY (D5): the wire
 * type is unix milliseconds, and the Go version's string comparison of ISO
 * timestamps only happened to work because they were fixed-width.
 *
 * Returns the input untouched for `default`; `Array.prototype.sort` is stable,
 * so equal keys keep the daemon's order.
 */
export function sortSongs(songs: readonly SongData[], sort: SortState): readonly SongData[] {
  const { field, order } = sort;
  if (field === 'default') return songs;
  const direction = order === 'asc' ? 1 : -1;
  const compare =
    field === 'created_at'
      ? (a: SongData, b: SongData) => a.created_at - b.created_at
      : (a: SongData, b: SongData) => collator.compare(a[field], b[field]);
  return [...songs].sort((a, b) => compare(a, b) * direction);
}
