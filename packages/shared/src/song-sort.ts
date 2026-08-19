// Client-side list ordering (D5). Sorting stays in the client even though the
// daemon accepts `?sort=`: SQLite has no Chinese collation, so `名` vs `曲`
// would come back in code-point order. An `Intl.Collator('zh-CN')` is the only
// thing that puts a Chinese library in the order a user expects.
//
// The Go version's seven-state click cycle is gone (M5 follow-up). Five fields
// would have made it nine states — nine clicks to get back to `default` — so
// the two axes are split: the dropdown picks the FIELD, the button flips the
// DIRECTION. `duration` is client-only; the daemon's sort domain
// (`SONG_SORT_FIELDS`) does not include it and does not need to.
//
// HERE RATHER THAN IN THE RENDERER (N2f, decision n). Every line of this file
// is pure, and the phone needs the same order the desktop shows — a library
// that sorts one way on a laptop and another way in a pocket is two libraries.
// What did NOT come along is `stores/view-prefs.ts`: it depends on zustand and
// localStorage, so each front end keeps its own persistence adapter over these
// same values.

import type { SongData, SongSortField, SortOrder } from './types.js';

/** `default` = whatever order the daemon returned (rank / creation order). */
export type SortField = 'default' | SongSortField | 'duration';

export interface SortState {
  field: SortField;
  order: SortOrder;
}

export const DEFAULT_SORT: SortState = { field: 'default', order: 'asc' };

/** Every field the picker offers, in the order it shows them. */
export const SORT_FIELDS: readonly SortField[] = [
  'default',
  'name',
  'artist',
  'duration',
  'created_at',
];

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  default: '默认',
  name: '歌名',
  artist: '歌手',
  duration: '时长',
  created_at: '创建时间',
};

/** Fields compared as numbers rather than collated as text. */
const NUMERIC_FIELDS: ReadonlySet<SortField> = new Set(['duration', 'created_at']);

export function isNumericField(field: SortField): boolean {
  return NUMERIC_FIELDS.has(field);
}

export function sortLabel(sort: SortState): string {
  const field = SORT_FIELD_LABELS[sort.field];
  if (sort.field === 'default') return field;
  return `${field} ${sort.order === 'asc' ? '↑' : '↓'}`;
}

/** Flip the direction. `default` has no direction, so it is left alone. */
export function toggleOrder(sort: SortState): SortState {
  if (sort.field === 'default') return DEFAULT_SORT;
  return { field: sort.field, order: sort.order === 'asc' ? 'desc' : 'asc' };
}

/** Switch fields, keeping the direction the user already chose. */
export function withField(sort: SortState, field: SortField): SortState {
  if (field === 'default') return DEFAULT_SORT;
  return { field, order: sort.field === 'default' ? 'asc' : sort.order };
}

export function isValidSort(value: unknown): value is SortState {
  if (typeof value !== 'object' || value === null) return false;
  const { field, order } = value as { field?: unknown; order?: unknown };
  return SORT_FIELDS.includes(field as SortField) && (order === 'asc' || order === 'desc');
}

const collator = new Intl.Collator('zh-CN');

/**
 * Numeric fields compare NUMERICALLY (D5): the wire types are unix
 * milliseconds and seconds, and the Go version's string comparison of ISO
 * timestamps only happened to work because they were fixed-width.
 */
function comparator(field: Exclude<SortField, 'default'>): (a: SongData, b: SongData) => number {
  switch (field) {
    case 'duration':
      return (a, b) => a.duration - b.duration;
    case 'created_at':
      return (a, b) => a.created_at - b.created_at;
    default:
      return (a, b) => collator.compare(a[field], b[field]);
  }
}

/**
 * Order a list for display. Returns the input untouched for `default`;
 * `Array.prototype.sort` is stable, so equal keys keep the daemon's order.
 */
export function sortSongs(songs: readonly SongData[], sort: SortState): readonly SongData[] {
  const { field, order } = sort;
  if (field === 'default') return songs;
  const direction = order === 'asc' ? 1 : -1;
  const compare = comparator(field);
  return [...songs].sort((a, b) => compare(a, b) * direction);
}
