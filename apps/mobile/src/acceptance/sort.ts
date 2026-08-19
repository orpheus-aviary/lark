// Does this phone actually collate Chinese? (N2f, decision n)
//
// `song-sort.ts` moved into `@lark/shared` so the phone shows the same order
// as the desktop, and the whole reason that file exists is its comment:
// "SQLite has no Chinese collation, so `名` vs `曲` would come back in
// code-point order". The fix is `Intl.Collator('zh-CN')` — which on the
// desktop is Node's full ICU and on Android is whatever Hermes was built
// against.
//
// A Hermes with no ICU does not throw. It falls back, and the fallback IS
// code-point order — the exact thing the collator was introduced to stop. So
// the case asserts both halves: the order is the pinyin one, AND it is not the
// code-point one. Only the second half can tell a working collator from a
// convincing imposter.

import { type SongData, type SortState, sortSongs } from '@lark/shared';
import type { ScenarioRow } from './d16';

/**
 * Four names whose pinyin order and code-point order disagree.
 *
 *   code points  半 U+534A < 安 U+5B89 < 稻 U+7A3B < 龙 U+9F99
 *   pinyin       安 a      < 半 b      < 稻 d      < 龙 l
 *
 * The first two swap, which is what makes this a discriminator rather than a
 * list that happens to be sorted either way.
 */
const NAMES = ['稻香', '安静', '半岛铁盒', '龙卷风'];
const BY_PINYIN = ['安静', '半岛铁盒', '稻香', '龙卷风'];
const BY_CODE_POINT = ['半岛铁盒', '安静', '稻香', '龙卷风'];

function song(name: string, index: number): SongData {
  return {
    id: `0000000${index}-0000-4000-8000-000000000000`,
    name,
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
    has_file: false,
    file_size: 0,
  };
}

const ASC: SortState = { field: 'name', order: 'asc' };

export async function runSortScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  const ordered = sortSongs(NAMES.map(song), ASC).map((s) => s.name);

  rows.push({
    name: 'n · names sort by pinyin, not by code point',
    ok: ordered.join(',') === BY_PINYIN.join(','),
    detail: ordered.join(' · '),
  });
  rows.push({
    name: 'n · and the collator is not falling back',
    // Same list, stated the other way round: if Hermes shipped without ICU
    // this is what `sortSongs` would have produced, and the case above would
    // be the only thing between that and a library sorted wrong on a phone.
    ok: ordered.join(',') !== BY_CODE_POINT.join(','),
    detail: `code-point order would have been ${BY_CODE_POINT.join(' · ')}`,
  });
  rows.push({
    name: 'n · descending is the same order, reversed',
    ok:
      sortSongs(NAMES.map(song), { field: 'name', order: 'desc' })
        .map((s) => s.name)
        .join(',') === [...BY_PINYIN].reverse().join(','),
    detail: 'desc mirrors asc',
  });
  return rows;
}
