// Which of a list's videos are going to be downloaded (N4f-1, §2.1).
//
// Pure functions over a `Set<string>` of bvids, and that is the whole design:
// §1.5 needs a 5000-row list to stay on the frame budget, and the way it does
// is by NOT putting a checkbox's state in the row. A `FlatList` recycles rows;
// a `useState` per row would be five thousand of them, re-created as the list
// scrolls, and "全选" would have to reach into components that are not
// mounted. One set at the top of the page answers every question here in O(1).
//
// KEYED BY A STRING THE SOURCE CHOOSES. For an expanded list that is the bvid,
// like the desktop's modal (`BatchSelectModal.tsx`): a folder holding the same
// video twice therefore has ONE row and counts once, which is also what the
// engine does with it (two identical items merge onto one task, `#mergeInto`),
// so a picker showing two rows would promise a download it cannot deliver.
// `pickable` is where that collapse happens, once, before anything is rendered.
//
// GENERIC SINCE N4h, because the picker grew a second source: a pasted block of
// lines, where the row is a line rather than a video and two of them can be the
// same link written differently. What every source owes the tick model is a
// stable key; what it means is the source's business — and since N4i-2 the
// tick model itself lives in `library/selection.ts`, because the songs tab
// ticks songs with it.

import { DOWNLOAD_BATCH_ITEMS_MAX, type FetchListData } from '@lark/shared';
import type { Pickable } from '../library/selection';

export type { Pickable };

/**
 * What the picker screen draws, whatever produced it (N4h).
 *
 * Two sources fill this in: an expanded favourites folder, where every row is
 * a video and none of them can be refused, and a pasted block of lines, where
 * a row may be a link nobody can follow. One contract rather than two renderers
 * — the screen should not have to know which door it came through.
 */
export interface PickRow extends Pickable {
  /** The row's own line: a song title, a bvid, a query, a URL. */
  label: string;
  /** What was pasted, when the label is something else. */
  note: string | null;
  /** Why it cannot be ticked. `null` means it can. */
  reason: string | null;
}

/** One row of an expanded list (N4f). */
export interface ListVideo extends PickRow {
  bvid: string;
  title: string;
  duration: number | null;
}

/** `fetchList` rows, keyed for the picker. The key IS the bvid (§1.5). */
export function listRows(videos: FetchListData['videos']): readonly ListVideo[] {
  // A list row is never refused: everything in a favourites folder is a video
  // with a bvid, and the walk already dropped what it could not read.
  return videos.map((video) => ({
    ...video,
    key: video.bvid,
    label: video.title,
    note: null,
    reason: null,
  }));
}

/**
 * The rows that can be ticked at all — what 全选 and the counter are about.
 *
 * A `PickRow` fact rather than a line fact, and it lives here because two
 * places wanted it: the paste's own tests and the screen. It was written twice
 * for about an hour (N4h-2), which is one hour longer than a predicate should
 * exist in two copies.
 */
export const eligible = <T extends PickRow>(rows: readonly T[]): readonly T[] =>
  rows.filter((row) => row.reason === null);

/**
 * The rows a picker shows: list order, one per bvid.
 *
 * Everything below assumes its input came through here — `chosen.size` is the
 * count on the button precisely because the set and the rows agree on what
 * "one video" is.
 */
export function pickable<T extends Pickable>(rows: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/**
 * Why this many videos cannot be submitted at once, or `null` (decision d).
 *
 * The desktop's sentence, verbatim, because it is the same ceiling and a phone
 * that phrased it differently would be a second wording of one rule
 * (`BatchSelectModal.tsx:210-217`).
 *
 * TWO NUMBERS, NOT ONE: a single expansion may return up to
 * `FETCH_LIST_ITEMS_MAX` (5000) rows while a batch may submit at most 1000, so
 * a full folder can be picked and still be refused. Said BEFORE the submission
 * — the button carries this and is disabled — rather than after it, which is
 * the difference between a rule and a rejection.
 */
export function overItemLimit(count: number): string | null {
  if (count <= DOWNLOAD_BATCH_ITEMS_MAX) return null;
  return `一次最多 ${DOWNLOAD_BATCH_ITEMS_MAX} 个视频（当前 ${count}），请分批提交`;
}
